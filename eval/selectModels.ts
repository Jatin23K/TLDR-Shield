import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

dotenv.config();

type Tier = "quick" | "deep";
type Rating = "SAFE" | "OKAY" | "RISKY";

type DatasetRow = {
  id: string;
  text: string;
  expected: {
    rating: Rating;
    pillars: Record<string, boolean>;
  };
};

type ModelResult = {
  model: string;
  tier: Tier;
  samples: number;
  parseRatePct: number;
  ratingAccPct: number;
  pillarAccPct: number | null;
  avgLatencySec: number;
  p90LatencySec: number;
  withinLatencyTarget: boolean;
  eligible: boolean;
};

const QUICK_LATENCY_TARGET_SEC = 10;
const DEEP_LATENCY_TARGET_SEC = 20;

const QUICK_CANDIDATES = [
  "microsoft/phi-4-mini-flash-reasoning",
  "deepseek-ai/deepseek-r1-distill-llama-8b",
  "deepseek-ai/deepseek-r1-distill-qwen-14b",
  "qwen/qwq-32b",
];

const DEEP_CANDIDATES = [
  "deepseek-ai/deepseek-v3.2",
  "qwen/qwen3-next-80b-a3b-thinking",
  "moonshotai/kimi-k2-thinking",
  "openai/gpt-oss-120b",
];

const CASE_IDS = new Set([
  "t1_safe_clear",
  "t2_ai_training_no_optout",
  "t3_data_selling_brokers",
  "t5_retention_over_1y",
  "t6_content_ownership_perpetual",
  "t7_dark_pattern_pressure",
  "t8_multiple_violations",
]);

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("[select-models] Missing NIM_API_KEY_1..3 in .env");
  process.exit(1);
}

let nimKeyIndex = 0;
const PER_KEY_TIMEOUT_MS = 15000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function normalizeRatingByScore(result: any): any {
  if (!result || typeof result.score !== "number" || typeof result.rating !== "string") return result;
  if (result.score < 50) result.rating = "RISKY";
  else if (result.score < 75) result.rating = result.rating === "SAFE" ? "OKAY" : result.rating;
  else if (result.score >= 75 && result.rating === "RISKY") result.rating = "OKAY";
  return result;
}

