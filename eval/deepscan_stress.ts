/**
 * TLDR Shield — Deep Scan Model Selection Stress Test
 * ====================================================
 * Tests the TOP 5 reasoning-heavy models for Deep Scan accuracy.
 * Validates against ground-truth pillar expectations from stress_test.ts.
 * Runs each model 2x per service for consistency checks.
 * 
 * Selected models (rationale):
 * 1. qwen/qwq-32b              — Dedicated reasoning model, excels at logical deduction
 * 2. deepseek-ai/deepseek-v3.2  — Frontier reasoning, IMO/IOI gold-medal tier
 * 3. qwen/qwen3.5-397b-a17b     — Latest Qwen flagship, massive MoE with thinking mode
 * 4. mistralai/mistral-large-3-675b-instruct-2512 — Largest Mistral, document analysis specialist
 * 5. nvidia/llama-3.1-nemotron-ultra-253b-v1 — NVIDIA's own reasoning-optimized model
 *
 * Comparison baseline (proven top):
 * 6. qwen/qwen3-next-80b-a3b-instruct — Current best from round 1 (96% accuracy)
 * 
 * Run: npx tsx eval/deepscan_stress.ts
 */

import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";

process.on("uncaughtException", (err) => console.error("Uncaught", err));
process.on("unhandledRejection", (err) => console.error("Unhandled", err));

dotenv.config();

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
const PER_KEY_TIMEOUT_MS = 40000; // 40s per key for deep reasoning models

async function nimCreateWithRetry(params: any, signal: AbortSignal) {
  let lastError: any;
  for (let attempt = 0; attempt < NIM_KEYS.length; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const key = NIM_KEYS[nimKeyIndex % NIM_KEYS.length];
    nimKeyIndex++;
    const client = new OpenAI({
      apiKey: key,
      baseURL: "https://integrate.api.nvidia.com/v1",
    });
    const keyController = new AbortController();
    const keyTimeout = setTimeout(() => keyController.abort(), PER_KEY_TIMEOUT_MS);
    const onGlobalAbort = () => keyController.abort();
    signal.addEventListener("abort", onGlobalAbort, { once: true });
    try {
      return await client.chat.completions.create(params, {
        signal: keyController.signal,
      });
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (signal.aborted) throw err;
      console.warn(
        `  ⚠ Key #${attempt + 1} failed (status=${status}), trying next...`
      );
    } finally {
      clearTimeout(keyTimeout);
      signal.removeEventListener("abort", onGlobalAbort);
    }
  }
  return null;
}

function extractJSON(text: string): any | null {
  const clean = (src: string) =>
    src
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();
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
    let depth = 0,
      inString = false,
      escape = false;
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
          if (p && typeof p.violation === "string")
            p.violation = p.violation.toLowerCase() === "true";
        }
      }
      return parsed;
    }
  }
  return null;
}

const DEEP_SYSTEM_PROMPT = `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

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

// Ground-truth test cases (matching stress_test.ts exactly)
interface GroundTruth {
  service: string;
  text: string;
  expectedRating: string[];
  scoreRange: [number, number];
  expectedPillars: {
    ai_training: boolean;
    data_selling: boolean;
    transparency: boolean;
    data_retention: boolean;
    content_ownership: boolean;
  };
}

const TEST_CASES: GroundTruth[] = [
  {
    service: "X (Twitter)",
    expectedRating: ["RISKY"],
    scoreRange: [0, 25],
    expectedPillars: {
      ai_training: true,
      data_selling: true,
      transparency: false,
      data_retention: false,
      content_ownership: true,
    },
    text: `X TERMS OF SERVICE (Effective November 15, 2024)

1. Who May Use the Services
You may use the Services only if you agree to form a binding contract with X and are not a person barred from receiving services under the laws of the applicable jurisdiction. In any case, you must be at least 13 years old to use the Services.

