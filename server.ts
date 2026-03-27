import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import dotenv from "dotenv";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NIM API key pool — rotated on rate-limit or server errors
const NIM_KEYS = [
    process.env.NIM_API_KEY_1,
    process.env.NIM_API_KEY_2,
    process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

let nimKeyIndex = 0;

// FIX #2: Key failover — retries each key on 5xx / 429, throws on 4xx client errors
// Per-key timeout of 18s prevents a hung key from consuming the global timeout budget
const PER_KEY_TIMEOUT_MS = 18000;

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
    const response = await nimCreateWithRetry({
        model: model.id,
        messages: [
            { role: 'system', content: buildSystemPrompt(eli5, darkPatterns, tier) },
            {
                role: 'user',
                content: tier === 'quick'
                    // Quick: badge verdict per block — minimal context needed
                    ? `Legal document section ${chunkIndex + 1} of ${totalChunks}. Give an instant verdict:\n\n${chunk}`
                    // Deep: full analysis per block — extract every clause
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
    sendUpdate({ status: `Block ${chunkIndex + 1}/${totalChunks} analyzed...` });
    return result;
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
    });

    // FIX #14: Health check — no debug/internal data exposed publicly
    app.get("/health", (_req, res) => {
        res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
    });

    // FIX #6: /debug/models endpoint removed

    app.post("/api/analyze", analyzeRateLimit, async (req, res) => {
        const { text, tier, eli5, darkPatterns } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'No text provided.' });
        }

        // FIX #7: Minimum text check — reject meaningless inputs
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        if (wordCount < 20) {
            return res.status(400).json({
                error: 'Text is too short to analyze. Please paste at least a paragraph of the legal document.'
            });
        }

        // Multi-agent covers up to MAX_CHUNKS × CHUNK_SIZE chars; truncate beyond that
        const MAX_TOTAL = MAX_CHUNKS * CHUNK_SIZE; // 80 000 chars
        const wasTruncated = text.length > MAX_TOTAL;
        const truncatedPercent = wasTruncated ? Math.round((1 - MAX_TOTAL / text.length) * 100) : 0;
        const processedText = text.substring(0, MAX_TOTAL);

        const effectiveTier = tier === 'deep' ? 'deep' : 'quick';
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

        // Return cached result immediately
        if (analysisCache.has(hash)) {
            sendUpdate({
                ...analysisCache.get(hash),
                status: 'Complete',
                cached: true,
                truncated: wasTruncated,
                latencyMs: 0,
                model: model.id,
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

                    if (goodResults.length === 0) {
                        throw new Error('Failed to analyze document blocks. Please try again.');
                    }

                    // Agent 4: aggregate block verdicts into one final result
                    sendUpdate({ status: `Aggregating ${goodResults.length}/${chunks.length} blocks...` });
                    result = aggregateResults(goodResults, effectiveTier);

                    if (!result || typeof result.score !== 'number') {
                        throw new Error('Aggregation failed. Please try again.');
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
            // FIX #19: Include truncation % so UI can tell user how much was skipped
            const finalResult = { ...result, truncated: wasTruncated, truncatedPercent, chunked: isMultiChunk, chunkCount: chunks.length, latencyMs, model: model.id };
            sendUpdate({ ...finalResult, status: 'Complete', cached: false });
            setCacheEntry(hash, result);
            res.end();

        } catch (error: any) {
            // FIX #10: Clean, user-friendly error messages — no raw API errors exposed
            console.error('[TLDR Shield] Analysis error:', error?.status ?? '', error?.message ?? error);
            let userMessage: string;
            if (error.name === 'AbortError') {
                userMessage = 'Analysis timed out. Try a shorter document or switch to Basic Scan.';
            } else if (error?.status === 429) {
                userMessage = 'Rate limit reached. Please wait a moment and try again.';
            } else {
                userMessage = 'Analysis failed. Please try again.';
            }
            sendUpdate({ error: userMessage });
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
