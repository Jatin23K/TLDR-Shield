/**
 * NIM Model Latency Benchmark
 * Tests quick (5-10s target) and deep (10-20s target) candidates
 * Usage: node eval/bench_models.mjs
 */
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const KEY = process.env.NIM_API_KEY_1;
const client = new OpenAI({ apiKey: KEY, baseURL: "https://integrate.api.nvidia.com/v1" });

// ── Realistic ToS chunk (~1800 chars, typical NIM input) ─────────────────────
const TOS_CHUNK = `
By accessing or using our Services, you grant us a worldwide, non-exclusive, royalty-free license
(with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit,
display, upload, download, and distribute such Content, including anything referenced therein,
in any and all media or distribution methods now known or later developed, for any purpose,
including commercial purposes. This license includes the right to make your Content available to
third-party companies, organizations, or individuals who partner with us for the syndication,
broadcast, distribution, or publication of Content on other media, subject to our terms for
such Content use.

You understand that we may use your Content to train our machine learning and artificial
intelligence models, whether generative or another type, to improve our Services and develop
new features. You can opt out by emailing privacy@example.com within 30 days of account creation.

We may share your personal data with advertising partners and analytics providers to deliver
targeted advertisements and measure their effectiveness. Our third-party advertising partners
may use cookies, web beacons, and similar tracking technologies to collect information about
your activity on our Services and other websites.

We retain your data for as long as your account is active or as needed to provide Services.
After account deletion, we may retain certain information as required by law or for legitimate
business purposes. Our aggregate liability shall not exceed ONE HUNDRED U.S. DOLLARS ($100.00)
or the amount you paid us in the past six months, whichever is greater.

You waive the right to participate as a plaintiff or class member in any purported class action,
collective action, or representative action proceeding. All disputes shall be resolved through
binding individual arbitration. Any claim must be filed within one year of the event giving rise
to the dispute, after which the claim is permanently barred.
`.trim();

// ── Prompts (exact copies from server.ts) ────────────────────────────────────
const QUICK_SYSTEM = `You are a privacy attorney giving an instant verdict. Be STRICT. Scan for: ai_training (ANY mention of AI/ML training using user content = violation), data_selling (content/data shared with advertisers or third-party companies = violation), transparency (deliberately vague/obscuring language?), data_retention (retention >1yr post-deletion or completely unspecified?), content_ownership (worldwide sublicensable license "for any purpose" beyond platform use = violation).

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;

const DEEP_SYSTEM = `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data used for AI/ML model training
2. data_selling     — Content or personal data shared with third parties (advertisers, partners)
3. transparency     — Language deliberately vague or designed to obscure practices
4. data_retention   — No stated deletion timeline, or retention exceeds 1 year post-deletion
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform
6. dark_patterns    — Unfair clauses: tiny liability cap, forced arbitration, class action waivers

CITATION RULE: 'citation' must be a verbatim copy-paste of 15-60 consecutive words from the text.

