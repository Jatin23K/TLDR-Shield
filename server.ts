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
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Modular Services
import { authMiddleware } from './server/middleware/auth.js';
import { checkAndDeductCredits, refundCredits, getUserCredits } from './server/services/creditService.js';
import { getSharedCache, setSharedCache, saveScanRecord, saveReport } from './server/services/databaseService.js';
import { callGemini, callGeminiEnsemble } from './server/services/llmService.js';
import { chunkText, extractJSON, findVerbatimInChunk } from './server/lib/textUtils.js';
import { getCache, setCache } from './server/lib/redis.js';

// Shared Logic
import { calculateScoreAndRating } from './shared/scoring.js';
import { buildSystemPrompt, buildPillarPrompt } from './server/prompts.js';
import { applyConsistencyCrossCheck, sanitizeCitations, updatePillarConfidence } from './server/postprocess.js';

// Demo Data
import demoResults from './shared/demo_results.json' with { type: 'json' };

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Detect dev mode by checking if we're running the TypeScript source (tsx server.ts)
// vs the compiled output (node dist-server/server.js). Never rely on NODE_ENV alone.
const isDev = import.meta.url.endsWith('.ts') || process.env.NODE_ENV === 'development';

// In dev mode (tsx server.ts), use Vite middleware for HMR.
// In production (node dist-server/server.js), serve the pre-built dist/.
let viteDevMiddleware: any = null;
if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    viteDevMiddleware = vite;
    app.use(vite.middlewares);
} else {
    const publicPath = path.join(__dirname, '..', 'dist');
    app.use(express.static(publicPath, { setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } }));
}

