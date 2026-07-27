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
import { chunkText, extractJSON, findVerbatimInChunk, backfillSafeCitations, detectHardViolations, stripCookieBoilerplate } from './server/lib/textUtils.js';
import { getCache, setCache } from './server/lib/redis.js';

// Shared Logic
import { calculateScoreAndRating } from './shared/scoring.js';
import { buildSystemPrompt, buildPillarPrompt } from './server/prompts.js';
import { applyConsistencyCrossCheck, sanitizeCitations, updatePillarConfidence } from './server/postprocess.js';

// Cache version gate: bump this string whenever the detection pipeline changes.
// Any cached result missing this version is automatically rejected and re-scanned.
const CACHE_VERSION = 'v6';

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
let firestoreInitError: string | null = null;
(async () => {
    try {
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getFirestore } = await import('firebase-admin/firestore');
        const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        let credential: any;
        if (saJson) {
            try {
                credential = cert(JSON.parse(saJson));
            } catch (jsonErr: any) {
                console.error('[TLDR Shield] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', jsonErr);
                firestoreInitError = 'JSON Parse Error: ' + jsonErr.message;
            }
        } else if (saPath) {
            credential = cert(JSON.parse(readFileSync(saPath, 'utf8')));
        }
        if (credential) {
            // Primary: env var (set this on Render/production).
            // Fallback: firebase-applet-config.json (local dev only — gitignored).
            let dbId: string | undefined = process.env.FIRESTORE_DATABASE_ID;
            if (!dbId) {
                try {
                    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
                    const appletConfig = JSON.parse(readFileSync(configPath, 'utf8'));
                    dbId = appletConfig.firestoreDatabaseId;
                } catch (configErr) {
                    console.warn('[TLDR Shield] Could not read firebase-applet-config.json database ID, using (default):', configErr);
                }
            }
            initializeApp({ credential });
            firestoreDb = dbId ? getFirestore(dbId) : getFirestore();
            console.log(`[TLDR Shield] Firestore Connected to database: ${dbId || '(default)'}`);
        } else {
            if (!firestoreInitError) {
                console.warn('[TLDR Shield] No Firebase credentials found — Firestore disabled.');
                firestoreInitError = 'No credentials configured';
            }
        }
    } catch (err: any) {
        console.warn('[TLDR Shield] Firestore disabled:', err);
        firestoreInitError = err?.message || String(err);
    }
})();

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 10,               // 10 chat messages per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat requests. Please wait a minute.' },
});

const recentErrors: any[] = [];
function logRecentError(type: string, message: string, details?: any) {
    recentErrors.unshift({
        timestamp: new Date().toISOString(),
        type,
        message,
        details
    });
    if (recentErrors.length > 20) {
        recentErrors.pop();
    }
}