function extractJSON(text: string): any | null {
  const clean = (src: string) =>
    src.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const normalize = (raw: string) => raw.replace(/,\s*([}\]])/g, "$1");
  const tryParse = (raw: string): any | null => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const findOutermostObject = (src: string): string | null => {
    const start = src.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
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
    if (parsed && typeof parsed === "object") {
      if (parsed.pillars) {
        for (const key of Object.keys(parsed.pillars)) {
          const p = parsed.pillars[key];
          if (p && typeof p.violation === "string") {
            p.violation = p.violation.toLowerCase() === "true";
          }
        }
      }
      return parsed;
    }
  }

  return null;
}

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
  let lastError: any;
  for (let attempt = 0; attempt < NIM_KEYS.length; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
    nimKeyIndex++;
    const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });
    const keyController = new AbortController();
    const keyTimeout = setTimeout(() => keyController.abort(), PER_KEY_TIMEOUT_MS);
    const onAbort = () => keyController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await client.chat.completions.create(params, { signal: keyController.signal });
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (signal.aborted) throw err;
    } finally {
      clearTimeout(keyTimeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

function buildSystemPrompt(tier: Tier): string {
  if (tier === "quick") {
    return `You are a privacy attorney giving an instant verdict. Be STRICT. Scan for: ai_training (ANY mention of AI/ML training using user content = violation), data_selling (content/data shared with advertisers or third-party companies = violation), transparency (deliberately vague/obscuring language?), data_retention (retention >1yr post-deletion or completely unspecified?), content_ownership (worldwide sublicensable license "for any purpose" beyond platform use = violation), dark_patterns (liability cap under $1000 OR class action waiver OR shortened statute of limitations OR forced arbitration?).

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;
  }

  return `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

Analyze the legal text against these privacy pillars:
1. ai_training — User content or data used for AI/ML model training, fine-tuning, or improvement.
2. data_selling — Content or personal data shared with third parties, advertisers, partners, or other companies beyond what is needed to operate the service.
3. transparency — Language deliberately vague, contradictory, or designed to obscure practices.
4. data_retention — No stated deletion timeline, or retention exceeds 1 year post-account-deletion.
5. content_ownership — Broad IP rights beyond what is needed to show the user's content on the platform.
6. dark_patterns — Tiny liability caps, class action waivers, forced arbitration, shortened statutes of limitations, or similarly unfair legal clauses.

VIOLATION RULES:
- ai_training: ANY mention of using user content/data for AI or ML training = VIOLATION.
- data_selling: Sharing with advertisers, partners, or other companies for their commercial benefit = VIOLATION.
- content_ownership: "for any purpose" or sublicensable worldwide license beyond platform use = VIOLATION.
- dark_patterns: $100-style liability cap, class action waiver, shortened statute, or forced arbitration = VIOLATION.
- transparency: ONLY true if language is actively misleading.
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year or completely unspecified = violation.

SCORING:
- 0 violations, clear language → 90-100 SAFE
- 0 violations, minor vagueness → 75-89 OKAY
- 1 low-severity violation → 50-74 OKAY
- 1 high-severity or 2 violations → 25-49 RISKY
- 3-4 violations → 10-24 RISKY
- 5-6 violations → 0-9 RISKY

MANDATORY: score<50 => RISKY. score 50-74 => OKAY. score≥75 => SAFE or OKAY.

EVIDENCE REQUIREMENT:
Default to violation:false for every pillar. Set violation:true only if you can quote the document.

Output ONLY valid JSON:
{
  "rating":"SAFE"|"OKAY"|"RISKY",
  "score":0-100,
  "tldr":"2-3 sentence summary",
  "pillars":{
    "ai_training":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "data_selling":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "transparency":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "data_retention":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "content_ownership":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "dark_patterns":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"}
  }
}`;
}

async function runCase(model: string, tier: Tier, row: DatasetRow) {
  const controller = new AbortController();
  const timeoutMs = tier === "quick" ? 30000 : 45000;
  const maxTokens = tier === "quick" ? 120 : 1400;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await nimCreateWithRetry({
      model,
      messages: [
        { role: "system", content: buildSystemPrompt(tier) },
        { role: "user", content: `Analyze this legal document:\n\n${row.text}` },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    }, controller.signal);
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = normalizeRatingByScore(extractJSON(raw));
    return { latencyMs: Date.now() - start, parsed };
  } finally {
    clearTimeout(timeout);
  }
}

async function benchmarkModel(model: string, tier: Tier, rows: DatasetRow[]): Promise<ModelResult> {
  const latencies: number[] = [];
  let parseOk = 0;
  let ratingOk = 0;
  let pillarOk = 0;
  let pillarTotal = 0;

  for (const row of rows) {
    try {
      const { latencyMs, parsed } = await runCase(model, tier, row);
      latencies.push(latencyMs);
      if (!parsed) continue;
      parseOk++;
      if (parsed.rating === row.expected.rating) ratingOk++;

      if (tier === "deep" && parsed.pillars) {
        for (const [pillar, expected] of Object.entries(row.expected.pillars)) {
          const got = Boolean(parsed.pillars?.[pillar]?.violation);
          pillarTotal++;
          if (got === expected) pillarOk++;
        }
      }
    } catch {
      latencies.push(tier === "quick" ? 30000 : 45000);
    }
  }

  const avgLatencySec = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length) / 1000;
  const p90LatencySec = percentile(latencies, 90) / 1000;
  const threshold = tier === "quick" ? QUICK_LATENCY_TARGET_SEC : DEEP_LATENCY_TARGET_SEC;
  const parseRatePct = (parseOk / rows.length) * 100;
  const ratingAccPct = (ratingOk / rows.length) * 100;
  const pillarAccPct = tier === "deep" ? (pillarOk / Math.max(1, pillarTotal)) * 100 : null;
  const withinLatencyTarget = avgLatencySec <= threshold;
  const eligible = tier === "quick"
    ? withinLatencyTarget && parseRatePct >= 80
    : withinLatencyTarget && parseRatePct >= 80;

  return {
    model,
    tier,
    samples: rows.length,
    parseRatePct: Number(parseRatePct.toFixed(1)),
    ratingAccPct: Number(ratingAccPct.toFixed(1)),
    pillarAccPct: pillarAccPct == null ? null : Number(pillarAccPct.toFixed(1)),
    avgLatencySec: Number(avgLatencySec.toFixed(2)),
    p90LatencySec: Number(p90LatencySec.toFixed(2)),
    withinLatencyTarget,
    eligible,
  };
}

function rankResults(results: ModelResult[]): ModelResult[] {
  return [...results].sort((a, b) => {
    if (a.tier === "quick") {
      if (b.eligible !== a.eligible) return Number(b.eligible) - Number(a.eligible);
      if (b.ratingAccPct !== a.ratingAccPct) return b.ratingAccPct - a.ratingAccPct;
      if (b.parseRatePct !== a.parseRatePct) return b.parseRatePct - a.parseRatePct;
      return a.avgLatencySec - b.avgLatencySec;
    }

    const aQuality = (a.pillarAccPct ?? 0) * 0.7 + a.ratingAccPct * 0.3;
    const bQuality = (b.pillarAccPct ?? 0) * 0.7 + b.ratingAccPct * 0.3;
    if (b.eligible !== a.eligible) return Number(b.eligible) - Number(a.eligible);
    if (bQuality !== aQuality) return bQuality - aQuality;
    if (b.parseRatePct !== a.parseRatePct) return b.parseRatePct - a.parseRatePct;
    return a.avgLatencySec - b.avgLatencySec;
  });
}

function printTierResults(title: string, results: ModelResult[]) {
  console.log(`\n=== ${title} ===`);
  for (const r of results) {
    const pillar = r.pillarAccPct == null ? "n/a" : `${r.pillarAccPct.toFixed(1)}%`;
    console.log(
      `${r.eligible ? "PASS" : "WARN"}  ${r.model}\n` +
      `  latency avg=${r.avgLatencySec}s p90=${r.p90LatencySec}s | parse=${r.parseRatePct}% | rating=${r.ratingAccPct}% | pillars=${pillar}`
    );
  }
}

async function main() {
  const datasetPath = path.join(process.cwd(), "eval", "dataset.jsonl");
  const allRows: DatasetRow[] = fs.readFileSync(datasetPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row: DatasetRow) => CASE_IDS.has(row.id));

  console.log("[select-models] Candidate models are filtered from the models accessible to your current NIM key.");
  console.log(`[select-models] Benchmark cases: ${allRows.map(r => r.id).join(", ")}`);

  const quickResults: ModelResult[] = [];
  for (const model of QUICK_CANDIDATES) {
    console.log(`\n[quick] ${model}`);
    quickResults.push(await benchmarkModel(model, "quick", allRows));
  }

  const deepResults: ModelResult[] = [];
  for (const model of DEEP_CANDIDATES) {
    console.log(`\n[deep] ${model}`);
    deepResults.push(await benchmarkModel(model, "deep", allRows));
  }

  const rankedQuick = rankResults(quickResults);
  const rankedDeep = rankResults(deepResults);

  printTierResults("BASIC SCAN RANKING", rankedQuick);
  printTierResults("DEEP SCAN RANKING", rankedDeep);

  const summary = {
    bestQuick: rankedQuick[0] ?? null,
    bestDeep: rankedDeep[0] ?? null,
    quickTop: rankedQuick.slice(0, 3),
    deepTop: rankedDeep.slice(0, 3),
  };

  console.log("\n=== SUMMARY JSON ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[select-models] fatal:", err);
  process.exit(1);
});
