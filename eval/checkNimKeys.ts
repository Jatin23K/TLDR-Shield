import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

type Tier = "quick" | "deep";

const DEFAULT_QUICK_MODEL_ID = "meta/llama-3.3-70b-instruct";
const DEFAULT_DEEP_MODEL_ID = "meta/llama-3.3-70b-instruct";

const QUICK_MODEL_ID = (process.env.NIM_MODEL_QUICK || DEFAULT_QUICK_MODEL_ID).trim();
const DEEP_MODEL_ID = (process.env.NIM_MODEL_DEEP || DEFAULT_DEEP_MODEL_ID).trim();

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("[checkNim] Missing NIM_API_KEY_1..3 in .env");
  process.exit(1);
}

const MODELS: Record<Tier, string> = {
  quick: QUICK_MODEL_ID,
  deep: DEEP_MODEL_ID,
};

function getArg(name: string, fallback: string) {
  const found = process.argv.find((a) => a.startsWith(`${name}=`));
  if (!found) return fallback;
  return found.split("=", 2)[1] ?? fallback;
}

function getArgInt(name: string, fallback: number) {
  const v = getArg(name, String(fallback));
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function formatKeyLabel(i: number) {
  // Avoid leaking full keys in logs.
  const shown = NIM_KEYS[i].slice(0, 8);
  return `key${i + 1}(${shown}...)`;
}

async function callOnce(opts: {
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  maxTokens: number;
}) {
  const { apiKey, modelId, timeoutMs, maxTokens } = opts;
  const client = new OpenAI({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const started = Date.now();
  try {
    const resp = await client.chat.completions.create(
      {
        model: modelId,
        messages: [
          { role: "system", content: "You are a tester." },
          { role: "user", content: "Return exactly: OK" },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      },
      { signal: controller.signal }
    );

    const elapsedMs = Date.now() - started;
    const content = resp.choices[0]?.message?.content ?? "";
    return {
      ok: true,
      latencyMs: elapsedMs,
      contentPreview: String(content).slice(0, 20),
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - started;

    const status = err?.status ?? err?.response?.status ?? 0;
    const msg = err?.message ?? String(err);

    const isAbort =
      err?.name === "AbortError" ||
      msg.toLowerCase().includes("aborted") ||
      msg.toLowerCase().includes("timeout");

    return {
      ok: false,
      latencyMs: elapsedMs,
      status,
      kind:
        status === 401 || status === 403
          ? "unauthorized"
          : status === 404
            ? "model_not_found"
            : status === 429
              ? "rate_limited"
              : isAbort
                ? "timeout_or_abort"
                : "error",
      message: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const timeoutMs = getArgInt("--timeoutMs", 12000);
  const maxTokens = getArgInt("--maxTokens", 8);
  const burst = getArgInt("--burst", 3);
  const sleepMs = getArgInt("--sleepMs", 250);
  const tiersCsv = getArg("--tiers", "quick,deep");
  const tiers = tiersCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Tier[];
  const validTiers = tiers.filter((t) => t === "quick" || t === "deep") as Tier[];

  const results: any = {
    timeoutMs,
    maxTokens,
    burst,
    sleepMs,
    models: {},
    keys: [],
  };

  for (const t of validTiers) results.models[t] = MODELS[t];

  for (let i = 0; i < NIM_KEYS.length; i++) {
    const apiKey = NIM_KEYS[i];
    const keyResults: any = {
      keyLabel: formatKeyLabel(i),
      keyIndex: i + 1,
      attempts: [],
    };

    for (const tier of validTiers) {
      const modelId = MODELS[tier];

      // 1) Smoke call
      const smoke = await callOnce({ apiKey, modelId, timeoutMs, maxTokens });
      keyResults.attempts.push({
        tier,
        modelId,
        kind: "smoke",
        ...smoke,
      });

      // 2) Small burst to detect 429 quickly
      let rateLimitedCount = 0;
      const burstLatencies: number[] = [];
      for (let b = 0; b < burst; b++) {
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
        const r = await callOnce({ apiKey, modelId, timeoutMs, maxTokens });
        if (!r.ok && r.status === 429) rateLimitedCount++;
        if (r.latencyMs != null) burstLatencies.push(r.latencyMs);

        keyResults.attempts.push({
          tier,
          modelId,
          kind: `burst_${b + 1}`,
          ...r,
        });
      }

      keyResults.attempts.push({
        tier,
        modelId,
        kind: "summary_burst",
        burst,
        rateLimitedCount,
        p50: burstLatencies.length ? percentile(burstLatencies, 50) : null,
        p90: burstLatencies.length ? percentile(burstLatencies, 90) : null,
      });
    }

    results.keys.push(keyResults);
  }

  console.log(JSON.stringify(results, null, 2));
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

main().catch((e) => {
  console.error("[checkNim] fatal:", e);
  process.exit(1);
});
