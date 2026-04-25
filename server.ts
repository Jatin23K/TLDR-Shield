// ── TLDR Shield Backend [Portfolio Architecture] ──
// DESIGN PHILOSOPHY:
// This server implements a high-availability, cost-optimized LLM pipeline.
// It uses a "Key Pool Lane" architecture to distribute load across 6 Gemini API keys,
// isolating background tasks (scanning, watcher) from real-time user requests.
//
// PIPELINE LAYERS:
// 1. DEMO LAYER: Instant resolution for 'Golden URLs' to showcase UX without API cost.
// 2. L1 CACHE (Redis): Sub-millisecond retrieval for hot documents.
// 3. L2 CACHE (Firestore): Global shared intelligence for all users.
// 4. MULTI-MODEL ENSEMBLE: Parallel JUDGE passes for deep scans (1.5 Pro + 1.5 Flash).

import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { readFileSync } from "fs";

// Modular Services
import { authMiddleware } from './server/middleware/auth.js';
import { checkAndDeductCredits, refundCredits, getUserCredits } from './server/services/creditService.js';
import { getSharedCache, setSharedCache, saveScanRecord, saveReport } from './server/services/databaseService.js';
import { callGemini, callGeminiEnsemble } from './server/services/llmService.js';
import { chunkText, extractJSON, findVerbatimInChunk } from './server/lib/textUtils.js';
import { getCache, setCache } from './server/lib/redis.js';

// Shared Logic
import { calculateScoreAndRating } from './shared/scoring.js';
import { buildSystemPrompt } from './server/prompts.js';
import { applyConsistencyCrossCheck, sanitizeCitations, updatePillarConfidence } from './server/postprocess.js';

// Demo Data
import demoResults from './shared/demo_results.json' with { type: 'json' };

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// --- Firebase Init (Simplified) ---
let firestoreDb: any = null;
(async () => {
    try {
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getFirestore } = await import('firebase-admin/firestore');
        const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (saJson) {
            initializeApp({ credential: cert(JSON.parse(saJson)) });
            firestoreDb = getFirestore();
            console.log('[TLDR Shield] Firestore Connected');
        }
    } catch (err) {
        console.warn('[TLDR Shield] Firestore disabled:', err);
    }
})();

// --- Routes ---

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('/api/credits', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    const credits = await getUserCredits(firestoreDb, uid);
    res.json({ credits });
});

app.post('/api/report', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    await saveReport(firestoreDb, uid, req.body);
    res.json({ success: true });
});

