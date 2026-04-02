import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

dotenv.config();

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

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("[eval] Missing NIM keys. Set NIM_API_KEY_1 (and optionally _2/_3).");
  process.exit(1);
}

const DEFAULT_QUICK_MODEL_ID = "meta/llama-3.3-70b-instruct";
const DEFAULT_DEEP_MODEL_ID = "meta/llama-3.3-70b-instruct";
const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || DEFAULT_QUICK_MODEL_ID).trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || DEFAULT_DEEP_MODEL_ID).trim();

const MODELS: Record<Tier, { id: string; maxTokens: number; temperature: number; timeoutMs: number }> = {
  quick: { id: QUICK_MODEL_ID, maxTokens: 750, temperature: 0.2, timeoutMs: 28000 },
  deep: { id: DEEP_MODEL_ID, maxTokens: 900, temperature: 0.2, timeoutMs: 45000 },
};

let nimKeyIndex = 0;
const PER_KEY_TIMEOUT_MS = 18000;

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
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
      return await client.chat.completions.create(params, { signal: keyController.signal });
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (signal.aborted) throw err;
      console.warn(`[eval] Key attempt ${attempt + 1} failed (status=${status}). Trying next key...`);
    } finally {
      clearTimeout(keyTimeout);
      signal.removeEventListener("abort", globalAbortHandler);
    }
  }
  throw lastError;
}

function extractJSON(text: string): any | null {
  const candidates = [text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), text.trim()];

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
    const darkPillarQ = darkPatterns ? " dark_patterns: manipulative/deceptive language?" : "";
    return `Privacy attorney. Analyze legal text for 5 violations: ai_training (AI training without opt-out?), data_selling (selling data to third parties?), transparency (deliberately vague language?), data_retention (retention over 1 year post-deletion?), content_ownership (overly broad IP claim?).${darkPillarQ}
Score rules: 0 violations+clear→90-100 SAFE. 0 violations+vague→75-89 OKAY. 1 low→50-74 OKAY. 1 high or 2→25-49 RISKY. 3+→0-24 RISKY. Score<50 = RISKY. Score 50-74 = OKAY. Score 75+= SAFE/OKAY.
For citation: ${eli5 ? "plain-English ELI5 explanation" : 'short supporting snippet (max 20 words) without quotes, or "Not addressed."'}
Output ONLY valid JSON no markdown:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2 sentence summary","pillars":{"ai_training":{"violation":bool,"citation":"string"},"data_selling":{"violation":bool,"citation":"string"},"transparency":{"violation":bool,"citation":"string"},"data_retention":{"violation":bool,"citation":"string"},"content_ownership":{"violation":bool,"citation":"string"}${darkField}}}`;
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
2. data_selling     — Personal data shared or sold to third parties for their own commercial use?
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices?
4. data_retention   — Deletion rights denied, or retention exceeds 1 year post-account-deletion?
5. content_ownership — Broad IP rights claimed over user content beyond what is needed to operate the service?${darkPillar}

VIOLATION RULES:
- Mark violation=true ONLY with CLEAR, EXPLICIT evidence. Absence of a clause ≠ violation.
- transparency: ONLY true if language is actively misleading. Clear, concise policies = no violation.
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year = violation.
- content_ownership: "license to display to users" = no violation. "perpetual irrevocable worldwide license beyond platform use" = violation.

SCORING:
- 0 violations, clear language   → score 90-100, rating "SAFE"
- 0 violations, minor vagueness  → score 75-89,  rating "OKAY"
- 1 low-severity violation       → score 50-74,  rating "OKAY"
- 1 high-severity or 2 violations → score 25-49, rating "RISKY"
- 3+ violations                  → score 0-24,   rating "RISKY"

MANDATORY: score<50 → rating "RISKY". score 50-74 → rating "OKAY". score 75+ → "SAFE" or "OKAY".

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

function scoreAccuracy(pred: any, expected: Expected, includeDark: boolean): { ok: number; total: number; ratingOk: boolean } {
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
  const ratingOk = pred?.rating === expected.rating;
  return { ok, total, ratingOk };
}

function normalizeRatingByScore(result: any): any {
  if (!result || typeof result.score !== "number" || typeof result.rating !== "string") return result;

  // Mirror server.ts consistency enforcement so eval rating matches production behavior.
  if (result.score < 50) result.rating = "RISKY";
  else if (result.score < 75) result.rating = result.rating === "SAFE" ? "OKAY" : result.rating;
  else if (result.score >= 75 && result.rating === "RISKY") result.rating = "OKAY";

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

  for (const row of rows) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), model.timeoutMs);
    const start = Date.now();
    try {
      const resp = await nimCreateWithRetry(
        {
          model: model.id,
          messages: [
            { role: "system", content: buildSystemPrompt(false, darkPatterns, tier) },
            { role: "user", content: `Analyze this legal document:\n\n${row.text}` },
          ],
          temperature: model.temperature,
          max_tokens: model.maxTokens,
        },
        controller.signal
      );
      const content = resp.choices[0]?.message?.content || "{}";
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
      const { ok, total, ratingOk } = scoreAccuracy(normalized, row.expected, darkPatterns);
      pillarOk += ok;
      pillarTotal += total;
      if (ratingOk) ratingOkCount++;
      perCase.push({
        id: row.id,
        parseOk: true,
        latencyMs: elapsed,
        expected: row.expected,
        predicted: { rating: normalized?.rating, score: normalized?.score, pillars: normalized?.pillars },
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

  const datasetPath = path.join(process.cwd(), "eval", "dataset.jsonl");
  const lines = fs.readFileSync(datasetPath, "utf8").split(/\r?\n/).filter(Boolean);
  const rows: DatasetRow[] = lines.map((l) => JSON.parse(l));

  const tiers: Tier[] = tierArg ? [tierArg] : ["quick", "deep"];

  console.log(`[eval] Using models: quick=${QUICK_MODEL_ID} deep=${DEEP_MODEL_ID}`);
  console.log(`[eval] Dataset: ${rows.length} cases | darkPatterns=${darkPatterns}`);

  for (const t of tiers) {
    const res = await runTier(t, rows, darkPatterns);
    console.log(JSON.stringify(res, null, 2));
  }
}

main().catch((e) => {
  console.error("[eval] fatal:", e);
  process.exit(1);
});