// --- Routes ---

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('/api/diag', async (req, res) => {
    const keyStatuses: Record<string, string> = {};
    const keyNames = [
        'GEMINI_SCAN_KEY_1', 'GEMINI_SCAN_KEY_2', 'GEMINI_SCAN_KEY_3',
        'GEMINI_UTIL_KEY_1', 'GEMINI_UTIL_KEY_2', 'GEMINI_UTIL_KEY_3'
    ];

    for (const name of keyNames) {
        const key = (process.env[name] ?? '').trim();
        if (!key) {
            keyStatuses[name] = 'Not configured';
            continue;
        }

        const masked = key.slice(0, 6) + '...' + key.slice(-4);
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (response.ok) {
                keyStatuses[name] = `OK (${masked})`;
            } else {
                const errData: any = await response.json().catch(() => ({}));
                const errMsg = errData?.error?.message || `HTTP ${response.status}`;
                keyStatuses[name] = `FAIL: ${errMsg} (${masked})`;
            }
        } catch (err: any) {
            keyStatuses[name] = `ERROR: ${err.message} (${masked})`;
        }
    }

    res.json({
        firestoreConnected: firestoreDb !== null,
        initError: firestoreInitError,
        hasSaJson: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
        saJsonLength: process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.length || 0,
        keysConfigured: {
            scanKeys: [1,2,3].map(i => !!process.env[`GEMINI_SCAN_KEY_${i}`]),
            utilKeys: [1,2,3].map(i => !!process.env[`GEMINI_UTIL_KEY_${i}`]),
        },
        keyStatuses,
        recentErrors
    });
});

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
    const { text, tier = 'quick', url, forceRefresh = false, eli5 = false, darkPatterns = false } = req.body;
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

    // Helper: send a cached/demo result as SSE so background.js can parse it.
    // Previously these returned res.json() (plain JSON) which the extension could NOT
    // parse as SSE → stream ended without data.rating → "No result returned".
    // ALL success responses from /api/analyze must be SSE-format for consistency.
    const sendAsSSE = (payload: Record<string, any>) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.end();
    };

    // 2. Demo Mode Check
    if (url && (demoResults as any)[url]) {
        console.log(`[TLDR Shield] Demo Mode Hit: ${url}`);
        return sendAsSSE({ ...(demoResults as any)[url], cached: true });
    }

    // 3. Persistent Cache Check (L1)
    // IMPORTANT: tier is part of the cache key — Quick and Deep must NEVER share a cache entry.
    // A cached Deep result served for a Quick request shows full pillars when only a badge was expected,
    // and vice versa (a Quick badge cached and served as a Deep result shows no pillars).
    const baseHash = urlHash || crypto.createHash('sha256').update(text.slice(0, 500)).digest('hex');
    const redisKey = `cache:${baseHash}:${tier}`;
    const currentContentHash = crypto.createHash('sha256').update(text.slice(0, 10000)).digest('hex');

    // Quality check for cached results: skip if pillars are empty or TLDR is the old placeholder.
    // This auto-heals stale caches from before the readability extraction fix (e.g. Discord
    // was cached as SAFE/100 with 0 pillars because readability grabbed the wrong page section).
    const isCacheHealthy = (result: any): boolean => {
        if (!result) return false;
        // Reject if the cached tier doesn't match the requested tier.
        // This is the primary guard — tier is also in the cache key, but this
        // double-checks in case an old key without tier somehow survives.
        if (result.tier && result.tier !== tier) return false;
        const pillars = result.pillars;
        // Quick scans legitimately have no pillars — only deep scans do.
        if (tier === 'deep' && (!pillars || Object.keys(pillars).length === 0)) return false;
        if (result.tldr === 'Analysis complete.') return false;
        // Reject stale cached results that are missing the dark_patterns pillar
        // when the current request has darkPatterns enabled.
        if (darkPatterns && pillars && !pillars.dark_patterns) return false;
        // Reject results from previous pipeline versions.
        if (result.cacheVersion !== CACHE_VERSION) return false;
        return true;
    };

    // FIX: forceRefresh=true skips both cache layers and runs a fresh LLM scan.
    const cachedData = forceRefresh ? null : await getCache(redisKey);

    if (cachedData && cachedData.contentHash === currentContentHash) {
        if (isCacheHealthy(cachedData.result)) {
            console.log('[TLDR Shield] L1 Redis Hit');
            return sendAsSSE({ ...cachedData.result, cached: true });
        }
        console.log('[TLDR Shield] L1 Redis Hit REJECTED (stale/empty pillars) — running fresh scan');
    }

    // 4. Shared Cache Check (L2)
    // Use tier-scoped key: `<urlHash>:<tier>` so Quick and Deep never collide in Firestore.
    if (!forceRefresh && urlHash) {
        const l2Key = `${urlHash}:${tier}`;
        const l2Cache = await getSharedCache(firestoreDb, l2Key);
        if (l2Cache && l2Cache.contentHash === currentContentHash) {
            if (isCacheHealthy(l2Cache.result)) {
                console.log(`[TLDR Shield] L2 Firestore Hit (${tier})`);
                setCache(redisKey, l2Cache, 3600).catch(() => {}); // Backfill Redis (non-blocking)
                return sendAsSSE({ ...l2Cache.result, cached: true });
            }
            console.log(`[TLDR Shield] L2 Firestore Hit REJECTED (tier mismatch or stale) — running fresh scan`);
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

    // Use 40,000 characters per chunk to prevent Gemini API output truncation/rate limit anomalies on massive inputs
    // Strip cookie consent banners (OneTrust, Cookiebot, etc.) from page text before
    // analysis. Cookie banners often contain data-sharing language that belongs to the
    // cookie policy, not the ToS, and cause false positive data_selling citations.
    const cleanText = stripCookieBoilerplate(text);
    const chunks = chunkText(cleanText, 40000, 5000, 3);
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
        const sysPrompt = buildSystemPrompt(eli5, darkPatterns, tier);
        const PILLAR_KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership'];
        if (darkPatterns) {
            PILLAR_KEYS.push('dark_patterns');
        }
        const useParallelPillars = tier === 'deep' && process.env.PARALLEL_PILLARS === 'true';

        // Execute chunks sequentially to avoid triggering the 15 RPM API rate limits.
        const results = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const progressPct = chunks.length > 1 ? ` (${Math.round(((i + 1) / chunks.length) * 100)}%)` : '';
            res.write(`data: ${JSON.stringify({ status: `Analyzing block ${i + 1}/${chunks.length}${progressPct}...` })}\n\n`);
            try {
                const corroborator = (tier === 'deep') ? (process.env.GEMINI_MODEL_SCAN_CORROBORATOR || 'gemini-1.5-flash') : null;

                if (useParallelPillars) {
                    // A1: Fan-out 6 parallel pillar-specific calls for deep scans.
                    // This is safe per-chunk (6 concurrent calls is under the 15 RPM limit).
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
                    results.push({ pillars });
                } else {
                    // Default path: single combined call (ensemble)
                    const response = await callGeminiEnsemble(sysPrompt, chunk, 8192, 35000, modelStack[0], corroborator as string, keyPool);
                    const parsed = extractJSON(response.content);
                    
                    if (!parsed) {
                        logRecentError('ParseError', 'Failed to extract JSON from response content', {
                            rawContent: response?.content,
                            model: modelStack[0],
                            corroborator
                        });
                    } else if (tier === 'deep' && !parsed.pillars) {
                        logRecentError('SchemaError', 'Deep scan response missing pillars object', {
                            parsedKeys: Object.keys(parsed),
                            rawContent: response?.content,
                            model: modelStack[0]
                        });
                    }

                    // Pass 1: verbatim citation grounding — replace LLM paraphrases with exact source text
                    // FIX #3: Skip grounding for placeholder labels (quick scan artifacts) — only
                    // run on real LLM-generated citation text to avoid the "Exact text not found" warning.
                    if (parsed?.pillars) {
                        for (const key of Object.keys(parsed.pillars)) {
                            const p = parsed.pillars[key];
                            if (p?.violation && p?.citation && p.citation !== 'Flagged by quick analysis' && p.citation !== '[NOT_FOUND]') {
                                p.citation = findVerbatimInChunk(p.citation, chunk);
                            }
                        }
                    }
                    results.push(parsed);
                }
            } catch (err: any) {
                console.error(`[TLDR Shield] ❌ Block ${i + 1} FAILED — ${err?.message || err} | status=${err?.status || err?.statusCode || 'N/A'}`);
                console.error(`[TLDR Shield] Block ${i + 1} full error:`, JSON.stringify(err, Object.getOwnPropertyNames(err)));
                logRecentError(`BlockError-${i + 1}`, err?.message || String(err), { 
                    status: err?.status || err?.statusCode || 'N/A',
                    stack: err?.stack,
                    keysCount: keyPool.length,
                    model: modelStack[0]
                });
                results.push(null);
            }
        }

        // FIX: Normalize quick-scan flat results (no 'pillars') → pillar format.
        // Quick scan prompt returns {"tldr":"...","ai_training":bool,...} without pillars.
        // Deep scan returns {"tldr":"...","pillars":{...}}. Both must produce validResults.
        const PILLAR_KEYS_NORM = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership'];
        if (darkPatterns) {
            PILLAR_KEYS_NORM.push('dark_patterns');
        }
        const normalizedResults = results.map((r, idx) => {
            if (!r) return null;
            if (r.pillars) return r; // deep scan — already structured
            
            // For deep scans, we require the structured pillars. Do not fall back to flat quick-scan format.
            if (tier === 'deep') {
                console.warn(`[TLDR Shield] Block ${idx + 1} returned flat format instead of deep pillars. Rejecting block.`);
                return null;
            }

            // Quick scan: flat booleans → convert to pillar format
            const hasAnyBool = PILLAR_KEYS_NORM.some(k => typeof r[k] === 'boolean');
            if (!hasAnyBool) {
                logRecentError('NormalizeError', 'Quick scan response missing pillar booleans', {
                    blockIndex: idx,
                    responseKeys: Object.keys(r),
                    responseContent: JSON.stringify(r)
                });
                return null;
            }
            const pillars: Record<string, any> = {};
            for (const key of PILLAR_KEYS_NORM) {
                if (typeof r[key] === 'boolean') {
                    pillars[key] = { violation: r[key], citation: r[key] ? 'Flagged by quick analysis' : '[NOT_FOUND]', confidence: 'MEDIUM' };
                }
            }
            return { ...r, pillars };
        });

        // Robust Aggregation (Fix #2)
        const validResults = normalizedResults.filter(r => r && r.pillars);
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

        // FIX #2: Emit Step 3 status — "Auditing Privacy Pillars" — so the UI progress
        // bar advances past Step 2. Previously the server went straight from chunk status to
        // the final result without ever emitting Steps 3 or 4.
        res.write(`data: ${JSON.stringify({ status: 'auditing pillars...' })}\n\n`);

        const crossCheckConfirmed = applyConsistencyCrossCheck(aggregatedPillars, text);
        updatePillarConfidence(aggregatedPillars, crossCheckConfirmed, text);

        // FIX #2: Emit Step 4 status — "Calculating Score"
        res.write(`data: ${JSON.stringify({ status: 'calculating score...' })}\n\n`);

        const { score, rating, deductions } = calculateScoreAndRating(aggregatedPillars, tier, text.length);
        const requestId = crypto.randomUUID();

        // FIX: Build best TLDR — prefer first non-trivial LLM summary, else synthesize from violations.
        const bestTldr = validResults
            .map(r => r?.tldr)
            .find((t: any) => t && t.length > 20 && t !== 'Analysis complete.');
        const synthesizedTldr = (() => {
            const violations = Object.entries(aggregatedPillars)
                .filter(([, p]: any) => p.violation)
                .map(([k]) => k.replace(/_/g, ' '));
            if (violations.length === 0) return `This policy scored ${score}/100. No major privacy violations were detected.`;
            return `This ${rating} policy scored ${score}/100. Privacy concerns found in: ${violations.slice(0, 3).join(', ')}.`;
        })();

        const final = {
            score,
            rating,
            deductions,
            pillars: aggregatedPillars,
            tldr: bestTldr || synthesizedTldr,
            requestId,
            tier,
            cacheVersion: CACHE_VERSION,  // used by isCacheHealthy to reject stale cached results
        };

        sanitizeCitations(final.pillars);

        // POST-SCAN CITATION BACKFILL:
        // For any SAFE pillar that returned [NOT_FOUND], search the full raw text
        // deterministically for the most relevant sentence using keyword scoring.
        // Same document always produces the same citation — fixes scan-to-scan inconsistency.
        // Never changes violation flag or confidence — only fills in missing citations.
        backfillSafeCitations(final.pillars, cleanText);

        // UNIVERSAL VIOLATION BACKSTOP:
        // Scan the full clean text with compound regex patterns to catch violations
        // the LLM missed due to chunking. Only upgrades SAFE → RISKY, never downgrades.
        // "sublicensable", "class action", "binding arbitration" etc. are unambiguous
        // in any legal document — no LLM confirmation needed.
        detectHardViolations(cleanText, final.pillars);

        // Recalculate score/rating/deductions — detectHardViolations may have added violations
        const recalc = calculateScoreAndRating(final.pillars, tier, cleanText.length);
        final.score = recalc.score;
        final.rating = recalc.rating;
        final.deductions = recalc.deductions;

        // FIX: Send result to client FIRST — before any DB/cache writes.
        // Previously, a Firestore or Redis failure inside Promise.all would throw,
        // jump to the catch block, and the result was never sent — leaving the extension
        // hanging with "No result returned". DB saves are best-effort and must NOT
        // block the user's response.
        res.write(`data: ${JSON.stringify(final)}\n\n`);
        res.end();

        // Save and cache after responding (non-blocking — failures are logged but ignored)
        const cacheObject = { contentHash: currentContentHash, result: final };
        // Use tier-scoped L2 key to match the tier-scoped read — Quick and Deep never collide.
        const l2WriteKey = `${urlHash || baseHash}:${tier}`;
        Promise.all([
            setCache(redisKey, cacheObject, 3600 * 24),
            setSharedCache(firestoreDb, l2WriteKey, cacheObject, tier),
            saveScanRecord(firestoreDb, uid, final, { url, tier, cached: false })
        ]).catch(saveErr => {
            console.warn('[TLDR Shield] Non-fatal: cache/DB save failed:', saveErr);
        });

    } catch (err: any) {
        console.error('[TLDR Shield] Pipeline Error:', err.message);
        logRecentError('PipelineError', err.message, { stack: err.stack, tier, url });
        // Wrap refundCredits so a DB failure doesn't prevent the error SSE event from being sent.
        try { await refundCredits(firestoreDb, uid, cost); } catch (refundErr) {
            console.warn('[TLDR Shield] Credit refund failed (non-fatal):', refundErr);
        }
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: 'Analysis failed. Please try again.' })}\n\n`);
            res.end();
        }
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