Output ONLY valid JSON:
{
  "rating": "SAFE"|"OKAY"|"RISKY",
  "score": <integer 0-100>,
  "tldr": "<2-3 sentence plain-English summary>",
  "deductions": [{ "reason": "<clause>", "points": <integer> }],
  "pillars": {
    "ai_training":       { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_selling":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "transparency":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_retention":    { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "dark_patterns":     { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }
  }
}`;

// ── Model candidates ──────────────────────────────────────────────────────────
const QUICK_CANDIDATES = [
  { id: "meta/llama-3.1-8b-instruct",                  maxTokens: 120 },
  { id: "meta/llama-3.2-3b-instruct",                   maxTokens: 120 },
  { id: "nvidia/llama-3.1-nemotron-nano-8b-v1",         maxTokens: 120 },
  { id: "google/gemma-3-12b-it",                        maxTokens: 120 },
  { id: "mistralai/mistral-7b-instruct-v0.3",           maxTokens: 120 },
  { id: "nv-mistralai/mistral-nemo-12b-instruct",       maxTokens: 120 },
  { id: "nvidia/mistral-nemo-minitron-8b-8k-instruct",  maxTokens: 120 },
  { id: "meta/llama-3.3-70b-instruct",                  maxTokens: 120 }, // current — baseline
];

const DEEP_CANDIDATES = [
  { id: "meta/llama-3.3-70b-instruct",                  maxTokens: 1400 },  // current baseline
  { id: "meta/llama-4-maverick-17b-128e-instruct",       maxTokens: 1400 },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1",        maxTokens: 1400 },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct",        maxTokens: 1400 },
  { id: "mistralai/mistral-small-3.1-24b-instruct-2503", maxTokens: 1400 },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",      maxTokens: 1400 },
];

const MODEL_TIMEOUT_MS = 35000; // 35s hard timeout per call

// ── Benchmark a single model ──────────────────────────────────────────────────
async function benchmark(model, systemPrompt, userContent, runs = 2) {
  const times = [];
  let lastOutput = null;
  let error = null;

  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    try {
      const callPromise = client.chat.completions.create({
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent  },
        ],
        max_tokens: model.maxTokens,
        temperature: 0.1,
        stream: false,
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT after ${MODEL_TIMEOUT_MS/1000}s`)), MODEL_TIMEOUT_MS)
      );
      const resp = await Promise.race([callPromise, timeoutPromise]);
      const elapsed = (Date.now() - t0) / 1000;
      times.push(elapsed);
      lastOutput = resp.choices[0]?.message?.content ?? "";
    } catch (e) {
      error = e.message ?? String(e);
      times.push(null);
      break; // don't retry on error/timeout
    }
  }

  const valid = times.filter(t => t !== null);
  const avg = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2) : "—";
  const min = valid.length ? Math.min(...valid).toFixed(2) : "—";

  // Quick validity check: does the output look like JSON?
  let jsonValid = false;
  try { JSON.parse(lastOutput ?? ""); jsonValid = true; } catch {}

  return { id: model.id, avg, min, runs: valid.length, jsonValid, error, output: lastOutput };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const user = `Analyze the following Terms of Service excerpt:\n\n${TOS_CHUNK}`;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  TLDR Shield — NIM Model Latency Benchmark");
  console.log("  Input: ~1800 chars of realistic ToS text");
  console.log("  Runs per model: 2  (avg + min reported)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── Quick scan candidates ─────────────────────────────────────────────────
  console.log("┌─ QUICK SCAN candidates  (target: 5-10s, max_tokens=120) ─────");
  const quickResults = [];
  for (const m of QUICK_CANDIDATES) {
    process.stdout.write(`  ${m.id.padEnd(48)} ... `);
    const r = await benchmark(m, QUICK_SYSTEM, user, 2);
    const flag = r.error ? "❌ ERROR" : r.jsonValid ? "✓ JSON" : "⚠ BAD JSON";
    console.log(`avg=${r.avg}s  min=${r.min}s  ${flag}`);
    if (r.error) console.log(`     └─ ${r.error.slice(0, 120)}`);
    quickResults.push(r);
  }

  // ── Deep scan candidates ──────────────────────────────────────────────────
  console.log("\n┌─ DEEP SCAN candidates   (target: 10-20s, max_tokens=1400) ───");
  const deepResults = [];
  for (const m of DEEP_CANDIDATES) {
    process.stdout.write(`  ${m.id.padEnd(48)} ... `);
    const r = await benchmark(m, DEEP_SYSTEM, user, 2);
    const flag = r.error ? "❌ ERROR" : r.jsonValid ? "✓ JSON" : "⚠ BAD JSON";
    console.log(`avg=${r.avg}s  min=${r.min}s  ${flag}`);
    if (r.error) console.log(`     └─ ${r.error.slice(0, 120)}`);
    deepResults.push(r);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RECOMMENDATIONS");
  console.log("═══════════════════════════════════════════════════════════════");

  const quickOk = quickResults.filter(r => !r.error && r.jsonValid && parseFloat(r.avg) >= 3 && parseFloat(r.avg) <= 12)
    .sort((a, b) => parseFloat(a.avg) - parseFloat(b.avg));
  const deepOk = deepResults.filter(r => !r.error && r.jsonValid && parseFloat(r.avg) >= 5 && parseFloat(r.avg) <= 25)
    .sort((a, b) => parseFloat(a.avg) - parseFloat(b.avg));

  console.log("\n  Quick scan (within 3-12s range, JSON-valid):");
  quickOk.forEach((r, i) => console.log(`    ${i+1}. ${r.id}  avg=${r.avg}s`));

  console.log("\n  Deep scan (within 5-25s range, JSON-valid):");
  deepOk.forEach((r, i) => console.log(`    ${i+1}. ${r.id}  avg=${r.avg}s`));

  if (quickOk[0]) console.log(`\n  → Best quick: ${quickOk[0].id}  (${quickOk[0].avg}s avg)`);
  if (deepOk[0])  console.log(`  → Best deep:  ${deepOk[0].id}  (${deepOk[0].avg}s avg)`);

  // ── Sample output from best quick ─────────────────────────────────────────
  if (quickOk[0]?.output) {
    console.log("\n  Sample quick output:");
    console.log("  " + quickOk[0].output.slice(0, 300));
  }
}

main().catch(console.error);
