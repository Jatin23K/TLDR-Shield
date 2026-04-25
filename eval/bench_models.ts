import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

const MODELS = [
  "meta/llama-3.3-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "meta/llama-3.1-405b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mistral-large-2-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "meta/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-235b-a22b",
  "deepseek-ai/deepseek-r1",
];

const SYSTEM = `You are a senior privacy attorney. Analyze the legal text against these privacy pillars:
1. ai_training — Data used for AI/ML training WITHOUT a simple opt-out?
2. data_selling — Personal data shared with named THIRD PARTIES for commercial benefit?
3. transparency — Language self-contradictory or deliberately obscuring?
4. data_retention — Retention exceeds 1 year post-account-deletion?
5. content_ownership — Broad IP rights beyond platform operation?
Output ONLY valid JSON, no markdown:
{"tldr":"2 sentence summary","pillars":{"ai_training":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},"data_selling":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},"transparency":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},"data_retention":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},"content_ownership":{"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"}}}`;

// Twitter/X — known RISKY: ai_training=true, data_selling=true, content_ownership=true
// Signal — known SAFE: all pillars false
const CASES = [
  {
    name: "Twitter/X (RISKY)",
    text: `X Privacy Policy. We collect information you provide when creating an account (name, email, phone number, date of birth), content you post (tweets, replies, likes, bookmarks), direct messages, and information about your device and location. We use advertising and analytics partners including third-party companies to serve personalized ads. Your public posts and interactions are shared with advertising partners for targeting purposes. Your data including posts and interactions may be used to train AI models powering Grok and other X AI features; you can opt out of this in Privacy Settings > Data sharing and personalization. We retain account data for 30 days after deletion before permanent removal; however, public posts may be retained in our systems for up to 18 months for analytics. You grant X a worldwide, non-exclusive, royalty-free license to use, copy, reproduce, process, adapt, modify, publish, transmit, display, and distribute your content, for any purpose including commercial purposes and sublicensing to third parties.`,
    expected: { ai_training: true, data_selling: true, content_ownership: true },
  },
  {
    name: "Signal (SAFE)",
    text: `Signal Privacy Policy. Signal is designed to never collect or store any sensitive information. Signal messages and calls cannot be accessed by us or other third parties because they are always end-to-end encrypted, private, and secure. We do not sell, rent or monetize your personal data or content in any way. We do not use your data to train AI or machine learning models. Your data is never retained after you delete your account. You retain full ownership of all content you send via Signal.`,
    expected: { ai_training: false, data_selling: false, content_ownership: false },
  },
];

let keyIdx = 0;
function nextKey() { return KEYS[keyIdx++ % KEYS.length]; }

async function callModel(modelId: string, caseData: typeof CASES[0]): Promise<any> {
  const key = nextKey();
  const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1", timeout: 90000 });
  const start = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Analyze this legal document:\n\n${caseData.text}` },
      ],
      temperature: 0,
      max_tokens: 1400,
    });
    const latency = Date.now() - start;
    const raw = resp.choices[0]?.message?.content || "";
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "").trim();
    const s = cleaned.indexOf("{"); const e = cleaned.lastIndexOf("}");
    let parsed: any = null;
    if (s >= 0 && e > s) { try { parsed = JSON.parse(cleaned.substring(s, e + 1)); } catch { try { parsed = JSON.parse(cleaned.substring(s, e+1).replace(/,\s*([}\]])/g,'$1')); } catch {} } }

    const pillars = parsed?.pillars;
    let correct = 0; let total = 0;
    for (const [k, expVal] of Object.entries(caseData.expected)) {
      total++;
      if (pillars?.[k]?.violation === expVal) correct++;
    }
    const tokens = (resp.usage as any)?.completion_tokens ?? "?";
    const promptTokens = (resp.usage as any)?.prompt_tokens ?? "?";

    return { latency, parseOk: !!parsed, correct, total, tokens, promptTokens, pillars };
  } catch (e: any) {
    return { latency: Date.now() - start, parseOk: false, correct: 0, total: Object.keys(caseData.expected).length, error: e?.message?.slice(0, 80) ?? String(e) };
  }
}

async function main() {
  console.log("=".repeat(90));
  console.log("NIM MODEL BENCHMARK — Actual latency + accuracy on 2 policy cases");
  console.log("=".repeat(90));
  console.log(`Keys loaded: ${KEYS.length}`);
  console.log();

  const results: any[] = [];

  for (const modelId of MODELS) {
    console.log(`\nTesting: ${modelId}`);
    const caseResults: any[] = [];

    for (const c of CASES) {
      process.stdout.write(`  ${c.name}... `);
      const r = await callModel(modelId, c);
      caseResults.push({ case: c.name, ...r });
      if (r.error) {
        console.log(`ERROR: ${r.error}`);
      } else {
        console.log(`${r.latency}ms | parse=${r.parseOk} | ${r.correct}/${r.total} correct | completion_tokens=${r.tokens}`);
      }
      await new Promise(res => setTimeout(res, 1500));
    }
    results.push({ model: modelId, cases: caseResults });
  }

  console.log("\n" + "=".repeat(90));
  console.log("SUMMARY TABLE");
  console.log("=".repeat(90));
  console.log(
    "Model".padEnd(50) +
    "Avg Latency".padEnd(14) +
    "Parse%".padEnd(10) +
    "Accuracy"
  );
  console.log("-".repeat(90));

  for (const r of results) {
    const validCases = r.cases.filter((c: any) => !c.error);
    if (validCases.length === 0) {
      console.log(r.model.padEnd(50) + "N/A".padEnd(14) + "N/A".padEnd(10) + "N/A (all errored)");
      continue;
    }
    const avgLatency = Math.round(validCases.reduce((s: number, c: any) => s + c.latency, 0) / validCases.length);
    const parsePct = Math.round(validCases.filter((c: any) => c.parseOk).length / validCases.length * 100);
    const totalCorrect = validCases.reduce((s: number, c: any) => s + c.correct, 0);
    const totalPillars = validCases.reduce((s: number, c: any) => s + c.total, 0);
    const accPct = Math.round(totalCorrect / totalPillars * 100);
    console.log(
      r.model.padEnd(50) +
      `${avgLatency}ms`.padEnd(14) +
      `${parsePct}%`.padEnd(10) +
      `${accPct}% (${totalCorrect}/${totalPillars} pillars)`
    );
  }
}

main().catch(console.error);
