import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";

process.on('uncaughtException', err => console.error('Uncaught', err));
process.on('unhandledRejection', err => console.error('Unhandled', err));

dotenv.config();

type Tier = "quick" | "deep";

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("❌ No NIM API keys found.");
  process.exit(1);
}

let nimKeyIndex = 0;
const PER_KEY_TIMEOUT_MS = 25000;

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
  let lastError: any;
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
      console.warn(`  ⚠ Key #${attempt + 1} failed (status=${status}), trying next...`);
    } finally {
      clearTimeout(keyTimeout);
      signal.removeEventListener("abort", onGlobalAbort);
    }
  }
  return null;
}

function extractJSON(text: string): any | null {
  const clean = (src: string) => src.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const normalize = (raw: string) => raw.replace(/,\s*([}\]])/g, "$1");
  const tryParse = (raw: string): any | null => { try { return JSON.parse(raw); } catch { return null; } };
  const findOutermostObject = (src: string): string | null => {
    const start = src.indexOf("{");
    if (start === -1) return null;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\" && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) return src.substring(start, i + 1); }
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
          if (p && typeof p.violation === "string") p.violation = p.violation.toLowerCase() === "true";
        }
      }
      return parsed;
    }
  }
  return null;
}

function buildSystemPrompt(tier: Tier): string {
  if (tier === "quick") {
    return `You are a privacy attorney giving an instant verdict. Be STRICT. Scan for: ai_training (ANY mention of AI/ML training using user content = violation), data_selling (content/data shared with advertisers or third-party companies = violation), transparency (deliberately vague/obscuring language?), data_retention (retention >1yr post-deletion or completely unspecified?), content_ownership (worldwide sublicensable license "for any purpose" beyond platform use = violation).

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;
  }

  return `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data used for AI/ML model training, fine-tuning, or improvement, with no clear user opt-out? VIOLATION EXAMPLES: "for use with and training of our machine learning and artificial intelligence models", "to train our AI", "improve our AI systems using your data". Even if bundled into a broad license clause, if AI training is mentioned = VIOLATION.
2. data_selling     — Content or personal data shared with third parties (advertisers, partners, other companies) beyond what is strictly needed to operate the service? VIOLATION EXAMPLES: content syndicated/distributed to "other companies, organizations or individuals", advertising partners targeting users with their data, data shared for "commercial use". Sharing for advertising = VIOLATION.
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices? VIOLATION EXAMPLES: key rights buried in dense legalese, critical data practices only referenced via external links, no plain-language explanation of data use.
4. data_retention   — No stated deletion timeline, or retention exceeds 1 year post-account-deletion? Delegating entirely to another document without specifics = borderline violation.
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform? VIOLATION EXAMPLES: worldwide royalty-free sublicensable license "for any purpose", right to modify/adapt/redistribute content, no compensation for commercial reuse of content.

VIOLATION RULES:
- ai_training: ANY mention of using user content/data for AI or ML training = VIOLATION, no exceptions.
- data_selling: Sharing content with advertisers, partners, or "other companies" for their commercial benefit = VIOLATION.
- content_ownership: "for any purpose" or sublicensable worldwide license that goes beyond just showing content on the platform = VIOLATION.
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

EVIDENCE REQUIREMENT — NULL HYPOTHESIS:
Default to violation: false for EVERY pillar. Set violation: true ONLY IF you can copy-paste a verbatim sentence from the text above that proves it.

For 'citation': copy the EXACT verbatim sentence(s) from the document. Do NOT paraphrase. If nothing is stated, write 'Not addressed in document.'

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
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }
  }
}

