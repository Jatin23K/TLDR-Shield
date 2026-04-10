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
import nlp from "compromise";

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
            const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
            const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
            if (saJson) {
                // Inline JSON string — works on Railway, Render, Fly, and any PaaS
                // that can't mount files. Paste the service account JSON as a single
                // env var value (multi-line JSON is fine; most dashboards accept it).
                const sa = JSON.parse(saJson);
                initializeApp({ credential: cert(sa), projectId });
            } else if (saPath) {
                // File path — local dev or CI with mounted secrets
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
            '  To enable shared cache:\n' +
            '    Option A: gcloud auth application-default login  (local dev)\n' +
            '    Option B: set FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json  (local dev / CI)\n' +
            '    Option C: set FIREBASE_SERVICE_ACCOUNT_JSON=\'{"type":"service_account",...}\'  (Railway / PaaS)\n' +
            '  Error: ' + (err?.message ?? err)
        );
    }
})();

// ─── Credit System ────────────────────────────────────────────────────────────
const CREDIT_COST: Record<string, number> = { quick: 10, deep: 20 };
const FREE_CREDITS = 400;
const ALLOW_UNMETERED_LOCAL = process.env.ALLOW_UNMETERED_LOCAL === 'true';

type CreditResult = {
    ok: boolean;
    creditsLeft: number;
    error?: string;
    reason?: 'insufficient' | 'unavailable';
};

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

function getCurrentMonth(): string {
    return new Date().toISOString().slice(0, 7);
}

function getNextResetDateLabel(): string {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1)
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function normalizeSourceUrl(raw: string | null | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null;
    try {
        const parsed = new URL(raw.trim());
        parsed.hash = ''; // fragments are client-local and should not affect cache bucketing
        return parsed.toString();
    } catch {
        return null;
    }
}

function hashSourceUrl(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
}

// Atomically check credits and deduct if sufficient.
// Also handles monthly reset (lastResetMonth !== current month → reset to 400).
async function checkAndDeductCredits(
    uid: string,
    cost: number,
): Promise<CreditResult> {
    if (!firestoreDb) {
        if (process.env.NODE_ENV !== 'production' && ALLOW_UNMETERED_LOCAL) {
            return { ok: true, creditsLeft: -1 };
        }
        return {
            ok: false,
            creditsLeft: 0,
            reason: 'unavailable',
            error: 'Credit service is temporarily unavailable. Please try again shortly.',
        };
    }
    const currentMonth = getCurrentMonth();
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
                    reason: 'insufficient',
                };
            }
            const newCredits = credits - cost;
            tx.set(userRef, { uid, credits: newCredits, lastResetMonth }, { merge: true });
            return { ok: true, creditsLeft: newCredits };
        });
    } catch (err: any) {
        console.error('[TLDR Shield] Credit transaction failed:', err?.message);
        if (process.env.NODE_ENV !== 'production' && ALLOW_UNMETERED_LOCAL) {
            return { ok: true, creditsLeft: -1 };
        }
        return {
            ok: false,
            creditsLeft: 0,
            reason: 'unavailable',
            error: 'Credit service is temporarily unavailable. Please try again shortly.',
        };
    }
}

async function refundCredits(uid: string, amount: number): Promise<number | null> {
    if (amount <= 0) return null;
    if (!firestoreDb) return null;
    const currentMonth = getCurrentMonth();
    const userRef = firestoreDb.collection('users').doc(uid);
    try {
        const updatedCredits = await firestoreDb.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            let credits = FREE_CREDITS;
            let lastResetMonth = '';
            if (snap.exists) {
                const d = snap.data()!;
                credits = typeof d.credits === 'number' ? d.credits : FREE_CREDITS;
                lastResetMonth = d.lastResetMonth ?? '';
            }
            if (lastResetMonth !== currentMonth) {
                credits = FREE_CREDITS;
                lastResetMonth = currentMonth;
            }
            const newCredits = credits + amount;
            tx.set(userRef, { uid, credits: newCredits, lastResetMonth }, { merge: true });
            return newCredits;
        });
        return updatedCredits;
    } catch (err: any) {
        console.error('[TLDR Shield] Refund transaction failed:', err?.message);
        return null;
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

async function setSharedCache(
    hash: string,
    result: any,
    tier: string,
    sourceUrlHash?: string | null,
): Promise<void> {
    if (!firestoreDb) return;
    try {
        const { Timestamp, FieldValue } = await getFirestoreHelpers();
        const ttl = SHARED_CACHE_TTL_MS[tier] ?? SHARED_CACHE_TTL_MS.quick;
        await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).set({
            result,
            tier,
            ...(sourceUrlHash ? { sourceUrlHash } : {}),
            scannedAt: Timestamp.now(),
            expiresAt: Timestamp.fromMillis(Date.now() + ttl),
            scanCount: FieldValue.increment(1),
        }, { merge: true });
    } catch (err: any) {
        console.warn(`[TLDR Shield] Firestore write failed: ${err?.message}`);
    }
}

async function saveScanRecord(
    uid: string,
    result: any,
    meta: {
        url: string | null;
        tier: 'quick' | 'deep';
        requestId: string;
        modelId: string;
        cached: boolean;
        latencyMs: number;
    },
): Promise<void> {
    if (!firestoreDb) return;
    const doc = async () => {
        const { Timestamp } = await getFirestoreHelpers();
        await firestoreDb!.collection('scans').add({
            uid,
            url: meta.url,
            rating: typeof result?.rating === 'string' ? result.rating : 'RISKY',
            score: typeof result?.score === 'number' ? result.score : 0,
            tldr: typeof result?.tldr === 'string' ? result.tldr : '',
            pillars: result?.pillars && typeof result.pillars === 'object' ? result.pillars : {},
            tier: meta.tier,
            model: meta.modelId,
            cached: meta.cached,
            latencyMs: meta.latencyMs,
            requestId: meta.requestId,
            createdAt: Timestamp.now(),
        });
    };
    try {
        await doc();
    } catch (err: any) {
        console.warn(`[TLDR Shield] Failed to persist scan record (attempt 1): ${err?.message} — retrying…`);
        try {
            await new Promise(r => setTimeout(r, 1500));
            await doc();
        } catch (err2: any) {
            console.error(`[TLDR Shield] Failed to persist scan record (attempt 2): ${err2?.message}`);
        }
    }
}

// NIM API key pool — rotated on rate-limit or server errors
const NIM_KEYS = [
    process.env.NIM_API_KEY_1,
    process.env.NIM_API_KEY_2,
    process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

let nimKeyIndex = 0;

// FIX #2: Key failover — retries each key on 5xx / 429, throws on 4xx client errors.
// Reliability tune: longer per-key timeout + retry rounds with exponential backoff
// significantly reduces deep-scan parse failures on transient NIM saturation.
const PER_KEY_TIMEOUT_MS = Number(process.env.NIM_PER_KEY_TIMEOUT_MS || 12000);
const NIM_RETRY_ROUNDS = Math.max(1, Number(process.env.NIM_RETRY_ROUNDS || 3));
const NIM_RETRY_BASE_BACKOFF_MS = Number(process.env.NIM_RETRY_BASE_BACKOFF_MS || 1200);

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
    let lastError: any;
    for (let round = 0; round < NIM_RETRY_ROUNDS; round++) {
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
                console.warn(`[TLDR Shield] Round ${round + 1}/${NIM_RETRY_ROUNDS} key #${attempt + 1} failed (status=${status}), trying next key...`);
            } finally {
                clearTimeout(keyTimeout);
                signal.removeEventListener('abort', globalAbortHandler);
            }
        }

        // All keys failed this round on retryable errors; back off before next round.
        if (round < NIM_RETRY_ROUNDS - 1 && !signal.aborted) {
            const jitter = Math.floor(Math.random() * 500);
            const backoffMs = (NIM_RETRY_BASE_BACKOFF_MS * (round + 1)) + jitter;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
// - NIM_MODEL_QUICK=meta/llama-3.3-70b-instruct
// - NIM_MODEL_DEEP=meta/llama-3.3-70b-instruct
const DEFAULT_QUICK_MODEL_ID = "meta/llama-3.3-70b-instruct";
const DEFAULT_DEEP_MODEL_ID = "meta/llama-3.3-70b-instruct";
const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || DEFAULT_QUICK_MODEL_ID).trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || DEFAULT_DEEP_MODEL_ID).trim();

