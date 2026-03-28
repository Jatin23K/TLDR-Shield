import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Firestore Shared Community Cache ────────────────────────────────────────
// L1 = in-memory LRU (per-instance, resets on restart)
// L2 = Firestore shared_cache (persistent, shared across ALL users & instances)
//
// When User A scans Spotify ToS → result stored in Firestore (anonymously, no UID).
// When User B scans the same page within the TTL window → served from L2 instantly.
// User deleting their scan history does NOT affect the shared cache (fully decoupled).
//
// Requires Firebase Admin SDK credentials:
//   - Production (Cloud Run): Application Default Credentials (automatic)
//   - Local dev: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
//     OR run: gcloud auth application-default login
import type { Firestore } from 'firebase-admin/firestore';

let firestoreDb: Firestore | null = null;

(async () => {
    try {
        const { initializeApp, getApps, cert } = await import('firebase-admin/app');
        const { getFirestore } = await import('firebase-admin/firestore');

        // Load project config (same file the frontend uses)
        const appletConfig = JSON.parse(readFileSync(new URL('./firebase-applet-config.json', import.meta.url), 'utf8'));
        const projectId: string = appletConfig.projectId;
        const databaseId: string = appletConfig.firestoreDatabaseId ?? '(default)';

        if (getApps().length === 0) {
            const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
            if (saPath) {
                // Explicit service account JSON (local dev or CI)
                const sa = JSON.parse(readFileSync(saPath, 'utf8'));
                initializeApp({ credential: cert(sa), projectId });
            } else {
                // Application Default Credentials: automatic on Cloud Run / GKE.
                // For local dev: run  gcloud auth application-default login
                initializeApp({ projectId });
            }
        }

        const db = getFirestore(databaseId);

        // Connectivity test — if credentials aren't configured the ping throws
        await db.collection(SHARED_CACHE_COLLECTION).limit(1).get();

        firestoreDb = db;
        console.log('[TLDR Shield] Firestore shared cache: CONNECTED (project=' + projectId + ', db=' + databaseId + ')');
    } catch (err: any) {
        console.warn(
            '[TLDR Shield] Firestore unavailable — running with in-memory cache only.\n' +
            '  To enable shared cache locally:\n' +
            '    Option A: gcloud auth application-default login\n' +
            '    Option B: set FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json\n' +
            '  Error: ' + (err?.message ?? err)
        );
    }
})();

// ─── Credit System ────────────────────────────────────────────────────────────
const CREDIT_COST: Record<string, number> = { quick: 10, deep: 20 };
const FREE_CREDITS = 400;

// Verify a Firebase ID token from Authorization: Bearer <token> header
// Returns the UID on success, null on failure (not signed in or invalid token)
async function getUidFromRequest(req: express.Request): Promise<string | null> {
    const authHeader = (req.headers.authorization ?? '').toString();
    if (!authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    if (!token) return null;
    try {
        const { getAuth } = await import('firebase-admin/auth');
        const decoded = await getAuth().verifyIdToken(token);
        return decoded.uid;
    } catch {
        return null;
    }
}

// Atomically check credits and deduct if sufficient.
// Also handles monthly reset (lastResetMonth !== current month → reset to 400).
async function checkAndDeductCredits(
    uid: string,
    cost: number,
): Promise<{ ok: boolean; creditsLeft: number; error?: string }> {
    if (!firestoreDb) {
        // Firestore unavailable — allow scan but can't track credits
        return { ok: true, creditsLeft: -1 };
    }
    const currentMonth = new Date().toISOString().slice(0, 7); // "2026-03"
    const userRef = firestoreDb.collection('users').doc(uid);
    try {
        return await firestoreDb.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            let credits = FREE_CREDITS;
            let lastResetMonth = '';
            if (snap.exists) {
                const d = snap.data()!;
                credits = typeof d.credits === 'number' ? d.credits : FREE_CREDITS;
                lastResetMonth = d.lastResetMonth ?? '';
            }
            // Monthly reset — new month = fresh 400 credits
            if (lastResetMonth !== currentMonth) {
                credits = FREE_CREDITS;
                lastResetMonth = currentMonth;
            }
            if (credits < cost) {
                return {
                    ok: false,
                    creditsLeft: credits,
                    error: `Not enough credits. This scan costs ${cost} credits and you have ${credits} left. Credits reset on the 1st of each month.`,
                };
            }
            const newCredits = credits - cost;
            tx.set(userRef, { uid, credits: newCredits, lastResetMonth }, { merge: true });
            return { ok: true, creditsLeft: newCredits };
        });
    } catch (err: any) {
        console.error('[TLDR Shield] Credit transaction failed:', err?.message);
        return { ok: true, creditsLeft: -1 }; // fail open so NIM still works
    }
}

