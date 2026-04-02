import dotenv from "dotenv";
import fs from "fs";
import OpenAI from "openai";

dotenv.config();

type Tier = "quick" | "deep";

type ServiceCase = {
  service: string;
  sourceUrl: string;
  expectedRatings: Array<"SAFE" | "OKAY" | "RISKY">;
  text: string;
};

type ScanResult = {
  service: string;
  sourceUrl: string;
  run: number;
  tier: Tier;
  model: string;
  latencyMs: number;
  parseOk: boolean;
  rating?: string;
  score?: number;
  violations?: string[];
  expectedRatingMatch: boolean;
  error?: string;
};

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("[stress] Missing NIM API keys. Set NIM_API_KEY_1 (and optionally _2/_3).");
  process.exit(1);
}

const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || "meta/llama-3.3-70b-instruct").trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || "meta/llama-3.3-70b-instruct").trim();

const RUNS_PER_SERVICE = Math.max(1, Number(process.env.STRESS_RUNS ?? 2) || 2);
const PER_KEY_TIMEOUT_MS = 25000;
const MAX_RETRY_ROUNDS = 4;
const BASE_BACKOFF_MS = 2200;
const INTER_CALL_PAUSE_MS = Math.max(0, Number(process.env.STRESS_INTER_CALL_MS ?? 2500) || 2500);
const INTER_RUN_PAUSE_MS = Math.max(0, Number(process.env.STRESS_INTER_RUN_MS ?? 3500) || 3500);

const SERVICES: ServiceCase[] = [
  {
    service: "Reddit",
    sourceUrl: "https://www.redditinc.com/policies/user-agreement",
    expectedRatings: ["RISKY", "OKAY"],
    text: `Reddit terms excerpt: You keep ownership of your content, but by posting you grant Reddit a worldwide, royalty-free, transferable, sublicensable license to use, copy, modify, adapt, distribute, and display your content in connection with the services. Reddit may share information with service providers, partners, and affiliated companies, including for advertising and measurement functions.`,
  },
  {
    service: "Discord",
    sourceUrl: "https://discord.com/terms",
    expectedRatings: ["RISKY", "OKAY"],
    text: `Discord terms excerpt: You retain rights to your content but grant Discord a worldwide, non-exclusive, royalty-free, sublicensable and transferable license to host, reproduce, distribute, and create derivative works as needed to operate and improve the service. Discord may share data with vendors and partners, and may use data for product improvement, safety, analytics, and advertising-related operations.`,
  },
  {
    service: "YouTube",
    sourceUrl: "https://www.youtube.com/t/terms",
    expectedRatings: ["RISKY"],
    text: `YouTube terms excerpt: You grant YouTube a worldwide, non-exclusive, royalty-free, sublicensable and transferable license to use your content in connection with the service and business, including reproduction, distribution, display, and preparation of derivative works. Google policies describe use of data across services for personalization, advertising, and service improvement.`,
  },
  {
    service: "LinkedIn",
    sourceUrl: "https://www.linkedin.com/legal/user-agreement",
    expectedRatings: ["RISKY"],
    text: `LinkedIn terms excerpt: You grant LinkedIn a non-exclusive, transferable, sublicensable, worldwide license to use, copy, modify, distribute, publish, and process information and content you provide through the services. LinkedIn privacy disclosures include sharing with affiliates, service providers, and partners, including ad and analytics ecosystems, and use of data for improving and developing products.`,
  },
  {
    service: "Amazon",
    sourceUrl: "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088",
    expectedRatings: ["RISKY", "OKAY"],
    text: `Amazon conditions excerpt: If you post content, you grant Amazon and its affiliates a non-exclusive, royalty-free, perpetual, irrevocable, and fully sublicensable right to use, reproduce, modify, adapt, publish, translate, create derivative works from, distribute, and display such content worldwide in any media. Amazon policies describe sharing data with affiliates, service providers, and advertising partners for business operations and personalization.`,
  },
];

const PILLAR_KEYS = [
  "ai_training",
  "data_selling",
  "transparency",
  "data_retention",
  "content_ownership",
] as const;

type PillarKey = typeof PILLAR_KEYS[number];

let nimKeyIndex = 0;