const MODELS = {
    quick: {
        id: QUICK_MODEL_ID,
        label: "Basic scan model",
        maxTokens: 120,      // badge-only: just rating+score+tldr → ~2-3s with llama-3.3-70b
        temperature: 0,      // deterministic — reduces creative paraphrasing
        timeoutMs: 20000,
        stepIntervalMs: 900,
    },
    deep: {
        id: DEEP_MODEL_ID,
        label: "Deep scan model",
        maxTokens: 1400,     // increased: verbatim citations need room — ~6-12s with llama-3.3-70b
        temperature: 0,      // deterministic — reduces creative paraphrasing
        timeoutMs: 45000,    // reliability bump for large/complex policies
        stepIntervalMs: 1200,
    },
};

// ─── Multi-Agent Chunking Pipeline ───────────────────────────────────────────
// For docs > CHUNK_THRESHOLD chars, split into overlapping blocks,
// analyze each block in parallel, then aggregate into one verdict.
const CHUNK_THRESHOLD  = 12000;  // chars — single-call below this (~3k tokens)
const CHUNK_SIZE       = 10000;  // chars per block (~2.5k tokens, safe for 128k ctx)
const CHUNK_OVERLAP    = 2500;   // FIX #13→#20: increased to 2500 chars (~400 words) — prevents clause-boundary splits
const MAX_CHUNKS       = 8;      // safety cap → max ~80k chars analyzed per request
const CHUNK_CONCURRENCY = 2;     // 2 parallel chunks — balances speed vs NIM rate limits (3 keys available)

// FIX #20: Sentence-aware chunking using compromise NLP.
// Splits text into sentences first, then groups sentences into chunks that stay
// under CHUNK_SIZE chars with CHUNK_OVERLAP chars of sentence-level overlap.
// This prevents clauses from being sliced mid-sentence, which was the leading
// cause of the LLM missing context and producing paraphrased citations.

function chunkText(text: string): string[] {
    if (text.length <= CHUNK_THRESHOLD) return [text];

    // Use compromise to split into sentences; fall back to punctuation split
    let sentences: string[];
    try {
        sentences = (nlp(text) as any).sentences().out('array') as string[];
        // compromise sometimes returns empty strings or very short fragments — filter
        sentences = sentences.filter((s: string) => s.trim().length > 10);
    } catch {
        sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
    }

    if (sentences.length === 0) sentences = [text];

    const chunks: string[] = [];
    let current = '';
    // Track tail sentences for overlap between chunks
    let tailSentences: string[] = [];

    for (let i = 0; i < sentences.length && chunks.length < MAX_CHUNKS; i++) {
        const sentence = sentences[i];

        if ((current + ' ' + sentence).length > CHUNK_SIZE && current.length > 0) {
            chunks.push(current.trim());

            // Build overlap: take tail sentences until we reach ~CHUNK_OVERLAP chars
            let overlapText = '';
            for (let j = tailSentences.length - 1; j >= 0; j--) {
                const candidate = tailSentences[j] + ' ' + overlapText;
                if (candidate.length > CHUNK_OVERLAP) break;
                overlapText = candidate;
            }
            current = overlapText + ' ' + sentence;
            tailSentences = [];
        } else {
            current = current ? current + ' ' + sentence : sentence;
        }
        tailSentences.push(sentence);
        // Keep only as many tail sentences as needed for overlap
        while (tailSentences.join(' ').length > CHUNK_OVERLAP * 1.5 && tailSentences.length > 1) {
            tailSentences.shift();
        }
    }

    // Add any remaining text that didn't trigger a chunk split
    if (current.trim()) chunks.push(current.trim());

    // Safety: if we somehow ended up with 0 chunks, fall back to raw slice
    if (chunks.length === 0) {
        let start = 0;
        while (start < text.length && chunks.length < MAX_CHUNKS) {
            const end = Math.min(start + CHUNK_SIZE, text.length);
            chunks.push(text.slice(start, end));
            if (end === text.length) break;
            start = end - CHUNK_OVERLAP;
        }
    }

    return chunks.slice(0, MAX_CHUNKS);
}