// TTL per tier: quick = 48 h, deep = 7 days
const SHARED_CACHE_TTL_MS: Record<string, number> = {
    quick: 48 * 60 * 60 * 1000,
    deep:   7 * 24 * 60 * 60 * 1000,
};
const SHARED_CACHE_COLLECTION = 'shared_cache';

// Firestore helpers imported lazily once credentials are confirmed working
let _Timestamp: any = null;
let _FieldValue: any = null;
async function getFirestoreHelpers() {
    if (!_Timestamp) {
        const m = await import('firebase-admin/firestore');
        _Timestamp = m.Timestamp;
        _FieldValue = m.FieldValue;
    }
    return { Timestamp: _Timestamp, FieldValue: _FieldValue };
}

async function getSharedCache(hash: string): Promise<any | null> {
    if (!firestoreDb) return null;
    try {
        const doc = await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).get();
        if (!doc.exists) return null;
        const data = doc.data()!;
        // Manual TTL check (Firestore TTL policy on expiresAt field cleans up async)
        if (data.expiresAt.toMillis() < Date.now()) return null;
        return data.result ?? null;
    } catch (err: any) {
        console.warn(`[TLDR Shield] Firestore read failed: ${err?.message}`);
        return null;
    }
}

async function setSharedCache(hash: string, result: any, tier: string): Promise<void> {
    if (!firestoreDb) return;
    try {
        const { Timestamp, FieldValue } = await getFirestoreHelpers();
        const ttl = SHARED_CACHE_TTL_MS[tier] ?? SHARED_CACHE_TTL_MS.quick;
        await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).set({
            result,
            tier,
            scannedAt: Timestamp.now(),
            expiresAt: Timestamp.fromMillis(Date.now() + ttl),
            scanCount: FieldValue.increment(1),
        }, { merge: true });
    } catch (err: any) {
        console.warn(`[TLDR Shield] Firestore write failed: ${err?.message}`);
    }
}

// NIM API key pool — rotated on rate-limit or server errors
const NIM_KEYS = [
    process.env.NIM_API_KEY_1,
    process.env.NIM_API_KEY_2,
    process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

let nimKeyIndex = 0;

// FIX #2: Key failover — retries each key on 5xx / 429, throws on 4xx client errors
// Per-key timeout of 8s — if a key doesn't respond in 8s, move to the next one immediately
const PER_KEY_TIMEOUT_MS = 8000;

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
    let lastError: any;
    for (let attempt = 0; attempt < NIM_KEYS.length; attempt++) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
        nimKeyIndex++;
        const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });
        // Combine global signal + per-key timeout into a single abort signal
        const keyController = new AbortController();
        const keyTimeout = setTimeout(() => keyController.abort(), PER_KEY_TIMEOUT_MS);
        // Abort the key-level controller if the global signal fires
        const globalAbortHandler = () => keyController.abort();
        signal.addEventListener('abort', globalAbortHandler, { once: true });
        try {
            const result = await client.chat.completions.create(params, { signal: keyController.signal });
            return result;
        } catch (err: any) {
            lastError = err;
            const status = err?.status ?? 0;
            // Do not retry on client errors (4xx) except rate limit (429)
            if (status >= 400 && status < 500 && status !== 429) throw err;
            // If global signal fired, stop retrying
            if (signal.aborted) throw err;
            console.warn(`[TLDR Shield] Key #${attempt + 1} failed (status=${status}), trying next key...`);
        } finally {
            clearTimeout(keyTimeout);
            signal.removeEventListener('abort', globalAbortHandler);
        }
    }
    throw lastError;
}

// ─── Model Config ─────────────────────────────────────────────────────────────
// Two-tier model strategy (both via NVIDIA NIM):
// - Basic scan: lower-latency reasoning model (target 5–10s)
// - Deep scan : higher-accuracy reasoning model (target 10–20s)
//
// Configure via .env:
// - NIM_MODEL_QUICK=meta/llama-3.1-70b-instruct
// - NIM_MODEL_DEEP=meta/llama-3.1-405b-instruct
const DEFAULT_QUICK_MODEL_ID = "meta/llama-3.3-70b-instruct";
const DEFAULT_DEEP_MODEL_ID = "meta/llama-3.3-70b-instruct";
const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || DEFAULT_QUICK_MODEL_ID).trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || DEFAULT_DEEP_MODEL_ID).trim();