app.post('/api/analyze', authMiddleware, async (req, res) => {
    const { text, tier = 'quick', url } = req.body;
    const uid = (req as any).uid;

    if (!text || text.length < 100) {
        return res.status(400).json({ error: 'Text too short for analysis.' });
    }

    const urlHash = url ? crypto.createHash('sha256').update(url).digest('hex') : null;

    // 1. Demo Mode Check (Fix #5)
    if (url && (demoResults as any)[url]) {
        console.log(`[TLDR Shield] Demo Mode: ${url}`);
        return res.json({ ...(demoResults as any)[url], cached: true });
    }

    // 2. Persistent Cache Check (Fix #3)
    const redisKey = `cache:${urlHash || crypto.createHash('sha256').update(text.slice(0, 500)).digest('hex')}`;
    const redisCache = await getCache(redisKey);
    if (redisCache) {
        console.log('[TLDR Shield] L1 Redis Hit');
        return res.json({ ...redisCache, cached: true });
    }

    // 3. Shared Cache Check
    if (urlHash) {
        const l2Cache = await getSharedCache(firestoreDb, urlHash);
        if (l2Cache) {
            console.log('[TLDR Shield] L2 Firestore Hit');
            await setCache(redisKey, l2Cache, 3600); // Backfill Redis
            return res.json({ ...l2Cache, cached: true });
        }
    }

    // 4. Credit Check
    const cost = tier === 'deep' ? 20 : 10;
    const credit = await checkAndDeductCredits(firestoreDb, uid, cost, true);
    if (!credit.ok) return res.status(402).json(credit);

    // 5. HYBRID KEY POOL ARCHITECTURE
    // We maintain two logical lanes but pool them for 100% capacity failover.
    const scanLane: string[] = [];
    const utilLane: string[] = [];
    
    for (let i = 1; i <= 3; i++) {
        const sk = (process.env[`GEMINI_SCAN_KEY_${i}`] ?? '').trim();
        const uk = (process.env[`GEMINI_UTIL_KEY_${i}`] ?? '').trim();
        if (sk) scanLane.push(sk);
        if (uk) utilLane.push(uk);
    }

    // Build the prioritized pool for this request (Scans prioritize scanLane)
    const hybridPool = [...scanLane, ...utilLane];

    const paidKey = (process.env.GEMINI_PRO_KEY ?? '').trim();
    const isProMode = process.env.GEMINI_PRO_MODE === 'true';

    // Model selection — read from .env, never hardcoded
    const primaryModel = (process.env.GEMINI_MODEL_SCAN_PRIMARY || 'gemini-2.5-flash').trim();
    const fallbackModel = (process.env.GEMINI_MODEL_SCAN_FALLBACK || 'gemini-2.5-flash-8b').trim();
    const proModel = (process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro').trim();

    const chunks = chunkText(text, 12000, 2000, 8);
    let keyPool = hybridPool;
    const modelStack = [primaryModel, fallbackModel];

    if (tier === 'deep' && isProMode && paidKey) {
        modelStack[0] = proModel;
        keyPool = [paidKey];
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const sysPrompt = buildSystemPrompt(false, false, tier);

        // Execute all chunks in parallel with downshifting
        const results = await Promise.all(chunks.map(async (chunk, i) => {
            res.write(`data: ${JSON.stringify({ status: `Analyzing block ${i + 1}/${chunks.length}...` })}\n\n`);
            try {
                // Try Primary Model, then Fallback Model if Rate Limited
                // Ensemble Pass: Parallel analysis by two models (Primary + Corroborator)
                const corroborator = (tier === 'deep') ? (process.env.GEMINI_MODEL_SCAN_CORROBORATOR || 'gemini-1.5-flash') : null;
                const response = await callGeminiEnsemble(sysPrompt, chunk, 1024, 35000, modelStack[0], corroborator as string, keyPool);
                const parsed = extractJSON(response.content);
                // Pass 1: verbatim citation grounding — replace LLM paraphrases with exact source text
                if (parsed?.pillars) {
                    for (const key of Object.keys(parsed.pillars)) {
                        const p = parsed.pillars[key];
                        if (p?.violation && p?.citation) {
                            p.citation = findVerbatimInChunk(p.citation, chunk);
                        }
                    }
                }
                return parsed;
            } catch (err) {
                console.warn(`[TLDR Shield] Block ${i + 1} failed:`, err);
                return null;
            }
        }));

        // Robust Aggregation (Fix #2)
        const validResults = results.filter(r => r && r.pillars);
        if (validResults.length === 0) throw new Error('All analysis blocks failed.');

        const aggregatedPillars: any = {};
        validResults.forEach(r => {
            for (const key of Object.keys(r.pillars)) {
                const p = r.pillars[key];
                if (!aggregatedPillars[key] || (p.violation && !aggregatedPillars[key].violation)) {
                    aggregatedPillars[key] = p; // Prioritize violations found in any chunk
                }
            }
        });

        const crossCheckConfirmed = applyConsistencyCrossCheck(aggregatedPillars, text);
        updatePillarConfidence(aggregatedPillars, crossCheckConfirmed, text);

        const { score, rating, deductions } = calculateScoreAndRating(aggregatedPillars, tier, text.length);
        const requestId = crypto.randomUUID();
        const final = {
            score,
            rating,
            deductions,
            pillars: aggregatedPillars,
            tldr: validResults[0]?.tldr || 'Analysis complete.',
            requestId,
            tier
        };


        sanitizeCitations(final.pillars);

        // Save and Cache
        await Promise.all([
            setCache(redisKey, final, 3600 * 24),
            setSharedCache(firestoreDb, urlHash || '', final, tier),
            saveScanRecord(firestoreDb, uid, final, { url, tier, cached: false })
        ]);

        res.write(`data: ${JSON.stringify(final)}\n\n`);
        res.end();
    } catch (err: any) {
        console.error('[TLDR Shield] Pipeline Error:', err.message);
        await refundCredits(firestoreDb, uid, cost);
        res.write(`data: ${JSON.stringify({ error: 'Analysis failed. Credits refunded.' })}\n\n`);
        res.end();
    }
});

/**
 * UTILITY ROUTE: Summarization
 * Demonstrates Lane 2 prioritization (Utility Pool -> Scan Pool).
 */
app.post('/api/utility/summarize', authMiddleware, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required.' });

    // 1. Build Hybrid Pool with UTILITY Priority
    const scanLane: string[] = [];
    const utilLane: string[] = [];
    for (let i = 1; i <= 3; i++) {
        const sk = (process.env[`GEMINI_SCAN_KEY_${i}`] ?? '').trim();
        const uk = (process.env[`GEMINI_UTIL_KEY_${i}`] ?? '').trim();
        if (sk) scanLane.push(sk);
        if (uk) utilLane.push(uk);
    }
    // Utility Priority: utilLane FIRST, then scanLane
    const utilityHybridPool = [...utilLane, ...scanLane];

    try {
        const prompt = "Summarize this legal clause in 1 sentence for a layperson.";
        const model = process.env.GEMINI_MODEL_UTILITY || 'gemini-2.5-flash-lite';
        
        const response = await callGemini(prompt, text, 200, 15000, model, utilityHybridPool);
        res.json({ summary: response.content });
    } catch (err: any) {
        res.status(500).json({ error: 'Utility task failed.' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[TLDR Shield] Server listening on ${PORT}`));