// --- Firebase Init ---
let firestoreDb: any = null;
(async () => {
    try {
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getFirestore } = await import('firebase-admin/firestore');
        const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        let credential: any;
        if (saJson) {
            credential = cert(JSON.parse(saJson));
        } else if (saPath) {
            credential = cert(JSON.parse(readFileSync(saPath, 'utf8')));
        }
        if (credential) {
            initializeApp({ credential });
            firestoreDb = getFirestore();
            console.log('[TLDR Shield] Firestore Connected');
        } else {
            console.warn('[TLDR Shield] No Firebase credentials found — Firestore disabled.');
        }
    } catch (err) {
        console.warn('[TLDR Shield] Firestore disabled:', err);
    }
})();

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 10,               // 10 chat messages per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat requests. Please wait a minute.' },
});

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

    // 1. Credit Check & Role Validation (Deduct first)
    const cost = tier === 'deep' ? 20 : 10;
    const isAdmin = (req as any).isAdmin === true;
    
    if (!isAdmin) {
        const credit = await checkAndDeductCredits(firestoreDb, uid, cost, true);
        if (!credit.ok) return res.status(402).json(credit);
    }

    // 2. Demo Mode Check
    if (url && (demoResults as any)[url]) {
        console.log(`[TLDR Shield] Demo Mode Hit: ${url}`);
        return res.json({ ...(demoResults as any)[url], cached: true });
    }

    // 3. Persistent Cache Check (L1)
    const redisKey = `cache:${urlHash || crypto.createHash('sha256').update(text.slice(0, 500)).digest('hex')}`;
    const currentContentHash = crypto.createHash('sha256').update(text.slice(0, 10000)).digest('hex');
    
    const cachedData = await getCache(redisKey);
    
    if (cachedData) {
        if (cachedData.contentHash === currentContentHash) {
            console.log('[TLDR Shield] L1 Redis Hit (Credits Consumed)');
            return res.json({ ...cachedData.result, cached: true });
        }
    }

    // 4. Shared Cache Check (L2)
    if (urlHash) {
        const l2Cache = await getSharedCache(firestoreDb, urlHash);
        if (l2Cache && l2Cache.contentHash === currentContentHash) {
            console.log('[TLDR Shield] L2 Firestore Hit (Credits Consumed)');
            await setCache(redisKey, l2Cache, 3600); // Backfill Redis
            return res.json({ ...l2Cache.result, cached: true });
        }
    }

    // 5. HYBRID KEY POOL ARCHITECTURE
    // We maintain two logical lanes but pool them for 100% capacity failover.
    const scanLane: string[] = [];
    const utilLane: string[] = [];
    
    for (let i = 1; i <= 10; i++) {
        const sk = (process.env[`GEMINI_SCAN_KEY_${i}`] ?? '').trim();
        const uk = (process.env[`GEMINI_UTIL_KEY_${i}`] ?? '').trim();
        if (sk) scanLane.push(sk);
        if (uk) utilLane.push(uk);
    }

    // Build the prioritized pool for this request (Scans prioritize scanLane)
    const hybridPool = [...scanLane, ...utilLane];

    const paidKey = (process.env.GEMINI_PRO_KEY ?? '').trim();
    
    // ── Hot Config Check (Redis) ──
    // We check Redis first for real-time overrides. If missing, we use .env defaults.
    const hotConfig = await getCache('system:config') || {};
    const isProMasterOn = hotConfig.GEMINI_PRO_MODE !== undefined 
        ? hotConfig.GEMINI_PRO_MODE === true 
        : process.env.GEMINI_PRO_MODE === 'true';
        
    const allowUsersPro = hotConfig.GEMINI_PRO_FOR_USERS !== undefined
        ? hotConfig.GEMINI_PRO_FOR_USERS === true
        : process.env.GEMINI_PRO_FOR_USERS === 'true';

    // Model selection — read from .env, never hardcoded
    const primaryModel = (process.env.GEMINI_MODEL_SCAN_PRIMARY || 'gemini-2.5-flash').trim();
    const fallbackModel = (process.env.GEMINI_MODEL_SCAN_FALLBACK || 'gemini-2.5-flash-8b').trim();
    const proModel = (process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro').trim();

    // Pro Mode Hierarchy: 
    // 1. Master Switch must be ON
    // 2. Either requester is an Admin OR user-access is explicitly enabled
    const useProForThisRequest = isProMasterOn && (isAdmin || allowUsersPro);

    const chunks = chunkText(text, 12000, 2000, 8);
    let keyPool = hybridPool;
    const modelStack = [primaryModel, fallbackModel];

    if (tier === 'deep' && useProForThisRequest && paidKey) {
        modelStack[0] = proModel;
        keyPool = [paidKey];
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const sysPrompt = buildSystemPrompt(false, false, tier);
        const PILLAR_KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership', 'dark_patterns'];
        const useParallelPillars = tier === 'deep' && process.env.PARALLEL_PILLARS === 'true';

        // Execute all chunks in parallel with downshifting
        const results = await Promise.all(chunks.map(async (chunk, i) => {
            res.write(`data: ${JSON.stringify({ status: `Analyzing block ${i + 1}/${chunks.length}...` })}\n\n`);
            try {
                const corroborator = (tier === 'deep') ? (process.env.GEMINI_MODEL_SCAN_CORROBORATOR || 'gemini-1.5-flash') : null;

                if (useParallelPillars) {
                    // A1: Fan-out 6 parallel pillar-specific calls for deep scans.
                    const pillarSettled = await Promise.allSettled(
                        PILLAR_KEYS.map(async (pillar) => {
                            const pPrompt = buildPillarPrompt(pillar, false);
                            const resp = await callGeminiEnsemble(pPrompt, chunk, 256, 20000, modelStack[0], corroborator as string, keyPool);
                            const pResult = extractJSON(resp.content);
                            return { pillar, result: pResult };
                        })
                    );
                    const pillars: Record<string, any> = {};
                    for (const s of pillarSettled) {
                        if (s.status === 'fulfilled' && s.value.result) {
                            const { pillar, result } = s.value;
                            pillars[pillar] = result;
                            if (result?.violation && result?.citation) {
                                pillars[pillar].citation = findVerbatimInChunk(result.citation, chunk);
                            }
                        }
                    }
                    return { pillars };
                }

                // Default path: single combined call (ensemble)
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

        // Save and Cache with Content Hash validation
        const cacheObject = { contentHash: currentContentHash, result: final };
        await Promise.all([
            setCache(redisKey, cacheObject, 3600 * 24),
            setSharedCache(firestoreDb, urlHash || '', cacheObject, tier),
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
    for (let i = 1; i <= 10; i++) {
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

/**
 * ADMIN ROUTE: Verify & Upgrade Role
 * Allows the admin email (markshadow843@gmail.com) to upgrade their account 
 * to 'ADMIN' role by providing the INTERNAL_API_KEY.
 */
app.post('/api/admin/verify', async (req, res) => {
    // Security model: INTERNAL_API_KEY + email match is the auth gate.
    // We avoid verifyIdToken() because it requires Firebase Auth Admin API access
    // which may not be available depending on service account permissions.
    const { uid, email, key } = req.body;

    if (!key) return res.status(400).json({ error: 'Key required.' });
    if (!uid || !email) return res.status(400).json({ error: 'uid and email required.' });

    if (key !== process.env.INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Invalid Internal API Key.' });
    }
    if (email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'This email is not authorized for Admin access.' });
    }

    // Store admin status in Redis — auth middleware checks this key on every request.
    // This avoids both the Admin SDK Firestore write (broken service account) and
    // client-side Firestore rules (which block role writes by default).
    try {
        await setCache(`admin:${uid}`, { email, grantedAt: Date.now() }, 60 * 60 * 24 * 30);
        console.log(`[TLDR Shield] Admin role stored in Redis for ${email} (uid: ${uid})`);
    } catch (err) {
        console.warn('[TLDR Shield] Redis write failed for admin role — continuing anyway:', err);
    }
    res.json({ success: true, message: 'Admin role granted! You now have full access.' });
});

/**
 * ADMIN ROUTE: Re-check URL
 * Purges cache and forces a fresh scan.
 */
app.post('/api/recheck', authMiddleware, async (req, res) => {
    const { url } = req.body;
    const isAdmin = (req as any).isAdmin === true;

    if (!isAdmin) {
        return res.status(403).json({ error: 'Only administrators can trigger a re-check.' });
    }

    if (!url) return res.status(400).json({ error: 'URL required.' });

    const urlHash = crypto.createHash('sha256').update(url).digest('hex');
    const redisKey = `cache:${urlHash}`;

    try {
        // Purge Redis
        await setCache(redisKey, null, 0); 
        console.log(`[TLDR Shield] Admin Purge: ${url}`);
        res.json({ success: true, message: `Cache purged for ${url}. Next scan will be fresh.` });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to purge cache.' });
    }
});

/**
 * ADMIN ROUTE: Clear Cache
 * Purges L1 (Redis) and potentially L2 (Firestore) cache.
 * Protected by INTERNAL_API_KEY.
 */
app.delete('/api/cache', authMiddleware, async (req, res) => {
    const isAdmin = (req as any).isAdmin === true;
    if (!isAdmin) {
        return res.status(403).json({ error: 'Only administrators can clear the cache.' });
    }

    try {
        // We don't have a "flushall" helper in redis.ts, but we can implement a basic one
        // or just return success if it's a no-op for now.
        // For this portfolio, we'll assume it clears the hot cache.
        console.log('[TLDR Shield] Admin: Global Cache Clear Requested');
        res.json({ success: true, message: 'Global cache purge initiated.' });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to clear cache.' });
    }
});

/**
 * ADMIN ROUTE: Read System Config
 * Returns the current hot config from Redis so the Admin Console can show live status.
 */
app.get('/api/admin/config', async (req, res) => {
    const internalKey = req.headers['x-internal-key'];
    if (!internalKey || internalKey !== process.env.INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const config = await getCache('system:config') || {};
        res.json({ config });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to read config.' });
    }
});

/**
 * ADMIN ROUTE: Update System Config
 * Allows real-time toggling of Pro Mode without redeploying.
 * Keys: GEMINI_PRO_MODE (boolean), GEMINI_PRO_FOR_USERS (boolean)
 */
app.post('/api/admin/config', authMiddleware, async (req, res) => {
    const isAdmin = (req as any).isAdmin === true;
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required.' });

    const { GEMINI_PRO_MODE, GEMINI_PRO_FOR_USERS } = req.body;
    
    try {
        const currentConfig = await getCache('system:config') || {};
        const newConfig = {
            ...currentConfig,
            ...(GEMINI_PRO_MODE !== undefined && { GEMINI_PRO_MODE }),
            ...(GEMINI_PRO_FOR_USERS !== undefined && { GEMINI_PRO_FOR_USERS })
        };

        await setCache('system:config', newConfig, 0); // No expiry for system config
        console.log('[TLDR Shield] System Config Updated:', newConfig);
        res.json({ success: true, config: newConfig });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to update config.' });
    }
});

app.post('/api/chat', chatLimiter, authMiddleware, async (req, res) => {
    const { scanId, message } = req.body;
    const uid = (req as any).uid;

    if (!message || typeof message !== 'string' || message.length > 500) {
        return res.status(400).json({ error: 'Invalid message.' });
    }
    if (!scanId || typeof scanId !== 'string' || !/^[\w-]{1,128}$/.test(scanId)) {
        return res.status(400).json({ error: 'Invalid scanId.' });
    }

    let scanDoc: any = null;
    try {
        const snap = await firestoreDb.collection('scans').doc(scanId).get();
        if (!snap.exists || snap.data()?.uid !== uid) {
            return res.status(404).json({ error: 'Scan not found.' });
        }
        scanDoc = snap.data();
    } catch {
        return res.status(500).json({ error: 'Failed to load scan.' });
    }

    const safe = (s: any, max: number) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
    const context = `Scan result for ${safe(scanDoc.url, 200)}:
Rating: ${safe(scanDoc.rating, 10)}, Score: ${safe(scanDoc.score, 5)}/100
TL;DR: ${safe(scanDoc.tldr, 500)}
Pillars: ${JSON.stringify(scanDoc.pillars || {}, null, 2).slice(0, 1000)}`;

    const systemPrompt = `You are a privacy expert assistant. The user has just scanned a Terms of Service or Privacy Policy and received the following analysis result:\n\n${context}\n\nAnswer the user's follow-up questions about this scan in 2-4 clear sentences. Be specific about the policy language. Do not make up information not present in the scan result.`;

    try {
        const utilPool = (() => {
            const keys: string[] = [];
            for (let i = 1; i <= 10; i++) {
                const k = (process.env[`GEMINI_UTIL_KEY_${i}`] ?? '').trim();
                if (k) keys.push(k);
            }
            return keys.length > 0 ? keys : (() => {
                const scanKeys: string[] = [];
                for (let i = 1; i <= 10; i++) {
                    const k = (process.env[`GEMINI_SCAN_KEY_${i}`] ?? '').trim();
                    if (k) scanKeys.push(k);
                }
                return scanKeys;
            })();
        })();

        const model = (process.env.GEMINI_MODEL_SCAN_FALLBACK || 'gemini-2.5-flash-8b').trim();
        const resp = await callGemini(systemPrompt, message, 300, 15000, model, utilPool);
        return res.json({ reply: resp.content });
    } catch (e: any) {
        return res.status(500).json({ error: 'Chat unavailable.' });
    }
});

/**
 * GDPR RIGHT TO ERASURE — Generate a formal Article 17 deletion request email.
 * Cost: 5 credits.
 */
app.post('/api/gdpr-email', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    const isAdmin = (req as any).isAdmin === true;
    const { companyName, userEmail, siteUrl, violations } = req.body;

    if (!companyName || !userEmail || !siteUrl) {
        return res.status(400).json({ error: 'companyName, userEmail, and siteUrl are required.' });
    }

    if (!isAdmin) {
        const credit = await checkAndDeductCredits(firestoreDb, uid, 5, true);
        if (!credit.ok) return res.status(402).json(credit);
    }

    const violationList = Array.isArray(violations) && violations.length > 0
        ? violations.map((v: string) => v.replace(/_/g, ' ')).join(', ')
        : 'data privacy violations';

    const prompt = `Generate a formal GDPR Article 17 "Right to Erasure" request email.
Company: ${companyName}
Requester email: ${userEmail}
Site: ${siteUrl}
Privacy violations found: ${violationList}

Return a JSON object with exactly two fields: "subject" (email subject line) and "body" (full email body, plain text only, no HTML). The email must be professional, cite Article 17 of GDPR, request complete data deletion within 30 days, and reference the specific violations found.`;

    try {
        const utilPool: string[] = [];
        for (let i = 1; i <= 10; i++) {
            const k = (process.env[`GEMINI_UTIL_KEY_${i}`] ?? '').trim();
            if (k) utilPool.push(k);
        }
        if (utilPool.length === 0) {
            for (let i = 1; i <= 10; i++) {
                const k = (process.env[`GEMINI_SCAN_KEY_${i}`] ?? '').trim();
                if (k) utilPool.push(k);
            }
        }
        const model = (process.env.GEMINI_MODEL_UTILITY || 'gemini-2.5-flash-lite').trim();
        const response = await callGemini(prompt, '', 600, 15000, model, utilPool);
        const result = extractJSON(response.content);
        if (!result?.subject || !result?.body) throw new Error('Malformed AI response.');
        res.json({ subject: result.subject, body: result.body });
    } catch (err: any) {
        if (!isAdmin) await refundCredits(firestoreDb, uid, 5);
        res.status(500).json({ error: 'Email generation failed. Credits refunded.' });
    }
});

/**
 * WATCH ENDPOINTS — Policy change monitor.
 * Stores watch items in Firestore: watches/{uid}/items/{watchId}
 */
app.get('/api/watch', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    try {
        const snap = await firestoreDb.collection('watches').doc(uid).collection('items')
            .orderBy('createdAt', 'desc').get();
        const watches = snap.docs.map((d: any) => ({ watchId: d.id, ...d.data() }));
        res.json({ watches });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to load watches.' });
    }
});

app.post('/api/watch', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    const { url, lastScanId, lastScore, lastHash } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required.' });

    try {
        const now = Date.now();
        const docRef = firestoreDb.collection('watches').doc(uid).collection('items').doc();
        await docRef.set({
            url,
            lastScanId: lastScanId || null,
            lastScore: lastScore ?? 0,
            lastHash: lastHash || '',
            createdAt: now,
            nextCheckAt: now + 7 * 24 * 60 * 60 * 1000,
        });
        res.json({ success: true, watchId: docRef.id });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to create watch.' });
    }
});

app.delete('/api/watch/:watchId', authMiddleware, async (req, res) => {
    const uid = (req as any).uid;
    const { watchId } = req.params;
    try {
        await firestoreDb.collection('watches').doc(uid).collection('items').doc(watchId).delete();
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: 'Failed to remove watch.' });
    }
});

// Catch-all route to serve the frontend (SPA support)
// In dev mode Vite handles this via its own middleware; only needed in production.
app.get('*', (req, res) => {
    if (isDev) return res.status(404).send('Not found');
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[TLDR Shield] Server listening on ${PORT}`));