const MODELS = {
    quick: {
        id: QUICK_MODEL_ID,
        label: "Basic scan model",
        maxTokens: 120,      // badge-only: just rating+score+tldr → ~2-3s with llama-3.3-70b
        temperature: 0.2,
        timeoutMs: 20000,
        stepIntervalMs: 900,
    },
    deep: {
        id: DEEP_MODEL_ID,
        label: "Deep scan model",
        maxTokens: 900,      // full prompt with verbatim citations → ~5-10s with llama-3.3-70b
        temperature: 0.2,
        timeoutMs: 30000,
        stepIntervalMs: 1200,
    },
};

// ─── Multi-Agent Chunking Pipeline ───────────────────────────────────────────
// For docs > CHUNK_THRESHOLD chars, split into overlapping blocks,
// analyze each block in parallel, then aggregate into one verdict.
const CHUNK_THRESHOLD  = 12000;  // chars — single-call below this (~3k tokens)
const CHUNK_SIZE       = 10000;  // chars per block (~2.5k tokens, safe for 128k ctx)
const CHUNK_OVERLAP    = 1500;   // FIX #13: 1500 chars (~250 words) preserves multi-paragraph clause context
const MAX_CHUNKS       = 8;      // safety cap → max ~80k chars analyzed per request
const CHUNK_CONCURRENCY = 2;     // FIX #8: max parallel NIM calls — prevents key exhaustion on large docs

function chunkText(text: string): string[] {
    if (text.length <= CHUNK_THRESHOLD) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length && chunks.length < MAX_CHUNKS) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        chunks.push(text.slice(start, end));
        if (end === text.length) break;
        start = end - CHUNK_OVERLAP;
    }
    return chunks;
}

async function analyzeChunk(
    chunk: string,
    chunkIndex: number,
    totalChunks: number,
    model: (typeof MODELS)['quick'],
    eli5: boolean,
    darkPatterns: boolean,
    tier: 'quick' | 'deep',
    signal: AbortSignal,
    sendUpdate: (data: any) => void,
): Promise<any> {
    const run = async () => {
        const response = await nimCreateWithRetry({
            model: model.id,
            messages: [
                { role: 'system', content: buildSystemPrompt(eli5, darkPatterns, tier) },
                {
                    role: 'user',
                    content: tier === 'quick'
                        ? `Legal document section ${chunkIndex + 1} of ${totalChunks}. Give an instant verdict:\n\n${chunk}`
                        : `Analyze this section (block ${chunkIndex + 1}/${totalChunks}) thoroughly. Extract ALL violations present:\n\n${chunk}`,
                },
            ],
            temperature: model.temperature,
            max_tokens: model.maxTokens,
        }, signal);

        const raw = response.choices[0]?.message?.content || '{}';
        const result = extractJSON(raw);
        if (!result || typeof result.score !== 'number') {
            throw new Error(`Block ${chunkIndex + 1} returned an unreadable response`);
        }
        return result;
    };

    // FIX: Per-chunk retry — attempt once, retry once on failure before dropping the block
    try {
        const result = await run();
        sendUpdate({ status: `Block ${chunkIndex + 1}/${totalChunks} analyzed...` });
        return result;
    } catch (firstErr: any) {
        if (signal.aborted) throw firstErr;
        console.warn(`[TLDR Shield] Chunk ${chunkIndex + 1} failed, retrying once... (${firstErr?.message})`);
        const result = await run(); // throws if retry also fails — propagates to allSettled
        sendUpdate({ status: `Block ${chunkIndex + 1}/${totalChunks} analyzed (retry)...` });
        return result;
    }
}

const PILLAR_KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership', 'dark_patterns'] as const;

