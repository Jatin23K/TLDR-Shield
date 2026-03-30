/**
 * TLDR Shield — Real-World Stress Test
 * =====================================
 * Tests the analysis pipeline against REAL Terms of Service from:
 *   1. X (Twitter)       — Highly invasive, AI training, broad licensing
 *   2. TikTok            — Aggressive data collection, AI training
 *   3. Signal            — Privacy-focused, minimal data
 *   4. DuckDuckGo        — Privacy-focused, no tracking
 *   5. Spotify           — Moderate, broad content license, arbitration
 *
 * Each service has ground-truth pillar expectations derived from
 * manual legal review of their actual ToS as of March 2026.
 *
 * Run:  npx tsx eval/stress_test.ts
 * Flags:
 *   --tier=quick|deep       Run only one tier (default: both)
 *   --dark                  Include dark_patterns pillar
 *   --runs=N                Number of repeat runs per case (default: 2)
 *   --verbose               Print full LLM responses
 */

import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
type Tier = "quick" | "deep";
type Rating = "SAFE" | "OKAY" | "RISKY";

const NIM_KEYS = [
  process.env.NIM_API_KEY_1,
  process.env.NIM_API_KEY_2,
  process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

if (NIM_KEYS.length === 0) {
  console.error("❌ No NIM API keys found. Set NIM_API_KEY_1 in .env");
  process.exit(1);
}

const QUICK_MODEL = (process.env.NIM_MODEL_QUICK || "meta/llama-3.3-70b-instruct").trim();
const DEEP_MODEL = (process.env.NIM_MODEL_DEEP || "meta/llama-3.3-70b-instruct").trim();

const MODELS: Record<Tier, { id: string; maxTokens: number; temperature: number; timeoutMs: number }> = {
  quick: { id: QUICK_MODEL, maxTokens: 750, temperature: 0, timeoutMs: 30000 },
  deep:  { id: DEEP_MODEL,  maxTokens: 1400, temperature: 0, timeoutMs: 45000 },
};

let nimKeyIndex = 0;
const PER_KEY_TIMEOUT_MS = 18000;

// ═══════════════════════════════════════════════════════════════════════════════
// NIM API CLIENT (mirrors server.ts retry logic)
// ═══════════════════════════════════════════════════════════════════════════════
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
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON EXTRACTION (mirrors server.ts)
// ═══════════════════════════════════════════════════════════════════════════════
function extractJSON(text: string): any | null {
  const clean = (src: string) =>
    src.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const normalize = (raw: string) => raw.replace(/,\s*([}\]])/g, "$1");
  const tryParse = (raw: string): any | null => {
    try { return JSON.parse(raw); } catch { return null; }
  };
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

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT (mirrors server.ts buildSystemPrompt)
// ═══════════════════════════════════════════════════════════════════════════════
function buildSystemPrompt(darkPatterns: boolean, tier: Tier): string {
  if (tier === "quick") {
    const extraPillar = darkPatterns
      ? ", dark_patterns (liability cap under $1000 OR class action waiver OR shortened statute of limitations OR forced arbitration?)"
      : "";
    return `You are a privacy attorney giving an instant verdict. Be STRICT. Scan for: ai_training (ANY mention of AI/ML training using user content = violation), data_selling (content/data shared with advertisers or third-party companies = violation), transparency (deliberately vague/obscuring language?), data_retention (retention >1yr post-deletion or completely unspecified?), content_ownership (worldwide sublicensable license "for any purpose" beyond platform use = violation)${extraPillar}.

SCORING: 0 violations+clear→90-100 SAFE | 0+vague→75-89 OKAY | 1 low→50-74 OKAY | 1 high or 2→25-49 RISKY | 3-4→10-24 RISKY | 5-6→0-9 RISKY.
MANDATORY: score<50 MUST be RISKY. score 50-74 MUST be OKAY. score≥75 = SAFE or OKAY.

Output ONLY valid JSON, no markdown, no pillars detail:
{"rating":"SAFE"|"OKAY"|"RISKY","score":0-100,"tldr":"2-sentence plain-English verdict. Name the single biggest risk if any."}`;
  }

  const darkField = darkPatterns
    ? ',\n    "dark_patterns": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }'
    : "";
  const darkPillar = darkPatterns
    ? "\n6. dark_patterns — Unfair or one-sided clauses: liability capped at trivially small amounts (e.g. $100), forced class action waivers, shortened statutes of limitations, one-sided termination rights, hidden arbitration clauses."
    : "";

  return `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data used for AI/ML model training, fine-tuning, or improvement, with no clear user opt-out? VIOLATION EXAMPLES: "for use with and training of our machine learning and artificial intelligence models", "to train our AI", "improve our AI systems using your data". Even if bundled into a broad license clause, if AI training is mentioned = VIOLATION.
2. data_selling     — Content or personal data shared with third parties (advertisers, partners, other companies) beyond what is strictly needed to operate the service? VIOLATION EXAMPLES: content syndicated/distributed to "other companies, organizations or individuals", advertising partners targeting users with their data, data shared for "commercial use". Sharing for advertising = VIOLATION.
3. transparency     — Language deliberately vague, contradictory, or designed to obscure practices? VIOLATION EXAMPLES: key rights buried in dense legalese, critical data practices only referenced via external links, no plain-language explanation of data use.
4. data_retention   — No stated deletion timeline, or retention exceeds 1 year post-account-deletion? Delegating entirely to another document without specifics = borderline violation.
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform? VIOLATION EXAMPLES: worldwide royalty-free sublicensable license "for any purpose", right to modify/adapt/redistribute content, no compensation for commercial reuse of content.${darkPillar}

VIOLATION RULES:
- ai_training: ANY mention of using user content/data for AI or ML training = VIOLATION, no exceptions.
- data_selling: Sharing content with advertisers, partners, or "other companies" for their commercial benefit = VIOLATION.
- content_ownership: "for any purpose" or sublicensable worldwide license that goes beyond just showing content on the platform = VIOLATION.
- dark_patterns: $100 or similarly tiny liability cap = VIOLATION. Class action waiver = VIOLATION. Shortened statute of limitations (under 2 years) = VIOLATION.
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
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }${darkField}
  }
}

CONFIDENCE RULES:
- HIGH: You found an explicit, unambiguous clause. Citation is a direct verbatim quote.
- MEDIUM: Clause exists but requires some interpretation.
- LOW: Inferred from indirect language.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUND-TRUTH TEST CASES — REAL ToS TEXT
// ═══════════════════════════════════════════════════════════════════════════════

interface TestCase {
  id: string;
  service: string;
  text: string;
  expected: {
    rating: Rating;
    ratingAcceptable: Rating[];   // any of these = correct
    pillars: {
      ai_training: boolean;
      data_selling: boolean;
      transparency: boolean;
      data_retention: boolean;
      content_ownership: boolean;
      dark_patterns?: boolean;
    };
    scoreRange: [number, number]; // [min, max] acceptable score range
  };
}

const TEST_CASES: TestCase[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. X (TWITTER) — Should be RISKY
  // AI training explicit, broad worldwide sublicensable license, data shared
  // with advertisers, forced arbitration, class action waiver, $100 liability cap
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: "x_twitter_tos",
    service: "X (Twitter)",
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

    expected: {
      rating: "RISKY",
      ratingAcceptable: ["RISKY"],
      pillars: {
        ai_training: true,         // "training of our machine learning and artificial intelligence models"
        data_selling: true,        // "make Content available to other companies, organizations or individuals"
        transparency: false,       // ToS is relatively clear and well-structured
        data_retention: false,     // Delegates to privacy policy — not a direct ToS violation
        content_ownership: true,   // "worldwide, non-exclusive, royalty-free license (with the right to sublicense)... for any purpose"
        dark_patterns: true,       // $100 liability cap + class action waiver + forced arbitration
      },
      scoreRange: [0, 25],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. TIKTOK — Should be RISKY
  // AI training, broad license, advertising data sharing, vague deletion
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: "tiktok_tos",
    service: "TikTok",
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

    expected: {
      rating: "RISKY",
      ratingAcceptable: ["RISKY"],
      pillars: {
        ai_training: true,         // "training machine learning, artificial intelligence... no way to opt out"
        data_selling: true,        // Advertising partners, data brokers, third-party providers
        transparency: false,       // Text is reasonably clear about what it does
        data_retention: true,      // "a reasonable period" — no specific timeline
        content_ownership: true,   // "unrestricted, worldwide, irrevocable" license
        dark_patterns: true,       // $100 liability cap + class action waiver + arbitration
      },
      scoreRange: [0, 15],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SIGNAL — Should be SAFE
  // Privacy-focused, minimal data collection, no AI, no ads
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: "signal_tos",
    service: "Signal",
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

    expected: {
      rating: "SAFE",
      ratingAcceptable: ["SAFE", "OKAY"],
      pillars: {
        ai_training: false,
        data_selling: false,
        transparency: false,
        data_retention: false,
        content_ownership: false,
        dark_patterns: false,
      },
      scoreRange: [75, 100],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. DUCKDUCKGO — Should be SAFE
  // Privacy-focused search, no personal data collection
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: "duckduckgo_tos",
    service: "DuckDuckGo",
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

    expected: {
      rating: "SAFE",
      ratingAcceptable: ["SAFE", "OKAY"],
      pillars: {
        ai_training: false,
        data_selling: false,
        transparency: false,
        data_retention: false,
        content_ownership: false,
        dark_patterns: false,
      },
      scoreRange: [75, 100],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. SPOTIFY — Should be RISKY (with dark patterns) / OKAY-RISKY (without)
  // Broad content license, mandatory arbitration, class action waiver
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: "spotify_tos",
    service: "Spotify",
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

    expected: {
      rating: "RISKY",
      ratingAcceptable: ["RISKY", "OKAY"],
      pillars: {
        ai_training: false,        // No AI training mentioned in Spotify ToS
        data_selling: true,        // "advertising and other information to you" + "business partners to do the same" + commercial considerations
        transparency: false,       // ToS is reasonably clear
        data_retention: false,     // Not addressed — absence ≠ violation
        content_ownership: true,   // "irrevocable, worldwide license... modify, create derivative works... moral rights waiver"
        dark_patterns: true,       // $30 liability cap + class action waiver + 1yr statute + forced arbitration
      },
      scoreRange: [5, 45],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING & EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════
const PILLAR_KEYS = ["ai_training", "data_selling", "transparency", "data_retention", "content_ownership"] as const;
const ALL_PILLAR_KEYS = [...PILLAR_KEYS, "dark_patterns"] as const;

function normalizeRatingByScore(result: any): any {
  if (!result || typeof result.score !== "number" || typeof result.rating !== "string") return result;
  if (result.score < 50) result.rating = "RISKY";
  else if (result.score < 75) result.rating = result.rating === "SAFE" ? "OKAY" : result.rating;
  else if (result.score >= 75 && result.rating === "RISKY") result.rating = "OKAY";
  return result;
}

interface CaseResult {
  id: string;
  service: string;
  tier: Tier;
  run: number;
  parseOk: boolean;
  latencyMs: number;
  ratingMatch: boolean;
  scoreInRange: boolean;
  pillarAccuracy: { correct: number; total: number; details: Record<string, { expected: boolean; got: boolean; match: boolean }> };
  citationQuality: { total: number; verbatim: number; paraphrased: number; missing: number };
  predicted: any;
  error?: string;
}

function evaluateCase(tc: TestCase, result: any, tier: Tier, run: number, latencyMs: number, darkPatterns: boolean): CaseResult {
  const base: CaseResult = {
    id: tc.id, service: tc.service, tier, run, parseOk: false,
    latencyMs, ratingMatch: false, scoreInRange: false,
    pillarAccuracy: { correct: 0, total: 0, details: {} },
    citationQuality: { total: 0, verbatim: 0, paraphrased: 0, missing: 0 },
    predicted: null,
  };

  if (!result) return base;
  base.parseOk = true;
  base.predicted = { rating: result.rating, score: result.score, pillars: result.pillars };
  base.ratingMatch = tc.expected.ratingAcceptable.includes(result.rating);
  base.scoreInRange = typeof result.score === "number" && result.score >= tc.expected.scoreRange[0] && result.score <= tc.expected.scoreRange[1];

  // Pillar accuracy (deep tier only)
  if (tier === "deep" && result.pillars) {
    const keys = darkPatterns ? ALL_PILLAR_KEYS : PILLAR_KEYS;
    for (const k of keys) {
      const expected = (tc.expected.pillars as any)[k];
      if (typeof expected !== "boolean") continue;
      const got = Boolean(result.pillars?.[k]?.violation);
      const match = got === expected;
      base.pillarAccuracy.total++;
      if (match) base.pillarAccuracy.correct++;
      base.pillarAccuracy.details[k] = { expected, got, match };
    }

    // Citation quality check
    for (const k of keys) {
      const p = result.pillars?.[k];
      if (!p?.citation) continue;
      base.citationQuality.total++;
      const c = p.citation.trim();
      if (c === "Not addressed in document." || c === "Not addressed." || c.length < 15) {
        base.citationQuality.missing++;
      } else if (/^(The policy|The terms|The document|This policy|There is no|There are no|No mention)/i.test(c)) {
        base.citationQuality.paraphrased++;
      } else {
        base.citationQuality.verbatim++;
      }
    }
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════
async function runStressTest() {
  const tierArg = process.argv.find(a => a.startsWith("--tier="))?.split("=")[1] as Tier | undefined;
  const darkPatterns = process.argv.includes("--dark");
  const verbose = process.argv.includes("--verbose");
  const runsPerCase = parseInt(process.argv.find(a => a.startsWith("--runs="))?.split("=")[1] ?? "2");
  const tiers: Tier[] = tierArg ? [tierArg] : ["quick", "deep"];

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║           TLDR SHIELD — REAL-WORLD STRESS TEST                  ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Models:    quick=${QUICK_MODEL}`);
  console.log(`║             deep=${DEEP_MODEL}`);
  console.log(`║  Cases:     ${TEST_CASES.length} services × ${runsPerCase} runs × ${tiers.length} tier(s)`);
  console.log(`║  Dark:      ${darkPatterns}`);
  console.log(`║  Total:     ${TEST_CASES.length * runsPerCase * tiers.length} API calls`);
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  const allResults: CaseResult[] = [];

  for (const tier of tiers) {
    console.log(`\n${"═".repeat(66)}`);
    console.log(`  TIER: ${tier.toUpperCase()} (model: ${MODELS[tier].id})`);
    console.log(`${"═".repeat(66)}`);

    for (const tc of TEST_CASES) {
      console.log(`\n  ┌─ ${tc.service} (${tc.id})`);
      console.log(`  │  Expected: ${tc.expected.rating} | Score: ${tc.expected.scoreRange[0]}-${tc.expected.scoreRange[1]}`);
      if (tier === "deep") {
        const violations = Object.entries(tc.expected.pillars)
          .filter(([, v]) => v)
          .map(([k]) => k);
        const clear = Object.entries(tc.expected.pillars)
          .filter(([, v]) => !v)
          .map(([k]) => k);
        console.log(`  │  Violations: ${violations.length > 0 ? violations.join(", ") : "NONE"}`);
        console.log(`  │  Clear:      ${clear.join(", ")}`);
      }

      for (let run = 0; run < runsPerCase; run++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), MODELS[tier].timeoutMs);
        const start = Date.now();
        let result: any = null;
        let error: string | undefined;

        try {
          const resp = await nimCreateWithRetry({
            model: MODELS[tier].id,
            messages: [
              { role: "system", content: buildSystemPrompt(darkPatterns, tier) },
              {
                role: "user",
                content: tier === "quick"
                  ? `Analyze this Terms of Service document. Give an instant verdict:\n\n${tc.text}`
                  : `Analyze this Terms of Service document thoroughly. Extract ALL violations present:\n\n${tc.text}`,
              },
            ],
            temperature: MODELS[tier].temperature,
            max_tokens: MODELS[tier].maxTokens,
          }, controller.signal);

          const raw = resp.choices[0]?.message?.content || "{}";
          if (verbose) console.log(`  │  [raw] ${raw.substring(0, 200)}...`);
          result = extractJSON(raw);
          if (result) normalizeRatingByScore(result);
        } catch (e: any) {
          error = e?.message ?? String(e);
        } finally {
          clearTimeout(timeout);
        }

        const elapsed = Date.now() - start;
        const cr = evaluateCase(tc, result, tier, run + 1, elapsed, darkPatterns);
        if (error) cr.error = error;
        allResults.push(cr);

        // Print per-run result
        const rIcon = cr.ratingMatch ? "✅" : "❌";
        const sIcon = cr.scoreInRange ? "✅" : "❌";
        const pIcon = cr.pillarAccuracy.total > 0
          ? (cr.pillarAccuracy.correct === cr.pillarAccuracy.total ? "✅" : `⚠️ ${cr.pillarAccuracy.correct}/${cr.pillarAccuracy.total}`)
          : "—";

        if (cr.parseOk) {
          console.log(`  │  Run ${run + 1}: ${result?.rating?.padEnd(5)} ${String(result?.score).padStart(3)}/100 | ${(elapsed / 1000).toFixed(1)}s | Rating ${rIcon} | Score ${sIcon} | Pillars ${pIcon}`);

          // Show pillar mismatches
          if (tier === "deep" && cr.pillarAccuracy.correct < cr.pillarAccuracy.total) {
            for (const [k, d] of Object.entries(cr.pillarAccuracy.details)) {
              if (!d.match) {
                console.log(`  │    ⛔ ${k}: expected=${d.expected} got=${d.got}`);
              }
            }
          }
        } else {
          console.log(`  │  Run ${run + 1}: PARSE FAIL | ${(elapsed / 1000).toFixed(1)}s | ${error ?? "malformed JSON"}`);
        }

        // Rate limit buffer
        await new Promise(r => setTimeout(r, 1500));
      }
      console.log("  └─");
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // AGGREGATE REPORT
  // ═════════════════════════════════════════════════════════════════════════════
  console.log("\n\n");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    STRESS TEST RESULTS                          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  for (const tier of tiers) {
    const tierResults = allResults.filter(r => r.tier === tier);
    const parsed = tierResults.filter(r => r.parseOk);
    const ratingCorrect = parsed.filter(r => r.ratingMatch);
    const scoreCorrect = parsed.filter(r => r.scoreInRange);
    const latencies = parsed.map(r => r.latencyMs);

    console.log(`\n  ── ${tier.toUpperCase()} TIER ──────────────────────────────────────────`);
    console.log(`  Parse Success:    ${parsed.length}/${tierResults.length} (${((parsed.length / tierResults.length) * 100).toFixed(0)}%)`);
    console.log(`  Rating Accuracy:  ${ratingCorrect.length}/${parsed.length} (${parsed.length > 0 ? ((ratingCorrect.length / parsed.length) * 100).toFixed(0) : 0}%)`);
    console.log(`  Score in Range:   ${scoreCorrect.length}/${parsed.length} (${parsed.length > 0 ? ((scoreCorrect.length / parsed.length) * 100).toFixed(0) : 0}%)`);

    if (tier === "deep") {
      const pillarResults = parsed.filter(r => r.pillarAccuracy.total > 0);
      const totalPillars = pillarResults.reduce((s, r) => s + r.pillarAccuracy.total, 0);
      const correctPillars = pillarResults.reduce((s, r) => s + r.pillarAccuracy.correct, 0);
      console.log(`  Pillar Accuracy:  ${correctPillars}/${totalPillars} (${totalPillars > 0 ? ((correctPillars / totalPillars) * 100).toFixed(0) : 0}%)`);

      // Per-pillar breakdown
      const pillarStats: Record<string, { correct: number; total: number }> = {};
      for (const r of pillarResults) {
        for (const [k, d] of Object.entries(r.pillarAccuracy.details)) {
          if (!pillarStats[k]) pillarStats[k] = { correct: 0, total: 0 };
          pillarStats[k].total++;
          if (d.match) pillarStats[k].correct++;
        }
      }
      console.log("  Per-Pillar:");
      for (const [k, s] of Object.entries(pillarStats)) {
        const pct = ((s.correct / s.total) * 100).toFixed(0);
        const bar = s.correct === s.total ? "✅" : "⚠️";
        console.log(`    ${bar} ${k.padEnd(20)} ${s.correct}/${s.total} (${pct}%)`);
      }

      // Citation quality
      const totalCites = pillarResults.reduce((s, r) => s + r.citationQuality.total, 0);
      const verbatimCites = pillarResults.reduce((s, r) => s + r.citationQuality.verbatim, 0);
      const paraphrasedCites = pillarResults.reduce((s, r) => s + r.citationQuality.paraphrased, 0);
      const missingCites = pillarResults.reduce((s, r) => s + r.citationQuality.missing, 0);
      console.log(`  Citation Quality:`);
      console.log(`    Verbatim:     ${verbatimCites}/${totalCites} (${totalCites > 0 ? ((verbatimCites / totalCites) * 100).toFixed(0) : 0}%)`);
      console.log(`    Paraphrased:  ${paraphrasedCites}/${totalCites} (FAIL — should be 0)`);
      console.log(`    Missing:      ${missingCites}/${totalCites}`);
    }

    if (latencies.length > 0) {
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p90 = latencies[Math.floor(latencies.length * 0.9)];
      console.log(`  Latency:`);
      console.log(`    P50:  ${(p50 / 1000).toFixed(1)}s`);
      console.log(`    P90:  ${(p90 / 1000).toFixed(1)}s`);
      console.log(`    Min:  ${(Math.min(...latencies) / 1000).toFixed(1)}s`);
      console.log(`    Max:  ${(Math.max(...latencies) / 1000).toFixed(1)}s`);
    }

    // Per-service summary for this tier
    console.log(`\n  Per-Service Summary (${tier}):`);
    console.log(`  ${"Service".padEnd(16)} ${"Rating".padEnd(8)} ${"Score".padEnd(10)} ${"Status".padEnd(12)}`);
    console.log(`  ${"─".repeat(50)}`);
    for (const tc of TEST_CASES) {
      const caseResults = parsed.filter(r => r.id === tc.id);
      if (caseResults.length === 0) {
        console.log(`  ${tc.service.padEnd(16)} ${"FAIL".padEnd(8)} ${"N/A".padEnd(10)} Parse Error`);
        continue;
      }
      const ratings = caseResults.map(r => r.predicted?.rating ?? "?");
      const scores = caseResults.map(r => r.predicted?.score ?? "?");
      const allRatingOk = caseResults.every(r => r.ratingMatch);
      const consistentRating = new Set(ratings).size === 1;
      const status = allRatingOk && consistentRating ? "✅ PASS" : allRatingOk ? "⚠️ INCONSISTENT" : "❌ FAIL";
      console.log(`  ${tc.service.padEnd(16)} ${ratings.join(",").padEnd(8)} ${scores.join(",").padEnd(10)} ${status}`);
    }
  }

  // Overall pass/fail
  const totalParsed = allResults.filter(r => r.parseOk);
  const overallRatingAcc = totalParsed.filter(r => r.ratingMatch).length / totalParsed.length * 100;
  const deepResults = allResults.filter(r => r.tier === "deep" && r.parseOk && r.pillarAccuracy.total > 0);
  const overallPillarAcc = deepResults.length > 0
    ? deepResults.reduce((s, r) => s + r.pillarAccuracy.correct, 0) / deepResults.reduce((s, r) => s + r.pillarAccuracy.total, 0) * 100
    : 0;

  console.log("\n\n");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    FINAL VERDICT                                ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Parse Rate:       ${((totalParsed.length / allResults.length) * 100).toFixed(0)}%`);
  console.log(`║  Rating Accuracy:  ${overallRatingAcc.toFixed(0)}%`);
  if (deepResults.length > 0) {
    console.log(`║  Pillar Accuracy:  ${overallPillarAcc.toFixed(0)}%`);
  }
  const passed = (totalParsed.length / allResults.length) >= 0.9
    && overallRatingAcc >= 80
    && (deepResults.length === 0 || overallPillarAcc >= 70);
  console.log(`║  Overall:          ${passed ? "✅ PASS" : "❌ NEEDS IMPROVEMENT"}`);
  console.log("╚══════════════════════════════════════════════════════════════════╝");
}

runStressTest().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