// Given a paraphrased LLM citation and the original chunk text, find and return
// the best matching verbatim passage from the chunk. Falls back to the original
// citation if no good match is found.
function findVerbatimInChunk(citation: string, chunkText: string): string {
    if (!citation || citation === 'Not addressed in document.' || !chunkText) return citation;

    const STOPWORDS = new Set(['the','and','for','are','but','not','you','all','can','had','her','was','one','our','out','how','did','his','any','may','have','that','from','this','they','with','your','been','when','will','more','also','into','some','than','its','use','used','uses','such','also','which','their','about','been','other','these']);

    // Extract meaningful key terms from the citation (4+ chars, not stopwords)
    const keyTerms = citation
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !STOPWORDS.has(w))
        .slice(0, 6);

    if (keyTerms.length === 0) return citation;

    const chunkLower = chunkText.toLowerCase();

    // Score each term: find how many key terms appear near each other in the chunk
    let bestIdx = -1;
    let bestScore = 0;

    for (const term of keyTerms) {
        let pos = 0;
        while ((pos = chunkLower.indexOf(term, pos)) !== -1) {
            // Count how many other key terms appear within ±150 chars of this position
            const window = chunkLower.slice(Math.max(0, pos - 150), pos + 150);
            const score = keyTerms.filter(t => window.includes(t)).length;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = pos;
            }
            pos += term.length;
        }
    }

    // Need at least 2 key terms co-located to trust the match
    if (bestIdx === -1 || bestScore < 2) return citation;

    // Expand to clean sentence/clause boundaries (±200 chars, trim to ~120 words)
    const rawStart = Math.max(0, bestIdx - 100);
    const rawEnd = Math.min(chunkText.length, bestIdx + 300);
    let passage = chunkText.slice(rawStart, rawEnd).trim();

    // Trim to a clean start (first capital letter or after punctuation)
    const cleanStart = passage.search(/[A-Z"'"']/);
    if (cleanStart > 0 && cleanStart < 40) passage = passage.slice(cleanStart);

    // Trim to a clean end (after sentence-ending punctuation within 120 words)
    const words = passage.split(/\s+/);
    if (words.length > 60) passage = words.slice(0, 60).join(' ');

    // Final trim — must be meaningfully longer than the LLM's paraphrase to be worth using
    return passage.trim().length >= 30 ? passage.trim() : citation;
}

// ─── NIM Embeddings — rank chunks by semantic relevance to a pillar ──────────
// Uses nvidia/nv-embedqa-e5-v5 to embed the pillar description + all candidate
// chunks, then returns the top-N chunks by cosine similarity.
// This replaces the naive "send first 40k chars" approach — only the most
// relevant sections of the document are sent to the focused LLM call.

const NIM_EMBED_MODEL = 'nvidia/nv-embedqa-e5-v5';

async function embedTexts(texts: string[], signal: AbortSignal): Promise<number[][]> {
    if (signal.aborted) return [];
    const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
    nimKeyIndex++;
    const nimEmbed = new OpenAI({ apiKey: key, baseURL: 'https://integrate.api.nvidia.com/v1', timeout: 15000 });
    try {
        const res = await nimEmbed.embeddings.create(
            { model: NIM_EMBED_MODEL, input: texts, encoding_format: 'float' } as any,
            { signal }
        );
        return (res.data as any[]).map((d: any) => d.embedding as number[]);
    } catch (err: any) {
        // Embeddings are best-effort — gracefully degrade to keyword search on failure
        console.warn('[TLDR Shield] Embeddings unavailable, falling back to keyword ranking:', err?.message ?? err);
        return [];
    }
}

function cosine(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// Split fullText into ~2000-char candidate passages (paragraph-level), embed them,
// return the top-N passages most similar to the pillar description query.
async function getTopPassagesForPillar(
    pillarDesc: string,
    fullText: string,
    topN: number,
    signal: AbortSignal,
): Promise<string[]> {
    // Split into ~2000-char paragraphs at double-newlines or sentence boundaries
    const rawPassages = fullText.split(/\n{2,}/).filter(p => p.trim().length > 60);
    const passages = rawPassages.length >= 3 ? rawPassages : [fullText.slice(0, 40000)];

    // Embed query + all passages in one batch (cheaper than separate calls)
    const inputs = [pillarDesc, ...passages.map(p => p.slice(0, 512))];
    const embeddings = await embedTexts(inputs, signal);

    if (embeddings.length < 2) {
        // Fallback: keyword-based ranking
        const queryWords = new Set(pillarDesc.toLowerCase().split(/\W+/).filter(w => w.length > 4));
        const scored = passages.map(p => ({
            text:  p,
            score: [...queryWords].filter(w => p.toLowerCase().includes(w)).length,
        }));
        return scored.sort((a, b) => b.score - a.score).slice(0, topN).map(x => x.text);
    }

    const queryEmbed   = embeddings[0];
    const passageEmbeds = embeddings.slice(1);

    const scored = passages.map((p, i) => ({
        text:  p,
        score: cosine(queryEmbed, passageEmbeds[i] ?? []),
    }));

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map(x => x.text);
}

// Two-pass citation: embeddings → rank passages → focused LLM call on top-3 passages
const PILLAR_DESCRIPTIONS: Record<string, string> = {
    ai_training:       'AI or machine learning training using user content or data',
    data_selling:      'sharing or selling user content or personal data to third parties, advertisers, or partners',
    transparency:      'deliberately vague, obscuring, or contradictory language about data practices',
    data_retention:    'data retention period, deletion timeline, or how long data is kept after account deletion',
    content_ownership: 'intellectual property rights, content license granted to the platform, or right to sublicense',
    dark_patterns:     'liability cap in dollar amount, class action waiver, arbitration clause, or shortened statute of limitations',
};

async function extractVerbatimForPillar(
    pillarKey: string,
    fullText: string,
    signal: AbortSignal,
): Promise<string | null> {
    if (signal.aborted) return null;
    const desc = PILLAR_DESCRIPTIONS[pillarKey] ?? pillarKey;

    // Step 1: Use embeddings to find the 3 most relevant passages
    const topPassages = await getTopPassagesForPillar(desc, fullText, 3, signal);
    const focusedText = topPassages.join('\n\n---\n\n').slice(0, 12000); // stay within token budget

    // Step 2: Focused LLM call on only the relevant passages
    try {
        const response = await nimCreateWithRetry({
            model: MODELS.deep.id,
            messages: [
                {
                    role: 'system',
                    content: 'You are a legal document search tool. Find and copy-paste exact text. Never paraphrase.',
                },
                {
                    role: 'user',
                    content: `Find the clause in these document excerpts that relates to: ${desc}.\n\nCopy-paste 15–60 consecutive words VERBATIM (exactly as they appear). Do not rephrase or summarize.\nIf no such clause exists in the excerpts below, reply with exactly: NOT FOUND\n\nExcerpts:\n${focusedText}`,
                },
            ],
            temperature: 0,
            max_tokens: 200,
        }, signal);
        const text = (response.choices[0]?.message?.content ?? '').trim();
        if (!text || text === 'NOT FOUND' || text.length < 15) return null;
        // Verify it actually appears verbatim in the source (first 50 chars check)
        const prefix = text.toLowerCase().replace(/['"]/g, '').trim().slice(0, 50);
        if (prefix.length >= 20 && !fullText.toLowerCase().includes(prefix)) return null;
        return text;
    } catch {
        return null;
    }
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

        // FIX #17: Replace paraphrased citations with verbatim text from the source chunk.
        // The LLM has access to the chunk text right here — use it to ground citations.
        if (tier === 'deep' && result.pillars) {
            for (const key of Object.keys(result.pillars)) {
                const p = result.pillars[key];
                if (p?.citation && p.citation !== 'Not addressed in document.' && p.violation) {
                    const verbatim = findVerbatimInChunk(p.citation, chunk);
                    if (verbatim !== p.citation) {
                        console.log(`[TLDR Shield] Chunk ${chunkIndex + 1} verbatim fix [${key}]: "${p.citation.slice(0, 40)}..." → "${verbatim.slice(0, 40)}..."`);
                        p.citation = verbatim;
                    }
                }
            }
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

function applyConsistencyCrossCheck(pillars: Record<string, any>, allDeductionText: string): void {
    // Require 2+ keyword hits before flipping a pillar to avoid false positives.
    // Transparency removed — too subjective, cross-check causes false positives.
    // Keywords are more specific multi-word phrases to reduce accidental substring matches.
    const PILLAR_DEDUCTION_KEYWORDS: Record<string, string[]> = {
        ai_training:       ['machine learning', 'artificial intelligence', 'ai training', 'ai model', 'train our', 'training of our', 'ml model'],
        data_selling:      ['third-party advertis', 'sell user data', 'selling data', 'advertising partners', 'third party commercial', 'data for commercial'],
        data_retention:    ['data retention', 'retain data', 'deletion timeline', 'store data', 'keep your data', 'retention period'],
        content_ownership: ['intellectual property', 'worldwide license', 'royalty-free license', 'sublicensable license', 'license to use content', 'broad ip'],
        dark_patterns:     ['liability cap', 'class action waiver', 'class action', 'forced arbitration', 'shortened statute', 'one-sided termination', 'arbitration clause'],
    };
    for (const key of PILLAR_KEYS) {
        if (key === 'transparency') continue; // too subjective for cross-check
        if (!pillars[key]?.violation) {
            const keywords = PILLAR_DEDUCTION_KEYWORDS[key] ?? [];
            // Require at least 2 keyword hits to prevent loose single-word matches
            const hitCount = keywords.filter(kw => allDeductionText.includes(kw)).length;
            if (hitCount >= 2) {
                pillars[key] = { ...pillars[key], violation: true };
            }
        }
    }
}

// Detect third-person paraphrase citations and replace with sentinel.
// LLMs frequently write "The policy states..." or "There is no mention of..." instead of
// copy-pasting verbatim text. These can't be found on the page → no highlight.
// Sanitizing to 'Not addressed in document.' keeps the UI honest.
const PARAPHRASE_PATTERNS = [
    /^the policy\b/i,
    /^the terms of service\b/i,
    /^the terms\b/i,
    /^the document\b/i,
    /^the agreement\b/i,
    /^the platform\b/i,
    /^the service\b/i,
    /^the tos\b/i,
    /^this policy\b/i,
    /^this document\b/i,
    /^this agreement\b/i,
    /^there is no\b/i,
    /^there are no\b/i,
    /^no mention\b/i,
    /^no explicit\b/i,
    /^no specific\b/i,
    /\bprovided terms of service\b/i,
    /\bin the provided\b/i,
    /\bmention of .{0,40} in the\b/i,
    /\bin the terms of service\b/i,
    /\bin the document\b/i,
];
// Strip "The policy states that [X], indicating Y" → "[X]"
// Keeps the verbatim core when LLM wraps a real quote in a paraphrase sentence.
const VIOLATION_PREFIX_RE = /^(?:the (?:terms?(?: of service)?|policy|document|agreement|x user agreement|platform)\s+(?:also\s+)?(?:states?|says?|notes?|requires?|provides?|includes?|limits?|caps?|restricts?|grants?|gives?)\s+(?:that\s+)?["'"'"]?|this (?:policy|license|agreement|means?)\s+(?:states?|says?|provides?|requires?|means?)\s+(?:that\s+)?["'"'"]?)/i;
const VIOLATION_SUFFIX_RE = /[,;]\s+(?:indicating|suggesting|implying|potentially|which means|and may be|and could be|making it|this means|and is)[^.]*\.?\s*$/i;

function stripViolationWrapper(citation: string): string {
    const cleaned = citation.replace(VIOLATION_PREFIX_RE, '').replace(VIOLATION_SUFFIX_RE, '').replace(/["'"'"]+$/, '').trim();
    return cleaned.length >= 20 ? cleaned : citation;
}

function sanitizeCitations(pillars: Record<string, any>): void {
    if (!pillars) return;
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p?.citation || p.citation === 'Not addressed in document.') continue;
        if (p.violation) {
            // For VIOLATION pillars: strip paraphrase wrappers to expose verbatim core
            const stripped = stripViolationWrapper(p.citation.trim());
            p.citation = stripped;
            continue;
        }
        // For CLEAR pillars: replace outright paraphrases with sentinel
        const c = p.citation.trim();
        if (PARAPHRASE_PATTERNS.some(re => re.test(c))) {
            p.citation = 'Not addressed in document.';
        }
    }
}

function aggregateResults(results: any[], tier: 'quick' | 'deep'): any {
    if (results.length === 1) {
        // Single chunk — still apply consistency cross-check
        const r = results[0];
        if (r.pillars && r.deductions) {
            const deductionText = (r.deductions as any[])
                .map((d: any) => d.reason ?? '').join(' ').toLowerCase();
            applyConsistencyCrossCheck(r.pillars, deductionText);
            sanitizeCitations(r.pillars);
        }
        return r;
    }

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
    // Citation and confidence come from the block that actually found the violation
    const pillars: Record<string, any> = {};
    for (const key of PILLAR_KEYS) {
        const violatingBlock = results.find(r => r.pillars?.[key]?.violation);
        if (violatingBlock) {
            const vp = violatingBlock.pillars[key];
            pillars[key] = { violation: true, citation: vp.citation, confidence: vp.confidence ?? 'MEDIUM' };
        } else {
            const withCitation = results.find(r => r.pillars?.[key]?.citation && r.pillars[key].citation !== 'Not addressed in document.');
            const cp = withCitation?.pillars[key];
            pillars[key] = { violation: false, citation: cp?.citation ?? 'Not addressed in document.', confidence: cp?.confidence ?? 'LOW' };
        }
    }

    // ── Consistency cross-check: auto-flip pillars that appear in deductions ──
    const allDeductionText: string = results
        .flatMap(r => (r.deductions ?? []).map((d: any) => d.reason ?? ''))
        .join(' ')
        .toLowerCase();
    applyConsistencyCrossCheck(pillars, allDeductionText);
    sanitizeCitations(pillars);

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
const cacheKeyToUrlHash = new Map<string, string>();
const cacheKeysByUrlHash = new Map<string, Set<string>>();

function removeCacheEntry(key: string): boolean {
    const existed = analysisCache.delete(key);
    const urlHash = cacheKeyToUrlHash.get(key);
    if (urlHash) {
        cacheKeyToUrlHash.delete(key);
        const bucket = cacheKeysByUrlHash.get(urlHash);
        if (bucket) {
            bucket.delete(key);
            if (bucket.size === 0) cacheKeysByUrlHash.delete(urlHash);
        }
    }
    return existed;
}

function clearCacheEntriesByUrlHash(urlHash: string): number {
    const keys = cacheKeysByUrlHash.get(urlHash);
    if (!keys || keys.size === 0) return 0;
    const toDelete = Array.from(keys);
    let cleared = 0;
    for (const key of toDelete) {
        if (removeCacheEntry(key)) cleared++;
    }
    return cleared;
}

function setCacheEntry(key: string, value: any, sourceUrlHash?: string | null) {
    if (analysisCache.has(key)) {
        removeCacheEntry(key);
    }
    if (analysisCache.size >= MAX_CACHE) {
        const firstKey = analysisCache.keys().next().value;
        if (typeof firstKey === 'string') removeCacheEntry(firstKey);
    }
    analysisCache.set(key, value);
    if (sourceUrlHash) {
        cacheKeyToUrlHash.set(key, sourceUrlHash);
        let bucket = cacheKeysByUrlHash.get(sourceUrlHash);
        if (!bucket) {
            bucket = new Set<string>();
            cacheKeysByUrlHash.set(sourceUrlHash, bucket);
        }
        bucket.add(key);
    }
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
        if (parsed && typeof parsed === 'object') {
            // Coerce string "true"/"false" → boolean for violation fields
            if (parsed.pillars && typeof parsed.pillars === 'object') {
                for (const key of Object.keys(parsed.pillars)) {
                    const p = parsed.pillars[key];
                    if (p && typeof p.violation === 'string') {
                        p.violation = p.violation.toLowerCase() === 'true';
                    }
                }
            }
            return parsed;
        }
    }

    console.error('[TLDR Shield] JSON extraction failed. Raw:', text.substring(0, 300));
    return null;
}

const FALLBACK_PILLAR_KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership'] as const;
const FALLBACK_HIGH_SEVERITY = new Set(['ai_training', 'data_selling', 'data_retention', 'content_ownership', 'dark_patterns']);

function extractEvidenceSnippet(sourceText: string, patterns: RegExp[]): string {
    const text = sourceText.replace(/\s+/g, ' ').trim();
    for (const p of patterns) {
        const match = p.exec(text);
        if (!match || typeof match.index !== 'number') continue;
        const idx = match.index;
        // Expand to nearby sentence boundaries where possible.
        const leftDot = text.lastIndexOf('.', idx);
        const leftSemi = text.lastIndexOf(';', idx);
        const leftBreak = Math.max(leftDot, leftSemi);
        const start = leftBreak >= 0 ? leftBreak + 1 : Math.max(0, idx - 180);

        const after = text.slice(idx);
        const rightDotRel = after.indexOf('.');
        const rightSemiRel = after.indexOf(';');
        const rightBreakRel = [rightDotRel, rightSemiRel].filter(v => v >= 0).sort((a, b) => a - b)[0];
        const end = rightBreakRel !== undefined ? Math.min(text.length, idx + rightBreakRel + 1) : Math.min(text.length, idx + 220);

        const snippet = text.slice(start, end).trim();
        if (snippet.length >= 24) return snippet.slice(0, 300);
    }
    return 'Not addressed in document.';
}

function buildDeterministicDeepFallback(
    sourceText: string,
    darkPatternsEnabled: boolean,
    failureReason: string,
): any {
    const patterns: Record<string, RegExp[]> = {
        ai_training: [
            /\b(train(?:ing)?|fine[-\s]?tune|machine learning|artificial intelligence|AI models?)\b.{0,120}\b(user|your|customer)\b.{0,120}\b(data|content|interactions|prompts|uploads)\b/i,
            /\b(user|your|customer)\b.{0,120}\b(data|content|interactions|prompts|uploads)\b.{0,120}\b(train(?:ing)?|improve)\b.{0,80}\b(machine learning|AI|models?)\b/i,
        ],
        data_selling: [
            /\b(sell|selling|share|sharing|disclose|disclosing)\b.{0,140}\b(data|information|content)\b.{0,140}\b(advertis|partner|third[-\s]?part|affiliate|commercial)\b/i,
            /\b(advertising partners?|analytics partners?|third[-\s]?party)\b/i,
            /\b(use|using)\b.{0,80}\bdata\b.{0,80}\b(personalization|advertising|measurement|commercial)\b/i,
        ],
        transparency: [
            /\b(including but not limited to|from time to time|at our sole discretion|for any purpose)\b/i,
            /\bwe may collect other information\b/i,
        ],
        data_retention: [
            /\bretain(?:ed|ing)?\b.{0,120}\b(indefinite|indefinitely|forever|perpetual)\b/i,
            /\bretain(?:ed|ing)?\b.{0,120}\b\d+\s*(year|years)\b/i,
            /\bafter (?:account )?deletion\b.{0,120}\b(month|months|year|years)\b/i,
        ],
        content_ownership: [
            /\blicense\b.{0,180}\b(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free)\b/i,
            /\b(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free)\b.{0,180}\blicense\b/i,
            /\b(create|prepare|preparation of|modify)\b.{0,80}\bderivative works\b/i,
            /\bfor any purpose\b/i,
        ],
        dark_patterns: [
            /\b(class action waiver|waive.*class action)\b/i,
            /\b(binding individual arbitration|forced arbitration)\b/i,
            /\bliability\b.{0,30}\$\s?\d{1,4}\b/i,
            /\bstatute of limitations\b.{0,60}\b(1|one)\s*year\b/i,
        ],
    };

    const pillars: Record<string, any> = {};
    for (const key of FALLBACK_PILLAR_KEYS) {
        const citation = extractEvidenceSnippet(sourceText, patterns[key] ?? []);
        const violation = citation !== 'Not addressed in document.';
        pillars[key] = {
            violation,
            citation,
            confidence: violation ? 'MEDIUM' : 'LOW',
        };
    }

    if (darkPatternsEnabled) {
        const citation = extractEvidenceSnippet(sourceText, patterns.dark_patterns ?? []);
        const violation = citation !== 'Not addressed in document.';
        pillars.dark_patterns = {
            violation,
            citation,
            confidence: violation ? 'MEDIUM' : 'LOW',
        };
    }

    const activeKeys = Object.keys(pillars).filter((k) => pillars[k]?.violation);
    const highSeverityCount = activeKeys.filter((k) => FALLBACK_HIGH_SEVERITY.has(k)).length;

    let score = 85;
    let rating: 'SAFE' | 'OKAY' | 'RISKY' = 'OKAY';
    if (activeKeys.length === 0) {
        score = 85;
        rating = 'OKAY';
    } else if (activeKeys.length === 1 && highSeverityCount === 0) {
        score = 60;
        rating = 'OKAY';
    } else if (activeKeys.length === 1) {
        score = 40;
        rating = 'RISKY';
    } else if (activeKeys.length === 2) {
        score = 35;
        rating = 'RISKY';
    } else if (activeKeys.length === 3) {
        score = 25;
        rating = 'RISKY';
    } else {
        score = 15;
        rating = 'RISKY';
    }

    const tldr = activeKeys.length === 0
        ? 'Deep scan recovered using deterministic fallback because the model response was unavailable. No explicit high-risk clause patterns were found in the processed text.'
        : `Deep scan recovered using deterministic fallback because the model response was unavailable. Potential risks detected in: ${activeKeys.join(', ')}.`;

    return {
        rating,
        score,
        tldr,
        pillars,
        degraded: true,
        fallbackReason: failureReason.slice(0, 200),
    };
}

// ─── System Prompts ───────────────────────────────────────────────────────────
// Quick: badge-only verdict (rating + score + tldr). No pillars, minimal tokens → ~3s.
// Deep:  full breakdown — all 6 pillars + verbatim citations + ELI5 → ~6-10s.
// Chunking is auto-triggered by size for BOTH tiers — it is infrastructure, not a feature.
function buildSystemPrompt(eli5: boolean, darkPatterns: boolean, tier: 'quick' | 'deep'): string {

    // ── QUICK: instant verdict, badge only ────────────────────────────────────
    if (tier === 'quick') {
        const extraPillar = darkPatterns ? ', dark_patterns (liability cap under $1000 OR class action waiver OR shortened statute of limitations OR forced arbitration?)' : '';
        return `You are a privacy attorney giving an instant verdict. Be STRICT. Scan for: ai_training (ANY mention of AI/ML training using user content = violation), data_selling (content/data shared with advertisers or third-party companies = violation), transparency (deliberately vague/obscuring language?), data_retention (retention >1yr post-deletion or completely unspecified?), content_ownership (worldwide sublicensable license "for any purpose" beyond platform use = violation)${extraPillar}.

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;
    }

    // ── Deep scan: full breakdown — all pillars + verbatim citations ──────────
    const darkField = darkPatterns
        ? ',\n    "dark_patterns": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }'
        : "";

    const citationInstruction = eli5
        ? "For 'citation': write a plain-English ELI5 explanation (no legal jargon) of what the policy says about this pillar."
        : `CITATION RULE — VERBATIM COPY-PASTE ONLY, NO EXCEPTIONS:
The 'citation' field must be a verbatim copy-paste of 15-60 consecutive words taken directly from the text. The words must appear exactly as written in the document. This will be used to highlight text in the page — so the citation MUST be exact words from the document.

BANNED PATTERNS (automatic fail — never write these):
✗ Any citation starting with: "The policy", "The terms", "The Terms of Service", "The document", "The agreement", "The platform", "The service", "This policy", "This document", "There is no", "There are no", "No mention", "No explicit", "No specific"
✗ Any sentence in third person about what the policy says or does not say
✗ Any paraphrase, summary, or interpretation of policy text
✗ Descriptions of what the policy does ("The policy limits liability to...")

FOR CLEAR PILLARS (violation: false): Still quote the most relevant verbatim sentence from the document for this pillar. If no relevant text exists AT ALL in the text you received, write exactly: 'Not addressed in document.'

CORRECT FORMAT — first-person text copied exactly as it appears in the document:
✓ ai_training:       "for use with and training of our machine learning and artificial intelligence models, whether generative or another type"
✓ data_selling:      "we and our third-party providers and partners may place advertising on the Services or in connection with the display of Content or information from the Services whether submitted by you or others"
✓ content_ownership: "you grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit, display, upload, download, and distribute such Content, including anything referenced therein, in any and all media or distribution methods now known or later developed, for any purpose"
✓ dark_patterns:     "our aggregate liability shall not exceed the greater of ONE HUNDRED U.S. DOLLARS (U.S. $100.00) OR THE AMOUNT YOU PAID US, IF ANY, IN THE PAST SIX MONTHS FOR THE SERVICES GIVING RISE TO THE CLAIM"
✓ dark_patterns:     "you also waive the right to participate as a plaintiff or class member in any purported class action, collective action or representative action proceeding against us or our corporate affiliates"
✓ transparency:      "Our Privacy Policy (https://x.com/privacy) describes how we handle the information you provide to us when you use the Services"
✓ data_retention:    "Our Privacy Policy describes how we handle the information you provide to us when you use the Services. You understand that through your use of the Services you consent to the collection and use (as set forth in the Privacy Policy)"

If the specific clause does not appear in the text chunk you received, write exactly: 'Not addressed in document.'`;

    const darkPillar = darkPatterns
        ? "\n6. dark_patterns — Unfair or one-sided clauses: liability capped at trivially small amounts (e.g. $100), forced class action waivers, shortened statutes of limitations, one-sided termination rights, hidden arbitration clauses, pre-ticked consent, or manipulative opt-out flows."
        : "";

    return `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data used for AI/ML model training, fine-tuning, or improvement, with no clear user opt-out? VIOLATION EXAMPLES: "for use with and training of our machine learning and artificial intelligence models", "to train our AI", "improve our AI systems using your data". Even if bundled into a broad license clause, if AI training is mentioned = VIOLATION.
2. data_selling     — Content or personal data shared with third parties (advertisers, partners, other companies) beyond what is strictly needed to operate the service? VIOLATION EXAMPLES: content syndicated/distributed to "other companies, organizations or individuals", advertising partners targeting users with their data, data shared for "commercial use". Sharing for advertising = VIOLATION.
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices? VIOLATION EXAMPLES: key rights buried in dense legalese, critical data practices only referenced via external links, no plain-language explanation of data use.
4. data_retention   — No stated deletion timeline, or retention exceeds 1 year post-account-deletion? Delegating entirely to another document without specifics = borderline violation.
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform? VIOLATION EXAMPLES: worldwide royalty-free sublicensable license "for any purpose", right to modify/adapt/redistribute content, no compensation for commercial reuse of content.${darkPillar}

VIOLATION RULES:
- ai_training: ANY mention of using user content/data for AI or ML training = VIOLATION, no exceptions.
- data_selling: Sharing content with advertisers, partners, or "other companies" for their commercial benefit = VIOLATION.
- content_ownership: "for any purpose" or sublicensable worldwide license that goes beyond just showing content on the platform = VIOLATION.
- dark_patterns: $100 or similarly tiny liability cap = VIOLATION. Class action waiver = VIOLATION. Shortened statute of limitations (under 2 years) = VIOLATION. One-sided termination without notice = VIOLATION.
- transparency: ONLY true if language is actively misleading. Clear, concise policies = no violation.
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year or completely unspecified with no reference = violation.

SCORING (use these bands exactly):
- 0 violations, clear language    → score 90-100, rating "SAFE"
- 0 violations, minor vagueness   → score 75-89,  rating "OKAY"
- 1 low-severity violation        → score 50-74,  rating "OKAY"
- 1 high-severity or 2 violations → score 25-49,  rating "RISKY"
- 3-4 violations                  → score 10-24,  rating "RISKY"
- 5-6 violations                  → score 0-9,    rating "RISKY"

MANDATORY: score<50 → rating MUST be "RISKY". score 50-74 → rating MUST be "OKAY". score≥75 → "SAFE" or "OKAY".

CONSISTENCY RULE — CRITICAL: Every deduction MUST match a pillar with violation:true.
If you write a deduction about AI/ML training → ai_training violation MUST be true.
If you write a deduction about data sharing/selling → data_selling violation MUST be true.
If you write a deduction about transparency/vague language → transparency violation MUST be true.
If you write a deduction about data retention → data_retention violation MUST be true.
If you write a deduction about content/IP ownership → content_ownership violation MUST be true.
If you write a deduction about dark patterns/unfair clauses → dark_patterns violation MUST be true.
You CANNOT deduct points for a pillar concern while leaving that pillar's violation as false. That is a contradiction.

EVIDENCE REQUIREMENT — NULL HYPOTHESIS:
Default to violation: false for EVERY pillar. Set violation: true ONLY IF you can copy-paste a verbatim sentence from the text above that proves it. Before marking any pillar as a violation, ask yourself: "Does this exact text appear in the document I just read?" If the answer is no or you're unsure, set violation: false. Do NOT infer violations from silence. Do NOT assume violations because a practice is common in the industry. A missing clause is NOT a violation — it is simply not addressed.

${citationInstruction}

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
{
  "rating": "SAFE" | "OKAY" | "RISKY",
  "score": <integer 0-100>,
  "tldr": "<2-3 sentence plain-English summary. Name specific risks.>",
  "deductions": [
    { "reason": "<specific clause or practice that cost points>", "points": <integer deducted> }
  ],
  "pillars": {
    "ai_training":       { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_selling":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "transparency":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_retention":    { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }${darkField}
  }
}

CONFIDENCE RULES:
- HIGH: You found an explicit, unambiguous clause. Citation is a direct verbatim quote. No interpretation needed.
- MEDIUM: Clause exists but requires some interpretation, or the language is partially ambiguous.
- LOW: Inferred from indirect language, or the relevant text is delegated to an external document.
Always include confidence for every pillar, including CLEAR ones.

DEDUCTIONS RULES:
- Include one entry per reason the score is below 100.
- Each reason must reference the SPECIFIC clause or policy language responsible.
- Points values must sum to exactly (100 - score).
- If score is 100, return an empty array: "deductions": []`;
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
    if (process.env.NODE_ENV === 'production') {
        // Cloud Run sits behind a proxy/load balancer; trust first hop so req.ip is real client IP.
        app.set('trust proxy', 1);
    }

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
    // Guard is active whenever INTERNAL_API_KEY is set, regardless of NODE_ENV.
    // Dev: leave INTERNAL_API_KEY unset for open access. Never rely on NODE_ENV alone.
    const INTERNAL_KEY = process.env.INTERNAL_API_KEY?.trim() || null;
    if (!INTERNAL_KEY && process.env.NODE_ENV === 'production') {
        console.warn('[TLDR Shield] WARNING: INTERNAL_API_KEY is not set in production — all API endpoints are publicly accessible.');
    }
    const apiKeyGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!INTERNAL_KEY) return next(); // no key configured — open access (dev)
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
            cache: { size: analysisCache.size, max: MAX_CACHE, urlBuckets: cacheKeysByUrlHash.size },
            sharedCache: { connected: firestoreDb !== null },
            nimKeys: NIM_KEYS.length,
        });
    });

    // ── User feedback: report an incorrect result ────────────────────────────
    // Stores the report in Firestore (collection: 'reports') for manual review.
    // Never returns sensitive data — just acknowledges receipt.
    app.post("/api/report", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);
        try {
            const uid = await getUidFromRequest(req);
            if (!uid) {
                res.status(401).json({ error: 'Sign in required.', requestId });
                return;
            }
            const { url, rating, score, pillars, reportRequestId, requestId: sourceRequestId, userAgent } = req.body ?? {};
            if (!url || typeof url !== 'string') {
                res.status(400).json({ error: 'url required', requestId });
                return;
            }
            const normalizedUrl = normalizeSourceUrl(url);
            if (!normalizedUrl) {
                res.status(400).json({ error: 'Invalid url.', requestId });
                return;
            }
            const report: Record<string, any> = {
                uid,
                url: normalizedUrl.slice(0, 500),
                rating: rating ?? null,
                score: typeof score === 'number' ? score : null,
                pillars: pillars ?? null,
                requestId: reportRequestId ?? sourceRequestId ?? null,
                userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 120) : null,
                createdAt: new Date().toISOString(),
            };
            if (firestoreDb) {
                await firestoreDb.collection('reports').add(report);
                console.log(`[TLDR Shield] Report logged: uid=${uid} url=${normalizedUrl.slice(0, 80)} score=${score} rating=${rating}`);
            } else {
                console.warn(`[TLDR Shield] Report rejected (Firestore offline): uid=${uid} url=${normalizedUrl.slice(0, 80)} score=${score}`);
                res.status(503).json({ error: 'Feedback service unavailable. Please try again shortly.', requestId });
                return;
            }
            res.json({ ok: true, requestId });
        } catch (err: any) {
            console.error('[TLDR Shield] Report endpoint error:', err?.message ?? err);
            res.status(500).json({ error: 'Failed to store report', requestId });
        }
    });

    // Credits balance — returns current credits for the signed-in user
    // ── DEV ONLY: clear L1 + L2 cache by cache hash or source URL ──────────
    app.delete("/api/cache", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);

        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Cache clear endpoint is disabled in production.', requestId });
        }

        const { url, hash } = req.query as { url?: string; hash?: string };

        if (!url && !hash) {
            // Clear all L1 cache entries for local dev convenience.
            analysisCache.clear();
            cacheKeyToUrlHash.clear();
            cacheKeysByUrlHash.clear();
            return res.json({ cleared: 'l1-all', size: 0, requestId });
        }

        if (hash) {
            const l1Cleared = removeCacheEntry(hash) ? 1 : 0;
            let l2Cleared = 0;
            if (firestoreDb) {
                try {
                    await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).delete();
                    l2Cleared = 1;
                } catch (e: any) {
                    return res.json({ cleared: 'l1-only', hash, l1Cleared, l2Cleared, error: e.message, requestId });
                }
            }
            return res.json({ cleared: 'by-hash', hash, l1Cleared, l2Cleared, requestId });
        }

        const normalizedUrl = normalizeSourceUrl(url);
        if (!normalizedUrl) {
            return res.status(400).json({ error: 'Invalid url.', requestId });
        }
        const sourceUrlHash = hashSourceUrl(normalizedUrl);
        const l1Cleared = clearCacheEntriesByUrlHash(sourceUrlHash);
        let l2Cleared = 0;

        if (firestoreDb) {
            try {
                const snap = await firestoreDb
                    .collection(SHARED_CACHE_COLLECTION)
                    .where('sourceUrlHash', '==', sourceUrlHash)
                    .get();
                if (!snap.empty) {
                    const batch = firestoreDb.batch();
                    for (const d of snap.docs) batch.delete(d.ref);
                    await batch.commit();
                    l2Cleared += snap.size;
                }

                // Legacy fallback: older cache-clear callers hashed the raw URL directly.
                const legacyHash = hashSourceUrl(url!);
                if (legacyHash !== sourceUrlHash) {
                    await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(legacyHash).delete().catch(() => {});
                }
            } catch (e: any) {
                return res.json({
                    cleared: 'l1-only',
                    sourceUrlHash,
                    l1Cleared,
                    l2Cleared,
                    error: e.message,
                    requestId,
                });
            }
        }

        res.json({ cleared: 'by-url', sourceUrlHash, l1Cleared, l2Cleared, requestId });
    });

    app.get("/api/credits", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ error: 'Sign in required.', requestId });
        const creditResult = await checkAndDeductCredits(uid, 0);
        if (!creditResult.ok) {
            return res.status(503).json({ error: creditResult.error, requestId });
        }
        res.json({
            credits: creditResult.creditsLeft >= 0 ? creditResult.creditsLeft : FREE_CREDITS,
            requestId,
        });
    });

    app.post("/api/analyze", analyzeRateLimit, apiKeyGuard, async (req, res) => {
        // Request correlation ID — included in every response and logged for tracing
        const requestId = crypto.randomUUID();
        res.setHeader('X-Request-ID', requestId);

        const { text, tier, eli5, darkPatterns, url } = req.body ?? {};

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
        const normalizedSourceUrl = normalizeSourceUrl(typeof url === 'string' ? url : null);
        const sourceUrlHash = normalizedSourceUrl ? hashSourceUrl(normalizedSourceUrl) : null;

        // Tier cost (deducted only for uncached analyses).
        const cost = CREDIT_COST[effectiveTier];

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

        const startSse = () => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
        };
        const sendSseAndEnd = (data: any) => {
            startSse();
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            res.end();
        };

        console.log(`[TLDR Shield] [${requestId}] ${effectiveTier} scan - ${processedText.length} chars | ip=${req.ip}`);

        const cachedL1 = analysisCache.get(hash);
        if (cachedL1) {
            console.log(`[TLDR Shield] [${requestId}] L1 cache hit (in-memory)`);
            const creditSnapshot = await checkAndDeductCredits(uid, 0);
            if (!creditSnapshot.ok) {
                return res.status(503).json({ error: creditSnapshot.error, requestId });
            }
            void saveScanRecord(uid, cachedL1, {
                url: normalizedSourceUrl,
                tier: effectiveTier,
                requestId,
                modelId: model.id,
                cached: true,
                latencyMs: 0,
            });
            return sendSseAndEnd({
                ...cachedL1,
                status: 'Complete',
                cached: true,
                truncated: wasTruncated,
                latencyMs: 0,
                model: model.id,
                requestId,
                creditsLeft: creditSnapshot.creditsLeft,
            });
        }

        const sharedResult = await getSharedCache(hash);
        if (sharedResult) {
            console.log(`[TLDR Shield] [${requestId}] L2 cache hit (Firestore shared)`);
            setCacheEntry(hash, sharedResult, sourceUrlHash);
            const creditSnapshot = await checkAndDeductCredits(uid, 0);
            if (!creditSnapshot.ok) {
                return res.status(503).json({ error: creditSnapshot.error, requestId });
            }
            void saveScanRecord(uid, sharedResult, {
                url: normalizedSourceUrl,
                tier: effectiveTier,
                requestId,
                modelId: model.id,
                cached: true,
                latencyMs: 0,
            });
            return sendSseAndEnd({
                ...sharedResult,
                status: 'Complete',
                cached: true,
                truncated: wasTruncated,
                latencyMs: 0,
                model: model.id,
                requestId,
                creditsLeft: creditSnapshot.creditsLeft,
            });
        }

        const creditResult = await checkAndDeductCredits(uid, cost);
        if (!creditResult.ok) {
            if (creditResult.reason === 'insufficient') {
                return res.status(402).json({
                    error: creditResult.error,
                    creditsLeft: creditResult.creditsLeft,
                    resetDate: getNextResetDateLabel(),
                    requestId,
                });
            }
            return res.status(503).json({ error: creditResult.error, requestId });
        }

        startSse();
        const sendUpdate = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

        // FIX #4: Abort the NIM call immediately when the client disconnects
        // (navigates away, closes tab) - stops wasting API credits on orphaned requests.
        const controller = new AbortController();
        let clientDisconnected = false;
        req.on('close', () => {
            clientDisconnected = true;
            controller.abort();
        });
        let shouldRefund = cost > 0 && creditResult.creditsLeft >= 0;
        const analysisStart = Date.now();
        try {
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
                    sendUpdate({ status: `Analyzing ${chunks.length} blocks...` });

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
                        // Small pause between blocks so NIM rate limits can recover
                        if (i + CHUNK_CONCURRENCY < chunks.length) {
                            await new Promise(r => setTimeout(r, 1500));
                        }
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

                    // FIX #18: Citation confidence filter.
                    // If after verbatim extraction a violation pillar still has a
                    // paraphrased citation, downgrade it to CLEAR. A violation we
                    // can't point to is worse than no violation — it's untrustworthy.
                    if (effectiveTier === 'deep' && result.pillars) {
                        for (const key of Object.keys(result.pillars)) {
                            const p = result.pillars[key];
                            if (!p?.violation) continue;
                            if (!p.citation || p.citation === 'Not addressed in document.') {
                                console.warn(`[TLDR Shield] [${requestId}] Demoting ${key}: violation with no citation evidence`);
                                result.pillars[key] = { violation: false, citation: 'Not addressed in document.' };
                                continue;
                            }
                            // Detect still-paraphrased citations after all fixes
                            if (PARAPHRASE_PATTERNS.some(re => re.test(p.citation.trim()))) {
                                console.warn(`[TLDR Shield] [${requestId}] Demoting ${key}: paraphrased citation could not be grounded`);
                                result.pillars[key] = { violation: false, citation: 'Not addressed in document.' };
                            }
                        }
                    }

                    // FIX #19: Citation existence validator.
                    // Even after verbatim extraction, verify the citation prefix actually
                    // appears in the source text. Hallucinated citations that sound plausible
                    // but don't exist = unreliable result. Demote to CLEAR.
                    if (effectiveTier === 'deep' && result.pillars) {
                        const textLower = processedText.toLowerCase();
                        for (const key of Object.keys(result.pillars)) {
                            const p = result.pillars[key];
                            if (!p?.violation) continue;
                            if (!p.citation || p.citation === 'Not addressed in document.') continue;
                            // Check first 50 chars of citation appear verbatim in source
                            const prefix = p.citation.toLowerCase().replace(/['"]/g, '').trim().slice(0, 50);
                            if (prefix.length >= 20 && !textLower.includes(prefix)) {
                                console.warn(`[TLDR Shield] [${requestId}] FIX #19: Citation not found in source for ${key} — demoting. Prefix: "${prefix}"`);
                                result.pillars[key] = { violation: false, citation: 'Not addressed in document.' };
                            }
                        }
                    }

                    // FIX #21: Two-pass citation.
                    // For violation pillars where we still have no verifiable citation
                    // after all grounding fixes, make a focused second LLM call asking
                    // specifically: "copy-paste the exact clause proving [pillar]".
                    // If it finds one (and it verifies in source), keep violation=true.
                    // If it can't find one, demote to CLEAR — no citation = no violation.
                    if (effectiveTier === 'deep' && result.pillars) {
                        const weakPillars = Object.keys(result.pillars).filter(key => {
                            const p = result.pillars[key];
                            return p?.violation && (
                                !p.citation ||
                                p.citation === 'Not addressed in document.' ||
                                PARAPHRASE_PATTERNS.some((re: RegExp) => re.test(p.citation.trim()))
                            );
                        });
                        if (weakPillars.length > 0) {
                            sendUpdate({ status: 'Verifying citations...' });
                            for (const key of weakPillars) {
                                const verbatim = await extractVerbatimForPillar(key, processedText, controller.signal);
                                if (verbatim) {
                                    result.pillars[key].citation = verbatim;
                                    console.log(`[TLDR Shield] [${requestId}] Two-pass citation [${key}]: "${verbatim.slice(0, 60)}..."`);
                                } else {
                                    result.pillars[key] = { violation: false, citation: 'Not addressed in document.' };
                                    console.warn(`[TLDR Shield] [${requestId}] Two-pass: no verbatim for ${key} — demoted to CLEAR`);
                                }
                            }
                        }
                    }

                    sendUpdate({ status: 'Structuring results...' });
                }
            } finally {
                clearTimeout(timeout);
            }

            // FIX #16: Server-side score override — never trust the LLM score blindly.
            // Count actual violations and force the score into the correct band.
            if (effectiveTier === 'deep' && result.pillars) {
                const vCount = Object.values(result.pillars).filter((p: any) => p.violation === true).length;
                const totalPillars = Object.keys(result.pillars).length;
                let overrideScore: number | null = null;

                if (vCount === 0) {
                    // No violations — score must be 80-100
                    if (result.score < 80) overrideScore = 85;
                } else if (vCount === 1) {
                    // 1 violation — score 40-60
                    if (result.score > 60 || result.score < 40) overrideScore = 50;
                } else if (vCount === 2) {
                    // 2 violations — score 25-45
                    if (result.score > 45 || result.score < 25) overrideScore = 35;
                } else if (vCount <= 4) {
                    // 3-4 violations — score 15-24
                    if (result.score > 24 || result.score < 15) overrideScore = Math.max(15, 25 - vCount * 3);
                } else {
                    // 5-6 violations — score 15-19 (avoids single/low-double digits that look broken)
                    if (result.score > 19 || result.score < 15) overrideScore = 15;
                }

                if (overrideScore !== null) {
                    console.log(`[TLDR Shield] [${requestId}] Score override: LLM=${result.score} → ${overrideScore} (${vCount}/${totalPillars} violations)`);
                    result.score = overrideScore;
                }
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
            setCacheEntry(hash, result, sourceUrlHash);
            setSharedCache(hash, result, effectiveTier, sourceUrlHash);
            void saveScanRecord(uid, result, {
                url: normalizedSourceUrl,
                tier: effectiveTier,
                requestId,
                modelId: model.id,
                cached: false,
                latencyMs,
            });
            shouldRefund = false;
            res.end();

        } catch (error: any) {
            // FIX #10: Clean, user-friendly error messages — no raw API errors exposed
            console.error(`[TLDR Shield] [${requestId}] Analysis error:`, error?.status ?? '', error?.message ?? error);
            // Deep-scan reliability mode:
            // If LLM parsing/timing fails, return a deterministic structured result so parse rate stays high.
            if (effectiveTier === 'deep' && !clientDisconnected && !res.writableEnded) {
                const fallbackReason = error?.message ? String(error.message) : String(error);
                const fallbackResult = buildDeterministicDeepFallback(processedText, darkPatterns ?? false, fallbackReason);
                const latencyMs = Date.now() - analysisStart;

                let creditsLeft = creditResult.creditsLeft;
                if (shouldRefund) {
                    const refunded = await refundCredits(uid, cost);
                    creditsLeft = typeof refunded === 'number' ? refunded : creditsLeft;
                    console.warn(`[TLDR Shield] [${requestId}] Refunded ${cost} credits after degraded fallback. New balance=${refunded ?? 'unknown'}`);
                }
                shouldRefund = false;

                const finalFallback = {
                    ...fallbackResult,
                    truncated: wasTruncated,
                    truncatedPercent,
                    chunked: processedText.length > CHUNK_THRESHOLD,
                    chunkCount: chunkText(processedText).length,
                    latencyMs,
                    model: `${model.id}:fallback`,
                    requestId,
                    creditsLeft,
                    degraded: true,
                };
                sendUpdate({ ...finalFallback, status: 'Complete', cached: false });
                void saveScanRecord(uid, fallbackResult, {
                    url: normalizedSourceUrl,
                    tier: effectiveTier,
                    requestId,
                    modelId: `${model.id}:fallback`,
                    cached: false,
                    latencyMs,
                });
                res.end();
                return;
            }

            if (shouldRefund) {
                const refunded = await refundCredits(uid, cost);
                console.warn(`[TLDR Shield] [${requestId}] Refunded ${cost} credits after failed scan. New balance=${refunded ?? 'unknown'}`);
            }
            // If the client disconnected, nothing to send.
            if (clientDisconnected || res.writableEnded) return;

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