function aggregateResults(results: any[], tier: 'quick' | 'deep'): any {
    if (results.length === 1) return results[0];

    // Worst-case score across all blocks — one bad block tanks the whole doc
    const worstScore = Math.min(...results.map(r => typeof r.score === 'number' ? r.score : 100));
    const worstBlock = results.find(r => r.score === worstScore) ?? results[0];

    if (tier === 'quick') {
        // Quick: badge only — no pillar detail needed
        return {
            rating: worstBlock.rating ?? 'RISKY',
            score: worstScore,
            tldr: worstBlock.tldr ?? `Document analyzed across ${results.length} sections.`,
            pillars: null,   // intentionally omitted for quick tier
        };
    }

    // Deep: union of violations — if ANY block flags a pillar, it's flagged overall
    // Citation comes from the block that actually found the violation
    const pillars: Record<string, any> = {};
    for (const key of PILLAR_KEYS) {
        const violatingBlock = results.find(r => r.pillars?.[key]?.violation === true);
        if (violatingBlock) {
            pillars[key] = { violation: true, citation: violatingBlock.pillars[key].citation };
        } else {
            const withCitation = results.find(r => r.pillars?.[key]?.citation && r.pillars[key].citation !== 'Not addressed in document.');
            pillars[key] = { violation: false, citation: withCitation?.pillars[key]?.citation ?? 'Not addressed in document.' };
        }
    }

    // Synthesize a combined TL;DR that names the worst blocks
    const violationCount = Object.values(pillars).filter((p: any) => p.violation).length;
    const combinedTldr = worstBlock.tldr
        ? worstBlock.tldr
        : `Document analyzed across ${results.length} sections with ${violationCount} violation(s) found.`;

    return { rating: worstBlock.rating ?? 'RISKY', score: worstScore, tldr: combinedTldr, pillars };
}

// ─── In-Memory LRU Cache (max 500 entries) ───────────────────────────────────
const MAX_CACHE = 500;
const analysisCache = new Map<string, any>();
function setCacheEntry(key: string, value: any) {
    if (analysisCache.size >= MAX_CACHE) {
        const firstKey = analysisCache.keys().next().value;
        if (firstKey) analysisCache.delete(firstKey);
    }
    analysisCache.set(key, value);
}

// Strips <think>…</think> reasoning tokens then extracts the first valid JSON object.
// Uses a brace-depth counter instead of lastIndexOf('}') — handles citations that
// contain '}' characters without breaking the outer JSON boundary.
function extractJSON(text: string): any | null {
    const clean = (src: string) => src
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();

    const normalize = (raw: string) =>
        raw.replace(/,\s*([}\]])/g, '$1');   // remove trailing commas

    const tryParse = (raw: string): any | null => {
        try { return JSON.parse(raw); } catch { return null; }
    };

    // FIX #15: Walk the string with a depth counter to find the exact closing brace
    // of the outermost JSON object, even when citations contain '{' or '}' chars.
    const findOutermostObject = (src: string): string | null => {
        const start = src.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < src.length; i++) {
            const ch = src[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return src.substring(start, i + 1);
            }
        }
        return null;
    };

    for (const src of [clean(text), text]) {
        const candidate = findOutermostObject(src);
        if (!candidate) continue;
        const parsed = tryParse(candidate) ?? tryParse(normalize(candidate));
        if (parsed && typeof parsed === 'object') return parsed;
    }

    console.error('[TLDR Shield] JSON extraction failed. Raw:', text.substring(0, 300));
    return null;
}