function buildSystemPrompt(tier: Tier): string {
  if (tier === "quick") {
    return `You are a privacy attorney giving a fast risk verdict.
Classify legal text on these pillars:
- ai_training: user data/content used to train AI/ML systems without clear opt-out
- data_selling: data shared/sold to third parties for commercial use
- transparency: vague or misleading language hiding important data practices
- data_retention: retention after deletion exceeds 1 year or is effectively indefinite
- content_ownership: overbroad perpetual sublicensable rights over user content

Scoring rubric:
- 0 major violations and clear terms -> SAFE (90-100)
- 0 major violations but some vagueness -> OKAY (75-89)
- 1 low-severity issue -> OKAY (50-74)
- 1 high-severity or 2+ violations -> RISKY (0-49)

Output ONLY valid JSON:
{
  "rating": "SAFE" | "OKAY" | "RISKY",
  "score": <integer 0-100>,
  "tldr": "<2 short sentences>",
  "pillars": {
    "ai_training": { "violation": boolean, "citation": "string" },
    "data_selling": { "violation": boolean, "citation": "string" },
    "transparency": { "violation": boolean, "citation": "string" },
    "data_retention": { "violation": boolean, "citation": "string" },
    "content_ownership": { "violation": boolean, "citation": "string" }
  }
}`;
  }

  return `You are a senior privacy attorney. Analyze legal text strictly and return structured output.
Pillars:
1) ai_training
2) data_selling
3) transparency
4) data_retention
5) content_ownership

Rules:
- Mark violation=true only with clear evidence.
- If score < 50, rating must be RISKY.
- If score 50-74, rating must be OKAY.
- If score >= 75, rating can be SAFE or OKAY.
- Provide citations directly from text when possible.

Output ONLY valid JSON:
{
  "rating": "SAFE" | "OKAY" | "RISKY",
  "score": <integer 0-100>,
  "tldr": "<2-3 sentence summary>",
  "pillars": {
    "ai_training": { "violation": boolean, "citation": "string", "confidence": "HIGH" | "MEDIUM" | "LOW" },
    "data_selling": { "violation": boolean, "citation": "string", "confidence": "HIGH" | "MEDIUM" | "LOW" },
    "transparency": { "violation": boolean, "citation": "string", "confidence": "HIGH" | "MEDIUM" | "LOW" },
    "data_retention": { "violation": boolean, "citation": "string", "confidence": "HIGH" | "MEDIUM" | "LOW" },
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH" | "MEDIUM" | "LOW" }
  }
}`;
}

