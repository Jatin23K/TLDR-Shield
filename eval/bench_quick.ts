import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

const KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

// Only the 2 models that actually work on our keys
const MODELS = [
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
];

const QUICK_SYSTEM = `Privacy attorney. Analyze legal text for 5 violations: ai_training (AI training without opt-out?), data_selling (data sold/shared WITH named third parties like advertisers or brokers), transparency (self-contradictory language), data_retention (retention over 1 year post-deletion?), content_ownership (overly broad IP claim?).
Score rules: Each violation deducts points. 0 violations→90-100 SAFE. 1 violation→50-89 OKAY. 2+→RISKY. Score<50=RISKY.
Output ONLY valid JSON no markdown, no pillars:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2 sentence verdict. Name the biggest risk if any."}`;

const CASES = [
  { name: "Twitter/X (RISKY)",  expected: "RISKY",
    text: `X Privacy Policy. We collect your name, email, device info, and location. Advertising partners receive your data for targeting. Your posts may train Grok AI models; opt-out in settings. You grant X a worldwide royalty-free license for any purpose including sublicensing.` },
  { name: "Signal (SAFE)",      expected: "SAFE",
    text: `Signal Privacy Policy. Signal does not collect user data. Messages are end-to-end encrypted. We do not sell data. We do not train AI models. Data is deleted within 30 days of account closure. You own all your content.` },
  { name: "Airbnb (SAFE)",      expected: "SAFE",
    text: `Airbnb Privacy Policy. We collect profile information and booking history. We do not sell personal data. We do not train AI models. Account data deleted within 90 days. You retain ownership of reviews and photos.` },
  { name: "Amazon (RISKY)",     expected: "RISKY",
    text: `Amazon Privacy Notice. We share data with advertising partners for personalized ads on and off Amazon. We retain account data for 7 years after account closure. Voice recordings from Alexa reviewed by humans.` },
  { name: "Meta (RISKY)",       expected: "RISKY",
    text: `Meta Privacy Policy. We collect your activity, device info, and location. We share information with advertisers and data brokers. Your content may train AI models. We retain data for 3 years after deletion. You grant Meta a sublicensable worldwide license for any purpose.` },
];

let keyIdx = 0;

async function callModel(modelId: string, text: string, expectedRating: string) {
  const key = KEYS[keyIdx++ % KEYS.length];
  const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1", timeout: 30000 });
  const start = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: "system", content: QUICK_SYSTEM },
        { role: "user", content: `Analyze this legal document:\n\n${text}` },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const latency = Date.now() - start;
    const raw = resp.choices[0]?.message?.content || "";
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const s = cleaned.indexOf("{"); const e = cleaned.lastIndexOf("}");
    let parsed: any = null;
    if (s >= 0 && e > s) {
      try { parsed = JSON.parse(cleaned.substring(s, e+1)); } catch {
        try { parsed = JSON.parse(cleaned.substring(s, e+1).replace(/,\s*([}\]])/g,'$1')); } catch {}
      }
    }
    const ratingOk = parsed?.rating === expectedRating;
    return { latency, parseOk: !!parsed, ratingOk, rating: parsed?.rating ?? "FAIL", tokens: (resp.usage as any)?.completion_tokens ?? "?" };
  } catch(e: any) {
    return { latency: Date.now()-start, parseOk: false, ratingOk: false, rating: "ERROR", tokens: 0, error: e?.message?.slice(0,60) };
  }
}

async function main() {
  console.log("QUICK SCAN FORMAT BENCHMARK — 5 cases × 2 models");
  console.log("=".repeat(75));

  for (const modelId of MODELS) {
    console.log(`\nModel: ${modelId}`);
    console.log("-".repeat(75));
    let totalLatency = 0; let parseOk = 0; let ratingOk = 0;

    for (const c of CASES) {
      process.stdout.write(`  ${c.name.padEnd(20)} `);
      const r = await callModel(modelId, c.text, c.expected);
      const mark = r.ratingOk ? "✓" : "✗";
      console.log(`${mark} ${r.latency}ms | parse=${r.parseOk} | got=${r.rating} expected=${c.expected} | tokens=${r.tokens}${r.error ? " ERR:"+r.error : ""}`);
      totalLatency += r.latency; if (r.parseOk) parseOk++; if (r.ratingOk) ratingOk++;
      await new Promise(res => setTimeout(res, 800));
    }

    const n = CASES.length;
    console.log(`  TOTALS: avg=${Math.round(totalLatency/n)}ms | parse=${parseOk}/${n} | accuracy=${ratingOk}/${n} (${Math.round(ratingOk/n*100)}%)`);
  }
}
main().catch(console.error);
