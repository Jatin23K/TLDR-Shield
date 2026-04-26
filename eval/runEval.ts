import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Override=true so .env wins over any pre-set shell env (fixes cases where
// PowerShell has GEMINI_API_KEY="" lingering from a prior session).
dotenv.config({ override: true });

type Tier = "quick" | "deep";

type Pillars = {
  ai_training: boolean;
  data_selling: boolean;
  transparency: boolean;
  data_retention: boolean;
  content_ownership: boolean;
  dark_patterns?: boolean;
};

type Expected = {
  rating: "SAFE" | "OKAY" | "RISKY";
  pillars: Pillars;
};

type DatasetRow = {
  id: string;
  text: string;
  expected: Expected;
};

// ─── LLM Backend: Gemini (preferred) or NIM fallback ────────────────────────
// Gemini config comes from ./geminiConfig — single source of truth.
// To switch models/keys: edit .env, no code change.
// NOTE: GEMINI_BASE and GEMINI_MODEL_PRIMARY are safe to import (strings, no env read at module init).
// GEMINI_KEYS must be re-read HERE after dotenv.config() because ESM hoisting
// causes geminiConfig.ts to evaluate before dotenv runs — so the exported
// GEMINI_KEYS constant is always empty. We rebuild from process.env instead.
import { GEMINI_BASE, describeConfig as describeGeminiConfig } from './geminiConfig.js';
import { PILLAR_PENALTY, calculateScoreAndRating, computeScoreFromPillars } from '../shared/scoring.js';

// Re-derive keys after dotenv.config() has run
const GEMINI_KEYS: string[] = (process.env.GEMINI_API_KEYS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean).length > 0
    ? (process.env.GEMINI_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    : ([
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY_4,
        process.env.GEMINI_API_KEY_5,
      ].filter((k): k is string => Boolean(k?.trim())).map(k => k.trim()));

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

const USE_GEMINI = GEMINI_KEYS.length > 0;

if (!USE_GEMINI && NIM_KEYS.length === 0) {
  console.error("[eval] Missing API keys. Set GEMINI_API_KEYS (preferred) or NIM_API_KEY_1.");
  process.exit(1);
}

// Read model from env AFTER dotenv — avoids ESM hoist issue same as GEMINI_KEYS
const GEMINI_MODEL = (process.env.GEMINI_MODEL_PRIMARY || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();

console.log(`[eval] LLM backend: ${USE_GEMINI ? describeGeminiConfig() : 'NIM (fallback)'}`);
// Loud stderr banner so backend is visible even when stdout is redirected.
process.stderr.write(`[eval] backend=${USE_GEMINI ? 'GEMINI' : 'NIM'} | gemini_keys=${GEMINI_KEYS.length} | nim_keys=${NIM_KEYS.length}\n`);

// ─── Gemini call (native fetch) ───────────────────────────────────────────────
async function callGeminiEval(
  systemPrompt: string,
  userText: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  let lastError: Error = new Error('No Gemini keys configured');
  for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
    const apiKey = GEMINI_KEYS[keyIdx];
    const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 429 || res.status === 503) {
        lastError = new Error(`Gemini key ${keyIdx + 1} HTTP ${res.status}`);
        console.warn(`[eval] Gemini key ${keyIdx + 1}/${GEMINI_KEYS.length} returned ${res.status} — waiting 2s then trying next key`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) {
        const preview = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${preview.slice(0, 200)}`);
      }
      const json: any = await res.json();
      const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      const text: string = parts.filter((p: any) => !p.thought).pop()?.text ?? '{}';
      return text;
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError') throw new Error('Gemini request timed out');
      throw err;
    }
  }
  throw lastError;
}

// ─── NIM fallback call ────────────────────────────────────────────────────────
let nimKeyIndex = 0;
const PER_KEY_TIMEOUT_MS = 18000;

async function callNimEval(params: any, signal: AbortSignal): Promise<string> {
  const { default: OpenAI } = await import('openai');
  let lastError: any;
  for (let attempt = 0; attempt < NIM_KEYS.length; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
    nimKeyIndex++;
    const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });

    const keyController = new AbortController();
    const keyTimeout = setTimeout(() => keyController.abort(), PER_KEY_TIMEOUT_MS);
    const globalAbortHandler = () => keyController.abort();
    signal.addEventListener("abort", globalAbortHandler, { once: true });

    try {
      const resp = await client.chat.completions.create(params, { signal: keyController.signal });
      return resp.choices[0]?.message?.content || "{}";
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (signal.aborted) throw err;
      console.warn(`[eval] NIM key attempt ${attempt + 1} failed (status=${status}). Trying next key...`);
    } finally {
      clearTimeout(keyTimeout);
      signal.removeEventListener("abort", globalAbortHandler);
    }
  }
  throw lastError;
}

// ─── Model config ─────────────────────────────────────────────────────────────
const DEFAULT_QUICK_MODEL_ID = "meta/llama-3.3-70b-instruct";
const DEFAULT_DEEP_MODEL_ID = "meta/llama-3.3-70b-instruct";
const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || DEFAULT_QUICK_MODEL_ID).trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || DEFAULT_DEEP_MODEL_ID).trim();

// Nemotron's <think> blocks take 60-150s at 3500 tokens — far beyond the 45s timeout.
// Both tiers override to llama when nemotron is detected, matching Cloud Run production
// defaults where NIM_MODEL_QUICK/DEEP are not set.
const quickIsNemotron = QUICK_MODEL_ID.includes("nemotron");
const deepIsNemotron  = DEEP_MODEL_ID.includes("nemotron");
const QUICK_MODEL_EVAL = quickIsNemotron ? DEFAULT_QUICK_MODEL_ID : QUICK_MODEL_ID;
const DEEP_MODEL_EVAL  = deepIsNemotron  ? DEFAULT_DEEP_MODEL_ID  : DEEP_MODEL_ID;
if (quickIsNemotron) console.warn(`[eval] Quick tier: overriding ${QUICK_MODEL_ID} → ${QUICK_MODEL_EVAL} (nemotron incompatible with quick budget)`);
if (deepIsNemotron)  console.warn(`[eval] Deep tier:  overriding ${DEEP_MODEL_ID}  → ${DEEP_MODEL_EVAL}  (nemotron exceeds 45s timeout at 3500 tokens)`);

const QUICK_MAX_TOKENS = parseInt(process.env.NIM_MAX_TOKENS_QUICK || '350', 10);
const DEEP_MAX_TOKENS  = parseInt(process.env.NIM_MAX_TOKENS_DEEP  || '3500', 10);

const MODELS: Record<Tier, { id: string; maxTokens: number; temperature: number; timeoutMs: number }> = {
  quick: { id: USE_GEMINI ? GEMINI_MODEL : QUICK_MODEL_EVAL, maxTokens: QUICK_MAX_TOKENS, temperature: 0.2, timeoutMs: 20000 },
  deep:  { id: USE_GEMINI ? GEMINI_MODEL : DEEP_MODEL_EVAL,  maxTokens: DEEP_MAX_TOKENS,  temperature: 0.2, timeoutMs: 45000 },
};

function extractJSON(text: string): any | null {
  const candidates = [
    text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "").trim(),
    text.trim(),
  ];

  const tryParse = (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const normalize = (raw: string) => {
    return raw
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();
  };

  for (const src of candidates) {
    const s = src.indexOf("{");
    const e = src.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) continue;

    const candidate = src.substring(s, e + 1);
    const parsed = tryParse(candidate) ?? tryParse(normalize(candidate));
    if (parsed) return parsed;
  }

  return null;
}

function buildSystemPrompt(eli5: boolean, darkPatterns: boolean, tier: Tier): string {
  const darkField = darkPatterns ? ',\n        "dark_patterns": { "violation": boolean, "citation": "string" }' : "";

  if (tier === "quick") {
    // Quick tier matches production: badge-only verdict, NO pillars in output.
    // Pillar breakdown is deep-tier only. 120 max_tokens fits rating+score+tldr comfortably.
    const darkPillarQ = darkPatterns ? " dark_patterns: manipulative/deceptive language?" : "";
    return `Privacy attorney. Analyze legal text for 5 violations: ai_training (AI training without opt-out?), data_selling (data sold/shared WITH named third parties like advertisers or brokers — NOT first-party internal use), transparency (self-contradictory or deliberately obscuring language — explicit contradiction = HIGH severity = RISKY), data_retention (retention over 1 year post-deletion? — tax/regulatory reasons do NOT exempt), content_ownership (overly broad IP claim?).${darkPillarQ}
Score rules: Each violation deducts points (dark_patterns=-40, transparency=-20, others=-30; LOW confidence = half penalty). 0 violations→90-100 SAFE. 1 low violation→50-89 OKAY. 2+ violations OR dark_patterns→RISKY. Score<50=RISKY. Score 50-89=OKAY. Score 90+=SAFE.
Output ONLY valid JSON no markdown, no pillars:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2 sentence verdict. Name the biggest risk if any."}`;
  }

  const citationInstruction = eli5
    ? "For 'citation': write a plain-English ELI5 explanation (no legal jargon) of what the policy says about this pillar."
    : "For 'citation': copy the EXACT verbatim sentence(s) from the document. Do NOT paraphrase. If nothing is stated, write 'Not addressed in document.'";

  const darkPillar = darkPatterns
    ? "\n6. dark_patterns — Manipulative language, confusing opt-out flows, pre-ticked consent boxes, or deceptive framing."
    : "";

  return `You are a senior privacy attorney and data protection expert.

Analyze the legal text against these privacy pillars:
1. ai_training      — Data used for AI/ML training WITHOUT a simple, accessible opt-out?
2. data_selling     — Personal data explicitly shared with or sold to named THIRD PARTIES (advertisers, data brokers, marketing partners, other companies) for their own commercial benefit. NOT a violation: first-party "business purposes", internal analytics, or operating the service itself. Explicit third-party recipient MUST appear in the text.
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices?
4. data_retention   — Deletion rights denied, or retention exceeds 1 year post-account-deletion? IMPORTANT: regulatory/tax/legal justifications do NOT exempt — "7 years for tax compliance" is still a violation.
5. content_ownership — Broad IP rights claimed over user content beyond what is needed to operate the service? VIOLATION: "for any purpose", "sublicensable worldwide license", "modify/adapt/redistribute". NOT a violation: "non-exclusive license to host and display on our platform" or "license scoped to operating the service" — those are required for the service to function.${darkPillar}

VIOLATION RULES:
- Mark violation=true ONLY with CLEAR, EXPLICIT evidence. Absence of a clause ≠ violation.
- transparency: ONLY true if language is actively misleading. Clear, concise policies = no violation.
  SEVERITY: Self-contradictory text (policy claims minimal data use in one sentence then permits unlimited use in the next, e.g. "we only collect what we need" immediately followed by "we may also collect any information for any business purpose") = HIGH severity → score 25-49 → RISKY. Merely vague but non-contradictory language = LOW severity → score 50-74 → OKAY.
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year = violation, REGARDLESS of stated reason. Tax/regulatory/legal/compliance justifications do NOT create exemptions. "We retain data 7 years for tax purposes" = violation just like "7 years, no reason given".
- content_ownership: "license to display to users" = no violation. "perpetual irrevocable worldwide license beyond platform use" = violation.
SCORING (the system computes final score from your pillar flags — do NOT calculate it yourself):
Penalty per violation: ai_training/data_selling/data_retention/content_ownership = -30 (HIGH/MEDIUM) or -15 (LOW).
dark_patterns = -40 (HIGH/MEDIUM) or -20 (LOW). transparency = -20 (HIGH/MEDIUM) or -5 (LOW).
Score < 50 = RISKY. Score 50-89 = OKAY. Score 90+ = SAFE.
MANDATORY: score<50 → rating "RISKY". score 50-89 → rating "OKAY". score 90+ → "SAFE".
SCORING EXCEPTION: If the text explicitly contains a class action waiver, forced individual arbitration removing class action options, or a statute of limitations under 2 years — set dark_patterns violation:true.

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
    "content_ownership": { "violation": boolean, "citation": "string" }${darkPatterns ? ',\n    "dark_patterns":    { "violation": boolean, "citation": "string" }' : ""}
  }
}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function scoreAccuracy(
  pred: any,
  expected: Expected,
  includeDark: boolean,
  skipPillars = false,
): { ok: number; total: number; ratingOk: boolean } {
  const ratingOk = pred?.rating === expected.rating;

  // Quick tier: badge-only (no pillar output). Only rating is measured.
  if (skipPillars) return { ok: 0, total: 0, ratingOk };

  const predPillars = pred?.pillars || {};
  const keys: (keyof Pillars)[] = ["ai_training", "data_selling", "transparency", "data_retention", "content_ownership"];
  if (includeDark) keys.push("dark_patterns");

  let ok = 0;
  let total = 0;
  for (const k of keys) {
    const exp = (expected.pillars as any)[k];
    if (typeof exp !== "boolean") continue;
    const pv = Boolean(predPillars?.[k]?.violation);
    total++;
    if (pv === exp) ok++;
  }
  return { ok, total, ratingOk };
}

// PILLAR_PENALTY, calculateScoreAndRating, and computeScoreFromPillars are imported from
// shared/scoring.ts — SINGLE SOURCE OF TRUTH. Do NOT redefine them here.
// See: import { PILLAR_PENALTY, calculateScoreAndRating, computeScoreFromPillars } from '../shared/scoring.js';

function normalizeRatingByScore(result: any): any {
  if (!result || typeof result.rating !== "string") return result;

  // For deep-tier results (pillars present): compute server-equivalent score from violations.
  // The server always overrides the LLM's self-reported score with calculateScoreAndRating.
  const computedScore = computeScoreFromPillars(result.pillars);
  const effectiveScore = computedScore !== null ? computedScore : result.score;

  if (typeof effectiveScore !== "number") return result;

  if (computedScore !== null) {
    // Deep tier (pillars available): fully replace rating, mirroring server.ts calculateScoreAndRating.
    // The server always overwrites the LLM's self-reported rating with the score-derived value.
    if (computedScore < 50) result.rating = "RISKY";
    else if (computedScore < 90) result.rating = "OKAY";
    else result.rating = "SAFE";
    result.serverScore = computedScore;
  } else {
    // Quick tier (no pillars): only fix obvious inconsistencies in the LLM's self-reported score.
    if (effectiveScore < 50) result.rating = "RISKY";
    else if (effectiveScore < 90) {
      if (result.rating === "SAFE") result.rating = "OKAY";
    } else {
      if (result.rating === "RISKY") result.rating = "OKAY";
    }
  }

  return result;
}

async function runTier(tier: Tier, rows: DatasetRow[], darkPatterns: boolean) {
  const model = MODELS[tier];
  const latencies: number[] = [];
  let pillarOk = 0;
  let pillarTotal = 0;
  let ratingOkCount = 0;
  let parseFails = 0;
  const perCase: Array<any> = [];

  // Inter-case delay: prevents 429 bursts when running 30 cases back-to-back.
  // Gemini free tier: 30 RPM = 1 req/2s → use 2100ms to be safe.
  // NIM fallback: Deep needs 2s, Quick needs 500ms.
  const INTER_CASE_DELAY_MS = USE_GEMINI ? 2100 : (tier === 'deep' ? 2000 : 500);

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    if (rowIdx > 0) await new Promise(r => setTimeout(r, INTER_CASE_DELAY_MS));
    const row = rows[rowIdx];
    // Progress bar to stderr — survives stdout redirect, stays off the JSON report
    const pct = Math.round(((rowIdx + 1) / rows.length) * 100);
    const filled = Math.round((pct / 100) * 24);
    const bar = '█'.repeat(filled) + '░'.repeat(24 - filled);
    process.stderr.write(`\r[eval ${tier}] [${bar}] ${rowIdx + 1}/${rows.length} (${pct}%) — ${row.id}${' '.repeat(10)}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), model.timeoutMs);
    const start = Date.now();
    try {
      let content: string;
      const systemPrompt = buildSystemPrompt(false, darkPatterns, tier);
      const userText = `Analyze this legal document:\n\n${row.text}`;

      if (USE_GEMINI) {
        content = await callGeminiEval(systemPrompt, userText, model.maxTokens, model.timeoutMs);
      } else {
        content = await callNimEval(
          {
            model: model.id,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user",   content: userText },
            ],
            temperature: model.temperature,
            max_tokens: model.maxTokens,
          },
          controller.signal
        );
      }

      const parsed = extractJSON(content);
      const elapsed = Date.now() - start;
      latencies.push(elapsed);

      if (!parsed) {
        parseFails++;
        perCase.push({
          id: row.id,
          parseOk: false,
          latencyMs: elapsed,
          expected: row.expected,
          predicted: null,
        });
        continue;
      }

      const normalized = normalizeRatingByScore(parsed);
      const { ok, total, ratingOk } = scoreAccuracy(normalized, row.expected, darkPatterns, tier === "quick");
      pillarOk += ok;
      pillarTotal += total;
      if (ratingOk) ratingOkCount++;
      perCase.push({
        id: row.id,
        parseOk: true,
        latencyMs: elapsed,
        expected: row.expected,
        predicted: {
          rating: normalized?.rating,
          score: normalized?.score,
          serverScore: normalized?.serverScore,
          pillars: normalized?.pillars,
        },
        okPillars: { ok, total },
        ratingOk,
      });
    } catch (e: any) {
      const elapsed = Date.now() - start;
      latencies.push(elapsed);
      console.warn(`[eval] ${tier}:${row.id} failed:`, e?.status ?? "", e?.message ?? e);
      perCase.push({
        id: row.id,
        parseOk: false,
        latencyMs: elapsed,
        expected: row.expected,
        predicted: null,
        error: e?.message ?? String(e),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  process.stderr.write(`\n`);

  const pillarAcc = pillarTotal ? (pillarOk / pillarTotal) * 100 : 0;
  const ratingAcc = rows.length ? (ratingOkCount / rows.length) * 100 : 0;
  const p50 = percentile(latencies, 50);
  const p90 = percentile(latencies, 90);

  return {
    tier,
    model: model.id,
    samples: rows.length,
    darkPatterns,
    latencyMs: { p50, p90, min: Math.min(...latencies), max: Math.max(...latencies) },
    accuracy: { pillarsPct: pillarAcc, ratingPct: ratingAcc },
    parseFails,
    perCase,
  };
}

async function main() {
  const tierArg = (process.argv.find((a) => a.startsWith("--tier="))?.split("=")[1] as Tier | undefined) || undefined;
  const darkPatterns = process.argv.includes("--dark");

  const datasetArg = process.argv.find((a) => a.startsWith("--dataset="))?.split("=")[1];
  const datasetPath = datasetArg
    ? path.resolve(process.cwd(), datasetArg)
    : path.join(process.cwd(), "eval", "dataset.jsonl");
  console.log(`[eval] Dataset path: ${datasetPath}`);
  const lines = fs.readFileSync(datasetPath, "utf8").split(/\r?\n/).filter(Boolean);
  const rows: DatasetRow[] = lines.map((l) => JSON.parse(l));

  const tiers: Tier[] = tierArg ? [tierArg] : ["quick", "deep"];

  const backendLabel = USE_GEMINI ? `Gemini ${GEMINI_MODEL}` : `NIM quick=${QUICK_MODEL_ID} deep=${DEEP_MODEL_ID}`;
  console.log(`[eval] Using backend: ${backendLabel}`);
  console.log(`[eval] Dataset: ${rows.length} cases | darkPatterns=${darkPatterns}`);

  // Run all tiers simultaneously so wall-clock time = max(tier times) instead of sum.
  // Promise.allSettled ensures we always print whatever results we have, even if one tier errors.
  const tierResults = await Promise.allSettled(
    tiers.map((t) => runTier(t, rows, darkPatterns))
  );

  for (const outcome of tierResults) {
    if (outcome.status === "fulfilled") {
      console.log(JSON.stringify(outcome.value, null, 2));
    } else {
      console.error("[eval] tier failed:", outcome.reason);
    }
  }
}

main().catch((e) => {
  console.error("[eval] fatal:", e);
  process.exit(1);
});