2. Privacy
Our Privacy Policy (https://x.com/privacy) describes how we handle the information you provide to us when you use the Services. You understand that through your use of the Services you consent to the collection and use (as set forth in the Privacy Policy) of this information, including the transfer of this information to the United States, Ireland, and/or other countries for storage, processing and use by X and its affiliates.

3. Content on the Services
You are responsible for your use of the Services and for any Content you provide, including compliance with applicable laws, rules, and regulations. You retain ownership rights in the Content you submit, post or display on or through the Services. What's yours is yours — you own your Content.

By submitting, posting or displaying Content on or through the Services, you grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit, display, upload, download, and distribute such Content in any and all media or distribution methods now known or later developed, for any purpose, including for promoting X, its products and services. This license authorizes us to make your Content available to the rest of the world and to let others do the same. You agree that this license includes the right for us to (i) analyze text and other information you provide and to otherwise provide, promote, and improve the Services, including, for example, for use with and training of our machine learning and artificial intelligence models, whether generative or another type; and (ii) make Content submitted to or through the Services available to other companies, organizations or individuals, including for the syndication, broadcast, distribution, repost, promotion or publication of such Content on other media and services, subject to our terms and conditions for such Content use.

4. Using the Services
We may also remove or refuse to distribute any Content on the Services, limit distribution or visibility, suspend or terminate users, reclaim usernames, and make Content available to other companies, organizations, or individuals.

5. Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE X ENTITIES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES. IN NO EVENT SHALL THE AGGREGATE LIABILITY OF THE X ENTITIES EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS (U.S. $100.00) OR THE AMOUNT YOU PAID US, IF ANY, IN THE PAST SIX MONTHS FOR THE SERVICES GIVING RISE TO THE CLAIM.

6. Disputes
You also waive the right to participate as a plaintiff or class member in any purported class action, collective action or representative action proceeding against us or our corporate affiliates. If such a dispute arises, we and you agree to submit the dispute to binding individual arbitration.

7. General
These Terms are the entire and exclusive agreement between you and X Corp regarding use of the Services. If the arbitration provision is found unenforceable, any dispute shall not be heard as a class action.`,
  },
  {
    service: "TikTok",
    expectedRating: ["RISKY"],
    scoreRange: [0, 15],
    expectedPillars: {
      ai_training: true,
      data_selling: true,
      transparency: false,
      data_retention: true,
      content_ownership: true,
    },
    text: `TIKTOK TERMS OF SERVICE (Last updated: November 2024)

1. Your Relationship With Us
Welcome to TikTok, a platform enabling creation, sharing, and discovery of short-form videos (the "Platform"). TikTok is provided by TikTok LLC.

2. Accepting these Terms
By accessing or using our Platform, you confirm that you can form a binding contract with TikTok. You must be at least 13 years old to use the Platform.

3. Your Account
When you create a TikTok account, we collect information about you. We may assign you a username. You are responsible for safeguarding your password and for any activities under your account. We collect device IDs, IP addresses, browsing and search history, cookies, the content of messages you send through TikTok, and metadata about the content you create. We may collect information from third parties including social media platforms, advertising partners, and data brokers. Information about you is also generated or collected automatically such as approximate location based on your SIM card, IP Address, age range, gender, and interests.

4. Your Content
You retain your rights to any Content you submit, post or display on or through TikTok. By posting content, you grant TikTok a worldwide, non-exclusive, royalty-free, transferable, sublicensable license to use, reproduce, distribute, modify, adapt, publish, translate, create derivative works from, make available, communicate and display your User Content including any name, username, voice or likeness in such User Content, in whole or in part, in connection with the Platform and TikTok's (and its successors' and affiliates') business, including for promoting, redistributing, and displaying the Platform, in any media formats and through any media channels now known or subsequently developed.

You also grant TikTok an unrestricted, worldwide, irrevocable, fully paid, and royalty-free license to use the User Content, including to reproduce, modify and use for training machine learning, artificial intelligence, and similar technologies, without any further consent, notice, or compensation to you or any third party. There is currently no way to opt out of this use.

5. Advertising and Commercial Content
We and our third-party providers and partners may place advertising on the Services or in connection with the display of Content or information from the Services whether submitted by you or others. We may use the information we collect about you to provide and improve the Platform, for targeted advertising and measurement, and to share with third-party advertising and analytics partners, including advertising networks, analytics providers, and social media platforms.

6. Data Practices
We retain your information for as long as we need it to provide you the Platform. We may also retain data for legitimate business, legal, regulatory, tax, and accounting purposes. Following account deletion, certain data may be retained for a reasonable period consistent with our data retention policies and applicable laws.

7. Limitation of Liability
IN NO EVENT SHALL TIKTOK'S AGGREGATE LIABILITY EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS ($100.00) OR THE AMOUNT YOU PAID TIKTOK IN THE SIX MONTHS PRECEDING THE CLAIM.

YOU AGREE TO RESOLVE ANY DISPUTES THROUGH BINDING INDIVIDUAL ARBITRATION AND WAIVE YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION.

8. Contact Us
For any questions, contact us at legal@tiktok.com.`,
  },
  {
    service: "Signal",
    expectedRating: ["SAFE", "OKAY"],
    scoreRange: [75, 100],
    expectedPillars: {
      ai_training: false,
      data_selling: false,
      transparency: false,
      data_retention: false,
      content_ownership: false,
    },
    text: `SIGNAL TERMS OF SERVICE & PRIVACY POLICY

Signal Messenger LLC ("Signal", "we", "us", or "our") provides the Signal messaging application and related services (the "Service").

Privacy & Security
Signal is designed to never collect or store sensitive information. Messages are end-to-end encrypted, and Signal does not have access to the content of messages or calls sent through the Service.

Data We Collect
Signal does not sell, rent, or monetize your personal data or content in any way – ever. We store only the minimal data needed to operate: your phone number (for registration), randomly generated authentication tokens, and profile information you choose to provide (name and avatar). We do not store message contents, contact lists, groups, group names, group memberships, or any location information.

No Advertising, No Tracking
Signal does not serve ads. There is no advertiser tracking, no analytics partnerships, and we do not share data with any third parties. Signal is funded by donations through the Signal Technology Foundation, a 501(c)(3) nonprofit.

Content Ownership
You own your messages and content. Signal claims no license or rights to your communications beyond what is strictly necessary to transmit messages between users in real time. We do not store message content on our servers after delivery.

AI & Machine Learning
Signal does not use any user data for AI training, machine learning, or any automated decision-making. We do not have access to message content, so training on user communications is technically impossible.

Data Retention & Deletion
When you delete your account, we permanently remove your data from our servers within 30 days. We do not retain backup copies of message content because we never store them in the first place.

Security
We employ state-of-the-art end-to-end encryption (Signal Protocol) for all messages and calls. Our source code is publicly available and has been independently audited.

Limitation of Liability
Signal's total liability shall not exceed $500 or the amount you paid in the 12 months preceding the claim, whichever is greater. This is a reasonable limitation given that Signal is a free service funded by donations.

Changes to Terms
We may update these terms. If we make material changes, we will notify you within the app at least 30 days before they take effect.

Contact
privacy@signal.org`,
  },
  {
    service: "DuckDuckGo",
    expectedRating: ["SAFE", "OKAY"],
    scoreRange: [75, 100],
    expectedPillars: {
      ai_training: false,
      data_selling: false,
      transparency: false,
      data_retention: false,
      content_ownership: false,
    },
    text: `DUCKDUCKGO TERMS OF SERVICE

DuckDuckGo provides a privacy-focused search engine and related products (the "Service"). By using DuckDuckGo, you agree to the following terms.

Privacy First
DuckDuckGo does not track you. We do not collect or store personal information. When you search on DuckDuckGo, we do not know who you are. We don't use cookies to identify you. We don't log your IP address. We don't store your search history.

No Personal Data Collection
We don't collect: IP addresses, user agent strings tied to searches, unique identifiers, search history linked to any individual, or any form of personal data that could identify you.

Advertising
DuckDuckGo generates revenue through non-tracking, contextual advertising. Ads are based on the search keywords you enter, not on your personal data or browsing history. Our advertising partners do not receive any personal information about you. No tracking cookies, no personal profiles.

Content & Intellectual Property
All DuckDuckGo trademarks, logos, and service marks are our property. Search results contain content from third parties, and those third parties retain their intellectual property rights. We do not claim any ownership rights over content you access through our search results.

No AI Training on User Data
DuckDuckGo does not use any user search data for AI model training, machine learning, or similar technologies. Your searches are not stored in any form that could be used for training purposes.

Data Retention
Since we do not collect personal data, there is nothing to retain. Search queries are not logged or stored in any personally identifiable form. Aggregate, non-personal statistics may be retained to improve our service.

Limitation of Liability
DuckDuckGo's liability is limited to the greater of $100 or the amount paid for our services in the 12 months prior to the claim. We are not liable for indirect, incidental, or consequential damages.

Governing Law
These terms are governed by the laws of the Commonwealth of Pennsylvania, United States.

Changes
We may modify these Terms at any time. We will notify you of material changes by posting updates to our website.

Contact: legal@duckduckgo.com`,
  },
  {
    service: "Spotify",
    expectedRating: ["RISKY", "OKAY"],
    scoreRange: [5, 45],
    expectedPillars: {
      ai_training: false,
      data_selling: true,
      transparency: false,
      data_retention: false,
      content_ownership: true,
    },
    text: `SPOTIFY TERMS OF USE (Last Updated: August 26, 2025)

1. Introduction
By signing up for, or otherwise using, the Spotify Service, you agree to these Terms. If you do not agree to these Terms, then you must not use the Spotify Service or access any Content.

THESE TERMS CONTAIN A MANDATORY ARBITRATION PROVISION THAT, AS FURTHER SET FORTH IN SECTION 6 BELOW, REQUIRES THE USE OF ARBITRATION ON AN INDIVIDUAL BASIS TO RESOLVE DISPUTES, RATHER THAN JURY TRIALS OR ANY OTHER COURT PROCEEDINGS, OR CLASS ACTIONS OF ANY KIND. IN ARBITRATION THERE IS LESS DISCOVERY AND APPELLATE REVIEW THAN IN COURT.

2. The Spotify Service
We use reasonable efforts to keep the Spotify Service operational. However, Spotify reserves the right to change our Spotify Service offerings and their availability from time to time, without notice or liability to you. Spotify has no obligation to provide any specific content through the Spotify Service, and Spotify or the applicable owners may remove access to particular songs, videos, podcasts, audiobooks and other Content without notice.

3. Your Use of the Spotify Service
Subject to your compliance with these Terms, we grant to you limited, non-exclusive, revocable permission to make personal, non-commercial use of the Spotify Service and the Content.

Content you post on the Spotify Service:
You retain ownership of your User Content when you post it to the Spotify Service. However, you hereby grant to Spotify a non-exclusive, transferable, sublicensable, royalty-free, fully paid, irrevocable, worldwide license to reproduce, make available, perform and display, translate, modify, create derivative works from, distribute, and otherwise use any such User Content through any medium, whether alone or in combination with other Content or materials, in any manner and by any means, method or technology, whether now known or hereafter created, in connection with the Spotify Service. Where applicable and to the extent permitted under applicable law, you also agree to waive, and not to enforce, any "moral rights" or equivalent rights, such as your right to be identified as the author of any User Content.

If you provide ideas, suggestions, or other feedback in connection with your use of the Spotify Service or any Content ("Feedback"), such Feedback is not confidential and may be used by Spotify without restriction and without payment to you.

You also grant to us the right (1) to allow the Spotify Service to use the processor, bandwidth, and storage hardware on your Device in order to facilitate the operation of the Spotify Service, and (2) to provide advertising and other information to you, and (3) to allow our business partners to do the same.

In any part of the Spotify Service, the Content that you access, including its selection and placement, may be influenced by commercial considerations, including Spotify's agreements with third parties.

4. Warranty Disclaimers
THE SPOTIFY SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT ANY WARRANTIES OF ANY KIND.

5. Limitation of Liability
TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL SPOTIFY BE LIABLE FOR ANY INDIRECT, SPECIAL, INCIDENTAL, PUNITIVE, EXEMPLARY, OR CONSEQUENTIAL DAMAGES. AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SPOTIFY SERVICE MORE THAN THE GREATER OF (A) THE AMOUNTS PAID BY YOU TO SPOTIFY DURING THE TWELVE MONTHS PRIOR TO THE FIRST CLAIM; OR (B) $30.00.

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, ANY CLAIM ARISING UNDER THESE TERMS MUST BE COMMENCED WITHIN ONE (1) YEAR AFTER THE DATE THE PARTY ASSERTING THE CLAIM FIRST KNOWS OR REASONABLY SHOULD KNOW OF THE ACT.

6. Dispute Resolution
YOU AND SPOTIFY AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER IN ARBITRATION OR LITIGATION ONLY IN YOUR OR ITS INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, PRIVATE ATTORNEY GENERAL, OR REPRESENTATIVE ACTION.

Any Dispute between you and Spotify will be determined by binding individual arbitration. THERE IS NO JUDGE OR JURY IN ARBITRATION.

7. About These Terms
Spotify may assign any or all of these Terms, and may assign or delegate, in whole or in part, any of its rights or obligations under these Terms. You may not assign these Terms.`,
  },
];

const PILLAR_KEYS = [
  "ai_training",
  "data_selling",
  "transparency",
  "data_retention",
  "content_ownership",
] as const;

// The 5 candidates + baseline
const MODELS = [
  "qwen/qwq-32b",
  "deepseek-ai/deepseek-v3.2",
  "qwen/qwen3.5-397b-a17b",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "qwen/qwen3-next-80b-a3b-instruct", // baseline from round 1
];

const RUNS_PER_CASE = 2;

interface RunResult {
  model: string;
  service: string;
  run: number;
  latencyMs: number;
  parseOk: boolean;
  ratingMatch: boolean;
  scoreInRange: boolean;
  pillarCorrect: number;
  pillarTotal: number;
  pillarDetails: Record<string, { expected: boolean; got: boolean; match: boolean }>;
  predicted: { rating?: string; score?: number; pillars?: any } | null;
  error?: string;
}

async function runDeepScan(
  model: string,
  tc: GroundTruth,
  runNum: number
): Promise<RunResult> {
  const result: RunResult = {
    model,
    service: tc.service,
    run: runNum,
    latencyMs: 0,
    parseOk: false,
    ratingMatch: false,
    scoreInRange: false,
    pillarCorrect: 0,
    pillarTotal: 5,
    pillarDetails: {},
    predicted: null,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s total timeout for deep reasoning
  const start = Date.now();

  try {
    const resp = await nimCreateWithRetry(
      {
        model,
        messages: [
          { role: "system", content: DEEP_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze this Terms of Service document thoroughly. Extract ALL violations present:\n\n${tc.text}`,
          },
        ],
        temperature: 0,
        max_tokens: 1400,
      },
      controller.signal
    );

    result.latencyMs = Date.now() - start;

    if (!resp) {
      result.error = "All API keys exhausted";
      return result;
    }

    const raw = resp.choices[0]?.message?.content || "{}";
    const parsed = extractJSON(raw);

    if (!parsed) {
      result.error = "JSON parse failed";
      return result;
    }

    result.parseOk = true;

    // Normalize rating by score
    if (typeof parsed.score === "number" && typeof parsed.rating === "string") {
      if (parsed.score < 50) parsed.rating = "RISKY";
      else if (parsed.score < 75 && parsed.rating === "SAFE")
        parsed.rating = "OKAY";
      else if (parsed.score >= 75 && parsed.rating === "RISKY")
        parsed.rating = "OKAY";
    }

    result.predicted = {
      rating: parsed.rating,
      score: parsed.score,
      pillars: parsed.pillars,
    };

    // Check rating
    result.ratingMatch = tc.expectedRating.includes(parsed.rating);

    // Check score range
    result.scoreInRange =
      typeof parsed.score === "number" &&
      parsed.score >= tc.scoreRange[0] &&
      parsed.score <= tc.scoreRange[1];

    // Check pillars
    if (parsed.pillars) {
      for (const key of PILLAR_KEYS) {
        const expected = tc.expectedPillars[key];
        const got = Boolean(parsed.pillars?.[key]?.violation);
        const match = got === expected;
        result.pillarDetails[key] = { expected, got, match };
        if (match) result.pillarCorrect++;
      }
    }
  } catch (e: any) {
    result.latencyMs = Date.now() - start;
    result.error = e?.message ?? String(e);
  } finally {
    clearTimeout(timeout);
  }

  return result;
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║    TLDR SHIELD — DEEP SCAN MODEL SELECTION TEST          ║");
  console.log("║    Testing 6 models × 5 services × 2 runs = 60 calls    ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const allResults: RunResult[] = [];
  let md = "# Deep Scan Stress Test Results\n\n";
  md += `> Testing ${MODELS.length} models × ${TEST_CASES.length} services × ${RUNS_PER_CASE} runs = ${MODELS.length * TEST_CASES.length * RUNS_PER_CASE} total API calls\n\n`;

  for (const tc of TEST_CASES) {
    const pad = Math.floor((55 - tc.service.length) / 2);
    md += "=======================================================\n";
    md += `${" ".repeat(pad)}${tc.service}\n`;
    md += `Expected: ${tc.expectedRating.join("/")} | Score: ${tc.scoreRange[0]}-${tc.scoreRange[1]}\n`;
    md += `Ground Truth Violations: ${PILLAR_KEYS.filter((k) => tc.expectedPillars[k]).join(", ") || "None"}\n`;

    for (const model of MODELS) {
      const modelPad = Math.floor((55 - model.length) / 2);
      md += "-------------------------------------------------------\n";
      md += `${" ".repeat(modelPad)}${model}\n`;

      const runResults: RunResult[] = [];

      for (let run = 1; run <= RUNS_PER_CASE; run++) {
        console.log(`Running ${tc.service} -> ${model} (run ${run})...`);
        const r = await runDeepScan(model, tc, run);
        allResults.push(r);
        runResults.push(r);

        if (r.parseOk && r.predicted) {
          const latencyFlag =
            r.latencyMs > 20000
              ? ` ⚠️ EXCEEDS 20s`
              : " ✅";
          const violations = r.predicted.pillars
            ? PILLAR_KEYS.filter((k) => r.predicted!.pillars?.[k]?.violation).join(", ")
            : "?";
          const pillarMisses = Object.entries(r.pillarDetails)
            .filter(([, d]) => !d.match)
            .map(([k, d]) => `${k}(exp=${d.expected},got=${d.got})`)
            .join(", ");

          md += `**Run ${run}:** Rating: ${r.predicted.rating}, Score: ${r.predicted.score}, Violations: ${violations || "None"} [${(r.latencyMs / 1000).toFixed(2)}s${latencyFlag}]\n`;
          md += `  Pillar Accuracy: ${r.pillarCorrect}/${r.pillarTotal}`;
          if (pillarMisses) md += ` | MISSES: ${pillarMisses}`;
          md += `\n`;
        } else {
          md += `**Run ${run}:** Error: ${r.error} [${(r.latencyMs / 1000).toFixed(2)}s]\n`;
        }

        // Progressive save
        fs.writeFileSync("deepscan_result.md", md, "utf-8");

        // Rate limit
        await new Promise((r) => setTimeout(r, 2500));
      }

      // Consistency check
      const parsed = runResults.filter((r) => r.parseOk);
      const ratings = parsed.map((r) => r.predicted?.rating);
      const consistent = new Set(ratings).size <= 1;
      if (parsed.length === RUNS_PER_CASE) {
        md += `  Consistency: ${consistent ? "✅ CONSISTENT" : "⚠️ INCONSISTENT (" + ratings.join(" vs ") + ")"}\n`;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // AGGREGATE SUMMARY
  // ══════════════════════════════════════════════════════════════
  md += "\n=======================================================\n";
  md += "              AGGREGATE SUMMARY\n";
  md += "=======================================================\n\n";

  md += "| Model | Parse Rate | Rating Acc | Score Acc | Pillar Acc | Avg Latency | Consistency |\n";
  md += "|-------|-----------|-----------|-----------|-----------|------------|-------------|\n";

  for (const model of MODELS) {
    const modelResults = allResults.filter((r) => r.model === model);
    const parsed = modelResults.filter((r) => r.parseOk);
    const ratingOk = parsed.filter((r) => r.ratingMatch);
    const scoreOk = parsed.filter((r) => r.scoreInRange);
    const totalPillars = parsed.reduce((s, r) => s + r.pillarTotal, 0);
    const correctPillars = parsed.reduce((s, r) => s + r.pillarCorrect, 0);
    const avgLatency =
      parsed.length > 0
        ? parsed.reduce((s, r) => s + r.latencyMs, 0) / parsed.length
        : 0;

    // Consistency: check each service's 2 runs
    let consistentCount = 0;
    let totalServices = 0;
    for (const tc of TEST_CASES) {
      const serviceRuns = parsed.filter((r) => r.service === tc.service);
      if (serviceRuns.length === RUNS_PER_CASE) {
        totalServices++;
        const ratings = serviceRuns.map((r) => r.predicted?.rating);
        if (new Set(ratings).size <= 1) consistentCount++;
      }
    }

    const parseRate = `${parsed.length}/${modelResults.length}`;
    const ratingAcc = parsed.length > 0 ? `${ratingOk.length}/${parsed.length} (${((ratingOk.length / parsed.length) * 100).toFixed(0)}%)` : "N/A";
    const scoreAcc = parsed.length > 0 ? `${scoreOk.length}/${parsed.length} (${((scoreOk.length / parsed.length) * 100).toFixed(0)}%)` : "N/A";
    const pillarAcc = totalPillars > 0 ? `${correctPillars}/${totalPillars} (${((correctPillars / totalPillars) * 100).toFixed(1)}%)` : "N/A";
    const latencyStr = avgLatency > 0 ? `${(avgLatency / 1000).toFixed(2)}s` : "N/A";
    const consistStr = totalServices > 0 ? `${consistentCount}/${totalServices}` : "N/A";

    md += `| ${model} | ${parseRate} | ${ratingAcc} | ${scoreAcc} | ${pillarAcc} | ${latencyStr} | ${consistStr} |\n`;
  }

  md += "\n";
  fs.writeFileSync("deepscan_result.md", md, "utf-8");
  console.log("\nDone. Results saved to deepscan_result.md");
}

main();