// ─── System Prompts ───────────────────────────────────────────────────────────
// Quick: badge-only verdict (rating + score + tldr). No pillars, minimal tokens → ~3s.
// Deep:  full breakdown — all 6 pillars + verbatim citations + ELI5 → ~6-10s.
// Chunking is auto-triggered by size for BOTH tiers — it is infrastructure, not a feature.
function buildSystemPrompt(eli5: boolean, darkPatterns: boolean, tier: 'quick' | 'deep'): string {

    // ── QUICK: instant verdict, badge only ────────────────────────────────────
    if (tier === 'quick') {
        const extraPillar = darkPatterns ? ', dark_patterns (manipulative/deceptive clauses?)' : '';
        return `You are a privacy attorney giving an instant verdict. Scan for: ai_training (AI training without opt-out?), data_selling (sharing data with third parties commercially?), transparency (deliberately vague language?), data_retention (retention >1yr post-deletion?), content_ownership (overly broad IP claim?)${extraPillar}.

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;
    }

    // ── Deep scan: full breakdown — all pillars + verbatim citations ──────────
    const darkField = darkPatterns
        ? ',\n    "dark_patterns": { "violation": boolean, "citation": "string" }'
        : "";

    const citationInstruction = eli5
        ? "For 'citation': write a plain-English ELI5 explanation (no legal jargon) of what the policy says about this pillar."
        : "For 'citation': copy the EXACT verbatim sentence(s) from the document. Do NOT paraphrase. If nothing is stated, write 'Not addressed in document.'";

    const darkPillar = darkPatterns
        ? "\n6. dark_patterns — Manipulative language, confusing opt-out flows, pre-ticked consent boxes, or deceptive framing."
        : "";

    return `You are a senior privacy attorney and data protection expert.

Analyze the legal text against these privacy pillars:
1. ai_training      — Data used for AI/ML training WITHOUT a simple, accessible opt-out?
2. data_selling     — Personal data shared or sold to third parties for their own commercial use?
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices?
4. data_retention   — Deletion rights denied, or retention exceeds 1 year post-account-deletion?
5. content_ownership — Broad IP rights claimed over user content beyond what is needed to operate the service?${darkPillar}

VIOLATION RULES:
- Mark violation=true ONLY with CLEAR, EXPLICIT evidence. Absence of a clause ≠ violation.
- transparency: ONLY true if language is actively misleading. Clear, concise policies = no violation.
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year = violation.
- content_ownership: "license to display to users" = no violation. "perpetual irrevocable worldwide license beyond platform use" = violation.

SCORING (use these bands exactly):
- 0 violations, clear language    → score 90-100, rating "SAFE"
- 0 violations, minor vagueness   → score 75-89,  rating "OKAY"
- 1 low-severity violation        → score 50-74,  rating "OKAY"
- 1 high-severity or 2 violations → score 25-49,  rating "RISKY"
- 3-4 violations                  → score 10-24,  rating "RISKY"
- 5-6 violations                  → score 0-9,    rating "RISKY"

MANDATORY: score<50 → rating MUST be "RISKY". score 50-74 → rating MUST be "OKAY". score≥75 → "SAFE" or "OKAY".

${citationInstruction}

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
{
  "rating": "SAFE" | "OKAY" | "RISKY",
  "score": <integer 0-100>,
  "tldr": "<2-3 sentence plain-English summary. Name specific risks.>",
  "pillars": {
    "ai_training":       { "violation": boolean, "citation": "string" },
    "data_selling":      { "violation": boolean, "citation": "string" },
    "transparency":      { "violation": boolean, "citation": "string" },
    "data_retention":    { "violation": boolean, "citation": "string" },
    "content_ownership": { "violation": boolean, "citation": "string" }${darkField}
  }
}`;
}

// FIX #11: Progress steps streamed to client during model inference
const QUICK_STEPS = [
    'Reading legal document...',
    'Identifying key clauses...',
    'Analyzing privacy pillars...',
    'Checking for violations...',
    'Calculating privacy score...',
];
const DEEP_STEPS = [
    'Reading legal document...',
    'Mapping data collection practices...',
    'Auditing AI training provisions...',
    'Reviewing data sharing terms...',
    'Analyzing retention & deletion rights...',
    'Checking content ownership clauses...',
    'Scanning for dark patterns...',
    'Calculating privacy score...',
];

async function startServer() {
    if (NIM_KEYS.length === 0) {
        console.error('[TLDR Shield] FATAL: No NIM API keys found. Set NIM_API_KEY_1 in your .env file.');
        process.exit(1);
    }
    console.log(`[TLDR Shield] ${NIM_KEYS.length} NIM key(s) loaded. Basic=${MODELS.quick.id} | Deep=${MODELS.deep.id}`);

    const app = express();

    // FIX #2: Read PORT from env — Cloud Run assigns a dynamic port via $PORT
    const PORT = parseInt(process.env.PORT || '3000', 10);

    const APP_ORIGIN = process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL
        : 'http://localhost:3000';

    // FIX #1: CORS allows the web app AND Chrome/Firefox extension origins.
    // Chrome extensions send Origin: chrome-extension://[id], Firefox sends moz-extension://[id].
    // Some background service workers send Origin: null — also allowed.
    const ALLOWED_ORIGINS = new Set([
        APP_ORIGIN,
        'http://localhost:3000',
        'http://localhost:5173',
    ]);

    app.use(cors({
        origin: (origin, callback) => {
            // No origin → curl / same-origin / extension service worker (null origin)
            if (!origin) return callback(null, true);
            // Dev: allow everything
            if (process.env.NODE_ENV !== 'production') return callback(null, true);
            // Prod: allow known web origins + any browser extension
            if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
            if (origin.startsWith('chrome-extension://')) return callback(null, true);
            if (origin.startsWith('moz-extension://')) return callback(null, true);
            callback(new Error(`CORS: origin ${origin} not allowed`));
        },
        methods: ['GET', 'POST'],
    }));
    app.use(express.json({ limit: '5mb' }));

    // Rate limiting: 30 requests per 15 minutes per IP
    const analyzeRateLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Please wait before trying again.' },
        skip: (req) => req.path === '/health', // health check never counts against the limit
    });

    // API key auth — set INTERNAL_API_KEY in .env to require callers to authenticate.
    // In dev or if the env var is absent the check is skipped (open access).
    const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
    const apiKeyGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!INTERNAL_KEY || process.env.NODE_ENV !== 'production') return next();
        const provided = (req.headers['x-api-key'] ?? '').toString().trim();
        if (!provided || provided !== INTERNAL_KEY) {
            return res.status(401).json({ error: 'Unauthorized. A valid X-API-Key header is required.' });
        }
        next();
    };

    // Health check — memory, cache, key metrics, and Firestore status
    app.get("/health", (_req, res) => {
        const mem = process.memoryUsage();
        res.json({
            status: 'ok',
            uptime: Math.round(process.uptime()),
            memory: {
                heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                rssMB: Math.round(mem.rss / 1024 / 1024),
            },
            cache: { size: analysisCache.size, max: MAX_CACHE },
            sharedCache: { connected: firestoreDb !== null },
            nimKeys: NIM_KEYS.length,
        });
    });

    // Credits balance — returns current credits for the signed-in user
    app.get("/api/credits", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ error: 'Sign in required.', requestId });
        if (!firestoreDb) return res.json({ credits: FREE_CREDITS, requestId });
        try {
            const snap = await firestoreDb.collection('users').doc(uid).get();
            const currentMonth = new Date().toISOString().slice(0, 7);
            if (!snap.exists) return res.json({ credits: FREE_CREDITS, requestId });
            const d = snap.data()!;
            const credits = d.lastResetMonth !== currentMonth ? FREE_CREDITS : (d.credits ?? FREE_CREDITS);
            res.json({ credits, requestId });
        } catch (err: any) {
            res.status(500).json({ error: 'Could not fetch credits.', requestId });
        }
    });

    app.post("/api/analyze", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        // Request correlation ID — included in every response and logged for tracing
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);

        const { text, tier, eli5, darkPatterns } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'No text provided.', requestId });
        }

        // Validate tier explicitly — unknown values get a 400, not a silent fallback
        if (tier && tier !== 'quick' && tier !== 'deep') {
            return res.status(400).json({ error: 'Invalid tier. Use "quick" or "deep".', requestId });
        }

        // Minimum text check — reject meaningless inputs
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        if (wordCount < 20) {
            return res.status(400).json({
                error: 'Text is too short to analyze. Please paste at least a paragraph of the legal document.',
                requestId,
            });
        }

        // ── Auth check — require a signed-in Firebase user ─────────────────────
        const uid = await getUidFromRequest(req);
        if (!uid) {
            return res.status(401).json({
                error: 'Sign in required. Please sign in to TLDR Shield to scan pages.',
                requestId,
            });
        }

        const effectiveTier = tier === 'deep' ? 'deep' : 'quick';
        const cost = CREDIT_COST[effectiveTier];

        // ── Credit check — deduct before calling NIM ───────────────────────────
        const creditResult = await checkAndDeductCredits(uid, cost);
        if (!creditResult.ok) {
            // Calculate the 1st of next month as the reset date
            const now = new Date();
            const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
                .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
            return res.status(402).json({
                error: creditResult.error,
                creditsLeft: creditResult.creditsLeft,
                resetDate,
                requestId,
            });
        }

        // Multi-agent covers up to MAX_CHUNKS × CHUNK_SIZE chars; truncate beyond that
        const MAX_TOTAL = MAX_CHUNKS * CHUNK_SIZE; // 80 000 chars
        const wasTruncated = text.length > MAX_TOTAL;
        const truncatedPercent = wasTruncated ? Math.round((1 - MAX_TOTAL / text.length) * 100) : 0;
        const processedText = text.substring(0, MAX_TOTAL);

        const model = effectiveTier === 'deep' ? MODELS.deep : MODELS.quick;
        const steps = effectiveTier === 'deep' ? DEEP_STEPS : QUICK_STEPS;

        const hash = crypto
            .createHash('sha256')
            // include model id to avoid serving stale results when models change
            .update(processedText + (eli5 ? '_eli5' : '') + (effectiveTier === 'deep' ? '_deep' : '') + (darkPatterns ? '_dp' : '') + `_${model.id}`)
            .digest('hex');

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendUpdate = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

        // FIX #4: Abort the NIM call immediately when the client disconnects
        // (navigates away, closes tab) — stops wasting API credits on orphaned requests.
        const controller = new AbortController();
        req.on('close', () => controller.abort());

        console.log(`[TLDR Shield] [${requestId}] ${effectiveTier} scan — ${processedText.length} chars | ip=${req.ip}`);

        // ── L1: in-memory cache (sub-ms) ──────────────────────────────────────
        if (analysisCache.has(hash)) {
            console.log(`[TLDR Shield] [${requestId}] L1 cache hit (in-memory)`);
            sendUpdate({
                ...analysisCache.get(hash),
                status: 'Complete',
                cached: true,
                truncated: wasTruncated,
                latencyMs: 0,
                model: model.id,
                requestId,
                creditsLeft: creditResult.creditsLeft,
            });
            return res.end();
        }

        // ── L2: Firestore shared community cache (~50ms) ───────────────────────
        sendUpdate({ status: 'Checking community cache...' });
        const sharedResult = await getSharedCache(hash);
        if (sharedResult) {
            console.log(`[TLDR Shield] [${requestId}] L2 cache hit (Firestore shared)`);
            setCacheEntry(hash, sharedResult); // promote to L1
            sendUpdate({
                ...sharedResult,
                status: 'Complete',
                cached: true,
                truncated: wasTruncated,
                latencyMs: 0,
                model: model.id,
                requestId,
                creditsLeft: creditResult.creditsLeft,
            });
            return res.end();
        }

        try {
            const analysisStart = Date.now();
            const chunks = chunkText(processedText);
            const isMultiChunk = chunks.length > 1;

            // Extend global timeout for chunked requests
            const globalTimeoutMs = model.timeoutMs + (isMultiChunk ? 20000 : 0);
            const timeout = setTimeout(() => controller.abort(), globalTimeoutMs);

            let result: any;

            try {
                if (!isMultiChunk) {
                    // ── Agent 3: Single-document analysis ──────────────────────────────
                    // FIX #11: Stream progress steps while model is thinking
                    let stepIdx = 0;
                    sendUpdate({ status: steps[stepIdx++] });
                    const progressInterval = setInterval(() => {
                        if (stepIdx < steps.length) sendUpdate({ status: steps[stepIdx++] });
                    }, model.stepIntervalMs);

                    let rawCompletion: string;
                    try {
                        const response = await nimCreateWithRetry({
                            model: model.id,
                            messages: [
                                { role: 'system', content: buildSystemPrompt(eli5 ?? false, darkPatterns ?? false, effectiveTier) },
                                { role: 'user', content: `Analyze this legal document:\n\n${processedText}` },
                            ],
                            temperature: model.temperature,
                            max_tokens: model.maxTokens,
                        }, controller.signal);
                        rawCompletion = response.choices[0]?.message?.content || '{}';
                    } finally {
                        clearInterval(progressInterval);
                    }

                    sendUpdate({ status: 'Structuring results...' });
                    result = extractJSON(rawCompletion);
                    if (!result || !result.rating || typeof result.score !== 'number') {
                        throw new Error('Model returned an unreadable response. Please try again.');
                    }

                } else {
                    // ── Agent 2 → 3 → 4: Multi-block parallel analysis ─────────────────
                    sendUpdate({ status: `Splitting document into ${chunks.length} blocks...` });

                    // Small pause so user sees the split step before parallel work begins
                    await new Promise(r => setTimeout(r, 500));
                    sendUpdate({ status: `Analyzing ${chunks.length} blocks in parallel...` });

                    // FIX #8: Analyze blocks in batches of CHUNK_CONCURRENCY — avoids
                    // hammering all 3 NIM keys simultaneously with 8 parallel requests.
                    const allSettled: PromiseSettledResult<any>[] = [];
                    for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
                        if (controller.signal.aborted) break;
                        const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
                        const batchResults = await Promise.allSettled(
                            batch.map((chunk, j) =>
                                analyzeChunk(chunk, i + j, chunks.length, model, eli5 ?? false, darkPatterns ?? false, effectiveTier, controller.signal, sendUpdate)
                            )
                        );
                        allSettled.push(...batchResults);
                    }

                    const goodResults = allSettled
                        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
                        .map(r => r.value);
                    const failedCount = chunks.length - goodResults.length;

                    if (goodResults.length === 0) {
                        throw new Error('Failed to analyze document blocks. Please try again.');
                    }

                    // Warn when more than half the chunks failed — result may be incomplete
                    if (failedCount > chunks.length / 2) {
                        console.warn(`[TLDR Shield] [${requestId}] Partial analysis: ${goodResults.length}/${chunks.length} blocks succeeded`);
                        sendUpdate({ status: `⚠️ Partial analysis — ${failedCount} block(s) could not be read.` });
                    }

                    // Agent 4: aggregate block verdicts into one final result
                    sendUpdate({ status: `Aggregating ${goodResults.length}/${chunks.length} blocks...` });
                    result = aggregateResults(goodResults, effectiveTier);

                    if (!result || typeof result.score !== 'number') {
                        throw new Error('Aggregation failed. Please try again.');
                    }

                    // Guard: if score aggregated to 0 but no violations exist, something went wrong
                    if (result.score === 0 && effectiveTier === 'deep') {
                        const hasViolation = result.pillars && Object.values(result.pillars).some((p: any) => p.violation);
                        if (!hasViolation) {
                            console.warn(`[TLDR Shield] [${requestId}] score=0 with no violations — likely model confusion on repetitive text`);
                            result.score = 10; // floor to lowest RISKY band with actual violations
                        }
                    }

                    sendUpdate({ status: 'Structuring results...' });
                }
            } finally {
                clearTimeout(timeout);
            }

            // FIX #3: Enforce score↔rating consistency — model sometimes contradicts itself
            if (result.score < 50) result.rating = 'RISKY';
            else if (result.score < 75) result.rating = result.rating === 'SAFE' ? 'OKAY' : result.rating;
            else if (result.score >= 75 && result.rating === 'RISKY') result.rating = 'OKAY';

            const latencyMs = Date.now() - analysisStart;
            const finalResult = { ...result, truncated: wasTruncated, truncatedPercent, chunked: isMultiChunk, chunkCount: chunks.length, latencyMs, model: model.id, requestId, creditsLeft: creditResult.creditsLeft };
            console.log(`[TLDR Shield] [${requestId}] ${effectiveTier} scan complete — ${latencyMs}ms | chunks=${chunks.length} | rating=${result.rating} | score=${result.score} | credits_left=${creditResult.creditsLeft}`);
            sendUpdate({ ...finalResult, status: 'Complete', cached: false });
            // Write to L1 (sync) and L2 Firestore shared cache (async, fire-and-forget)
            setCacheEntry(hash, result);
            setSharedCache(hash, result, effectiveTier);
            res.end();

        } catch (error: any) {
            // FIX #10: Clean, user-friendly error messages — no raw API errors exposed
            console.error(`[TLDR Shield] [${requestId}] Analysis error:`, error?.status ?? '', error?.message ?? error);
            let userMessage: string;
            if (error.name === 'AbortError') {
                userMessage = 'Analysis timed out. Try a shorter document or switch to Basic Scan.';
            } else if (error?.status === 429) {
                userMessage = 'Rate limit reached. Please wait a moment and try again.';
            } else {
                userMessage = 'Analysis failed. Please try again.';
            }
            // Always include truncation metadata in error responses so the client knows
            // how much of the document was actually processed even on failure.
            sendUpdate({ error: userMessage, requestId, truncated: wasTruncated, truncatedPercent });
            res.end();
        }
    });

    if (process.env.NODE_ENV !== 'production') {
        const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
    }

    const server = app.listen(PORT, '0.0.0.0', () =>
        console.log(`[TLDR Shield] Running on port ${PORT}`)
    );

    // FIX #12: Graceful shutdown — Cloud Run sends SIGTERM before killing the container.
    // Without this, in-flight SSE streams are cut immediately mid-response.
    const shutdown = (signal: string) => {
        console.log(`[TLDR Shield] ${signal} received — closing server gracefully...`);
        server.close(() => {
            console.log('[TLDR Shield] All connections closed. Exiting.');
            process.exit(0);
        });
        // Force-exit after 30s if connections don't drain
        setTimeout(() => {
            console.error('[TLDR Shield] Forced exit after 30s drain timeout.');
            process.exit(1);
        }, 30_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

startServer();