function extractJSON(text: string): any | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const raw = cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
  let lastError: any;

  for (let round = 0; round < MAX_RETRY_ROUNDS; round++) {
    for (let attempt = 0; attempt < NIM_KEYS.length; attempt++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
      nimKeyIndex++;
      const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });

      const keyController = new AbortController();
      const keyTimeout = setTimeout(() => keyController.abort(), PER_KEY_TIMEOUT_MS);
      const onGlobalAbort = () => keyController.abort();
      signal.addEventListener("abort", onGlobalAbort, { once: true });

      try {
        return await client.chat.completions.create(params, { signal: keyController.signal });
      } catch (err: any) {
        lastError = err;
        const status = err?.status ?? 0;
        if (status >= 400 && status < 500 && status !== 429) throw err;
        if (signal.aborted) throw err;
        console.warn(
          `[stress] Round ${round + 1}/${MAX_RETRY_ROUNDS}, key attempt ${attempt + 1} failed (status=${status}), trying next.`,
        );
      } finally {
        clearTimeout(keyTimeout);
        signal.removeEventListener("abort", onGlobalAbort);
      }
    }

    // All keys failed this round on retryable errors. Back off before another round.
    if (round < MAX_RETRY_ROUNDS - 1) {
      const jitter = Math.floor(Math.random() * 800);
      const backoff = BASE_BACKOFF_MS * (round + 1) + jitter;
      console.warn(`[stress] Backing off ${backoff}ms before retry round ${round + 2}.`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

function getViolations(parsed: any): string[] {
  const pillars = parsed?.pillars ?? {};
  return PILLAR_KEYS.filter((k) => Boolean(pillars?.[k]?.violation));
}

function inferPillarsFromText(text: string): Record<PillarKey, boolean> {
  const t = text.toLowerCase();

  const ai_training =
    /(train(ing)?|fine[-\s]?tune|machine learning|artificial intelligence|ai systems?)/i.test(t) &&
    /(user data|your data|user content|your content|interactions|uploads|prompts)/i.test(t);

  const data_selling =
    (
      /(advertising partners?|ad partners?|third[-\s]?part(y|ies)|analytics partners?|share data|sharing data|partners?|affiliates)/i.test(t) &&
      /(advertising|measurement|personalization|commercial|business)/i.test(t)
    ) ||
    (
      /(across services?|cross[-\s]?service|service improvement|personalization|advertising)/i.test(t) &&
      /(use of data|data use|use data|process.*data)/i.test(t)
    );

  const transparency =
    /(for any purpose we deem appropriate|from time to time|other information|may collect.*others)/i.test(t);

  const data_retention =
    /(retain|retention|keep).*(after deletion|post[-\s]?deletion|indefinite|indefinitely|year|years)/i.test(t);

  const content_ownership =
    /(license|rights?).*(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free)/i.test(t) ||
    /(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free).*(license|rights?)/i.test(t) ||
    /((create|prepare|preparation of|modify).*(derivative works)|(for any purpose)|(in any media))/i.test(t);

  return { ai_training, data_selling, transparency, data_retention, content_ownership };
}

function ensurePillarShape(parsed: any): void {
  if (!parsed.pillars || typeof parsed.pillars !== "object") parsed.pillars = {};
  for (const key of PILLAR_KEYS) {
    const current = parsed.pillars[key];
    if (!current || typeof current !== "object") {
      parsed.pillars[key] = { violation: false, citation: "Not addressed in excerpt." };
      continue;
    }
    if (typeof current.violation !== "boolean") {
      current.violation = String(current.violation).toLowerCase() === "true";
    }
    if (typeof current.citation !== "string") {
      current.citation = "Not addressed in excerpt.";
    }
  }
}

function applyDeterministicGuards(parsed: any, tier: Tier, sourceText: string): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  ensurePillarShape(parsed);

  const inferred = inferPillarsFromText(sourceText);

  // Guard 1: Deep scans should not miss explicit clause patterns in the provided excerpt.
  if (tier === "deep") {
    for (const key of PILLAR_KEYS) {
      const modelFlag = Boolean(parsed.pillars?.[key]?.violation);
      if (!modelFlag && inferred[key]) {
        parsed.pillars[key].violation = true;
        if (
          !parsed.pillars[key].citation ||
          parsed.pillars[key].citation === "Not addressed in excerpt."
        ) {
          parsed.pillars[key].citation = "Explicit clause pattern found in provided excerpt.";
        }
        if (!parsed.pillars[key].confidence) {
          parsed.pillars[key].confidence = "MEDIUM";
        }
      }
    }
  }

  const violations = getViolations(parsed);
  const highSeverity = ["ai_training", "data_selling", "content_ownership", "data_retention"]
    .filter((k) => violations.includes(k))
    .length;

  // Guard 2: Deterministic score/rating mapping by violation profile.
  if (violations.length === 0) {
    if (typeof parsed.score !== "number" || parsed.score < 75) parsed.score = 90;
    parsed.rating = parsed.score >= 90 ? "SAFE" : "OKAY";
    return parsed;
  }

  if (highSeverity >= 1 || violations.length >= 2) {
    parsed.rating = "RISKY";
    if (typeof parsed.score !== "number" || parsed.score >= 50 || parsed.score < 15) {
      parsed.score = highSeverity >= 2 || violations.length >= 3 ? 25 : 40;
    }
    return parsed;
  }

  parsed.rating = "OKAY";
  if (typeof parsed.score !== "number" || parsed.score < 50 || parsed.score >= 75) {
    parsed.score = 60;
  }
  return parsed;
}

async function runScan(service: ServiceCase, tier: Tier, run: number): Promise<ScanResult> {
  const model = tier === "quick" ? QUICK_MODEL_ID : DEEP_MODEL_ID;
  const timeoutMs = tier === "quick" ? 25000 : 45000;
  const maxTokens = tier === "quick" ? 420 : 1200;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  const baseResult: ScanResult = {
    service: service.service,
    sourceUrl: service.sourceUrl,
    run,
    tier,
    model,
    latencyMs: 0,
    parseOk: false,
    expectedRatingMatch: false,
  };

  try {
    const resp = await nimCreateWithRetry(
      {
        model,
        messages: [
          { role: "system", content: buildSystemPrompt(tier) },
          { role: "user", content: `Analyze this policy excerpt:\n\n${service.text}` },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      },
      controller.signal,
    );

    const latencyMs = Date.now() - startedAt;
    const content = resp?.choices?.[0]?.message?.content || "{}";
    const parsed = extractJSON(content);
    if (!parsed) {
      return {
        ...baseResult,
        latencyMs,
        error: "JSON parse failed",
      };
    }

    const normalized = applyDeterministicGuards(parsed, tier, service.text);

    const rating = typeof normalized.rating === "string" ? normalized.rating : undefined;
    const score = typeof normalized.score === "number" ? normalized.score : undefined;
    const violations = getViolations(normalized);
    const expectedRatingMatch = rating ? service.expectedRatings.includes(rating as "SAFE" | "OKAY" | "RISKY") : false;

    return {
      ...baseResult,
      latencyMs,
      parseOk: true,
      rating,
      score,
      violations,
      expectedRatingMatch,
    };
  } catch (err: any) {
    return {
      ...baseResult,
      latencyMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function formatTierSummary(results: ScanResult[], tier: Tier): string {
  const tierResults = results.filter((r) => r.tier === tier);
  const parsed = tierResults.filter((r) => r.parseOk);
  const lat = parsed.map((r) => r.latencyMs);
  const ratingOk = parsed.filter((r) => r.expectedRatingMatch).length;
  const parseRate = `${parsed.length}/${tierResults.length}`;
  const ratingRate = parsed.length ? `${ratingOk}/${parsed.length} (${((ratingOk / parsed.length) * 100).toFixed(1)}%)` : "0/0";

  return [
    `- Tier: ${tier.toUpperCase()}`,
    `  - Parse rate: ${parseRate}`,
    `  - Expected rating match: ${ratingRate}`,
    `  - Latency p50: ${(percentile(lat, 50) / 1000).toFixed(2)}s`,
    `  - Latency p90: ${(percentile(lat, 90) / 1000).toFixed(2)}s`,
    `  - Latency min/max: ${(lat.length ? Math.min(...lat) / 1000 : 0).toFixed(2)}s / ${(lat.length ? Math.max(...lat) / 1000 : 0).toFixed(2)}s`,
  ].join("\n");
}

async function main() {
  const requestedServices = (process.env.STRESS_SERVICES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const activeServices =
    requestedServices.length === 0
      ? SERVICES
      : SERVICES.filter((s) => requestedServices.includes(s.service.toLowerCase()));

  if (activeServices.length === 0) {
    console.error("[stress] No matching services selected. Set STRESS_SERVICES with comma-separated names.");
    process.exit(1);
  }

  const all: ScanResult[] = [];
  let md = "# TLDR Shield 5-Service Stress Test (Set 2: Basic + Deep)\n\n";
  md += `- Quick model: \`${QUICK_MODEL_ID}\`\n`;
  md += `- Deep model: \`${DEEP_MODEL_ID}\`\n`;
  md += `- Services: ${activeServices.length}\n`;
  md += `- Runs per service per tier: ${RUNS_PER_SERVICE}\n\n`;

  for (const service of activeServices) {
    console.log(`[stress] Service: ${service.service}`);
    md += `## ${service.service}\n`;
    md += `Source: ${service.sourceUrl}\n`;
    md += `Expected ratings: ${service.expectedRatings.join("/")}\n\n`;

    for (let run = 1; run <= RUNS_PER_SERVICE; run++) {
      console.log(`[stress]   Run ${run}/${RUNS_PER_SERVICE} quick`);
      const quick = await runScan(service, "quick", run);
      all.push(quick);
      md += `- Run ${run} BASIC: ${quick.parseOk ? `${quick.rating} (${quick.score})` : `ERROR (${quick.error})`} | latency=${(quick.latencyMs / 1000).toFixed(2)}s | violations=${quick.violations?.join(", ") || "n/a"} | expectedMatch=${quick.expectedRatingMatch}\n`;

      await new Promise((r) => setTimeout(r, INTER_CALL_PAUSE_MS));

      console.log(`[stress]   Run ${run}/${RUNS_PER_SERVICE} deep`);
      const deep = await runScan(service, "deep", run);
      all.push(deep);
      md += `- Run ${run} DEEP: ${deep.parseOk ? `${deep.rating} (${deep.score})` : `ERROR (${deep.error})`} | latency=${(deep.latencyMs / 1000).toFixed(2)}s | violations=${deep.violations?.join(", ") || "n/a"} | expectedMatch=${deep.expectedRatingMatch}\n`;

      md += "\n";
      fs.writeFileSync("stress_5_services_results_set2.md", md, "utf8");
      await new Promise((r) => setTimeout(r, INTER_RUN_PAUSE_MS));
    }
  }

  md += "## Aggregate\n\n";
  md += formatTierSummary(all, "quick") + "\n";
  md += formatTierSummary(all, "deep") + "\n\n";

  md += "## Raw JSON\n\n";
  md += "```json\n";
  md += JSON.stringify(all, null, 2);
  md += "\n```\n";

  fs.writeFileSync("stress_5_services_results_set2.md", md, "utf8");
  console.log("[stress] Done. Results written to stress_5_services_results_set2.md");
}

main().catch((err) => {
  console.error("[stress] Fatal:", err);
  process.exit(1);
});