CONFIDENCE RULES:
- HIGH: You found an explicit, unambiguous clause. Citation is a direct verbatim quote.
- MEDIUM: Clause exists but requires some interpretation.
- LOW: Inferred from indirect language.`;
}

// 5 test cases
const TEST_CASES = [
  { service: "X (Twitter)", expectedRating: ["RISKY"], text: `X TERMS OF SERVICE (Effective November 15, 2024)\n\n1. Who May Use the Services\nYou may use the Services only if you agree to form a binding contract with X ... you must be at least 13 years old.\n\n3. Content on the Services\n...By submitting, posting or displaying Content... you grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish... for any purpose... You agree that this license includes the right for us to (i) analyze text... for use with and training of our machine learning and artificial intelligence models... and (ii) make Content... available to other companies, organizations or individuals...` },
  { service: "TikTok", expectedRating: ["RISKY"], text: `TIKTOK TERMS OF SERVICE\n\n4. Your Content\nYou grant TikTok a worldwide, non-exclusive, royalty-free, transferable, sublicensable license to use, reproduce... You also grant TikTok an unrestricted... fully paid, and royalty-free license to use the User Content, including to reproduce, modify and use for training machine learning, artificial intelligence... without any further consent... We may use the information... to share with third-party advertising and analytics partners...` },
  { service: "Signal", expectedRating: ["SAFE", "OKAY"], text: `SIGNAL TERMS OF SERVICE & PRIVACY POLICY\n\nSignal is designed to never collect or store sensitive information... Signal does not sell, rent, or monetize your personal data or content in any way – ever... Signal does not serve ads... Signal claims no license or rights to your communications beyond what is strictly necessary... Signal does not use any user data for AI training, machine learning, or any automated decision-making...` },
  { service: "DuckDuckGo", expectedRating: ["SAFE", "OKAY"], text: `DUCKDUCKGO TERMS OF SERVICE\n\nDuckDuckGo does not track you. We do not collect or store personal information... DuckDuckGo generates revenue through non-tracking, contextual advertising... Our advertising partners do not receive any personal information... DuckDuckGo does not use any user search data for AI model training or similar technologies.` },
  { service: "Spotify", expectedRating: ["RISKY", "OKAY"], text: `SPOTIFY TERMS OF USE\n\nContent you post... you grant to Spotify a non-exclusive, transferable, sublicensable, royalty-free, fully paid, irrevocable, worldwide license to reproduce, make available... modify, create derivative works from... You also grant to us the right... to provide advertising and other information to you, and to allow our business partners to do the same.` }
];

const MODELS = [
  "deepseek-ai/deepseek-v3.1-terminus",
  "qwen/qwen3-next-80b-a3b-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "mistralai/mixtral-8x7b-instruct-v0.1",
  "qwen/qwen2.5-coder-32b-instruct",
  "google/gemma-3-27b-it",
  "meta/llama-3.1-405b-instruct",
  "meta/llama-3.3-70b-instruct"
];

async function run() {
  let md = "# Stress Test Results (Top 10 Models)\n\n";

  for (const tc of TEST_CASES) {
    const serviceNamePad = Math.floor((50 - tc.service.length)/2);
    md += "===================================================\n";
    md += `${" ".repeat(serviceNamePad)}${tc.service}\n`;

    for (const model of MODELS) {
      const modelNamePad = Math.floor((50 - model.length)/2);
      md += "---------------------------------------------------\n";
      md += `${" ".repeat(modelNamePad)}${model}\n`;

      console.log(`Running ${tc.service} -> ${model}...`);
      
      let quickResult = "";
      let deepResult = "";

      for (const tier of ["quick", "deep"] as Tier[]) {
        const controller = new AbortController();
        const timeoutLimit = tier === "quick" ? 15000 : 30000;
        const acceptableLatency = tier === "quick" ? 10000 : 20000;
        const timeout = setTimeout(() => controller.abort(), timeoutLimit);
        const startTime = Date.now();
        let latency = 0;

        try {
          const resp = await nimCreateWithRetry({
            model: model,
            messages: [
              { role: "system", content: buildSystemPrompt(tier) },
              { role: "user", content: tier === "quick" ? `Analyze this Terms of Service document. Give an instant verdict:\n\n${tc.text}` : `Analyze this Terms of Service document thoroughly. Extract ALL violations present:\n\n${tc.text}` }
            ],
            temperature: 0,
            max_tokens: tier === "quick" ? 400 : 1000
          }, controller.signal);
          
          latency = Date.now() - startTime;
          const latencyText = `${(latency/1000).toFixed(2)}s`;
          const latencyFlag = latency > acceptableLatency ? ` ⚠️ (EXCEEDS ${acceptableLatency/1000}s LIMIT)` : " ✅";

          if (!resp) {
            if (tier==="quick") quickResult = `API Error/Timeout [${latencyText}${latencyFlag}]`; else deepResult = `API Error/Timeout [${latencyText}${latencyFlag}]`;
            continue;
          }
          const raw = resp.choices[0]?.message?.content || "{}";
          const parsed = extractJSON(raw);
          if (parsed) {
             if (tier==="quick") quickResult = `Rating: ${parsed.rating}, Score: ${parsed.score} [${latencyText}${latencyFlag}]`;
             else {
               let violations = "";
               if(parsed.pillars) {
                 violations = Object.keys(parsed.pillars).filter(k => parsed.pillars[k]?.violation).join(", ");
               }
               deepResult = `Rating: ${parsed.rating}, Score: ${parsed.score}, Violations: ${violations || "None"} [${latencyText}${latencyFlag}]`;
             }
          } else {
             if (tier==="quick") quickResult = `Parse failed [${latencyText}${latencyFlag}]`; else deepResult = `Parse failed [${latencyText}${latencyFlag}]`;
          }
        } catch (e: any) {
           latency = Date.now() - startTime;
           const latencyText = `${(latency/1000).toFixed(2)}s`;
           const latencyFlag = latency > acceptableLatency ? ` ⚠️ (EXCEEDS ${acceptableLatency/1000}s LIMIT)` : " ✅";
           if (tier==="quick") quickResult = `Error: ${e.message} [${latencyText}${latencyFlag}]`; else deepResult = `Error: ${e.message} [${latencyText}${latencyFlag}]`;
        } finally {
          clearTimeout(timeout);
        }
      }
      
      md += `**Basic Scan:** ${quickResult}\n`;
      md += `**Deep Scan:** ${deepResult}\n`;
      
      // Save progressively in case of crash
      fs.writeFileSync("result.md", md, "utf-8");
      
      // Delay to avoid aggressive rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  md += "===================================================\n";
  fs.writeFileSync("result.md", md, "utf-8");
  console.log("Done. Results saved to result.md");
}

run();
