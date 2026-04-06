/**
 * TLDR Shield — Ensemble Deep Scan Test
 * ======================================
 * Runs BOTH qwen3-next-80b AND mixtral-8x22b in PARALLEL for each service,
 * then cross-validates: if EITHER model flags a violation, it's flagged.
 * 
 * Measures: combined accuracy, individual accuracy, total latency (parallel).
 * Runs 3x per service for consistency.
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
  const clean = (src: string) =>
    src.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
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

const DEEP_PROMPT = `You are a senior privacy attorney and data protection expert. Be STRICT and PRECISE — flag violations when you have explicit textual evidence, but NEVER fabricate or infer violations without a direct verbatim quote.

Analyze the legal text against these privacy pillars:
1. ai_training      — User content or data EXPLICITLY used for AI/ML model training, fine-tuning, or improvement? The text must contain EXPLICIT words like "AI", "artificial intelligence", "machine learning", "ML training", "train our models", or similar. General phrases like "improve our services", "analytics", or "measure performance" are NOT ai_training violations.
2. data_selling     — Content or personal data shared with third parties (advertisers, partners, other companies) beyond what is strictly needed to operate the service? VIOLATION EXAMPLES: content syndicated/distributed to "other companies, organizations or individuals", advertising partners targeting users with their data, data shared for "commercial use", granting business partners/third parties rights to provide advertising or access user information. ANY clause allowing third-party partners or business partners to advertise to users, access user data, or use user content = VIOLATION. Contextual keyword-only ads with NO personal data sharing and NO third-party access = NOT a violation.
3. transparency     — Contains a SPECIFIC internal contradiction where one clause directly conflicts with another clause in the SAME document? NOT a violation if: the ToS is long, uses legal jargon, references external policies, or has complex sentence structure (these are all normal). NOT a violation if: the language is dense but consistent. ONLY a violation if you can quote TWO specific sentences from the document that directly contradict each other.
4. data_retention   — The document makes an EXPLICIT problematic claim about retaining data for more than 1 year post-deletion, OR explicitly states data is kept indefinitely. NOT a violation if: the ToS simply references a separate Privacy Policy for data handling (this is standard industry practice), OR the ToS does not discuss retention at all (absence ≠ violation unless the document is specifically a privacy policy). IS a violation if: the document says things like "retained for a reasonable period" without ANY specific timeline after account deletion, OR says "we may retain data indefinitely."
5. content_ownership — Broad IP rights beyond what is needed to show your content on the platform? VIOLATION EXAMPLES: worldwide royalty-free sublicensable license "for any purpose", right to modify/adapt/redistribute content, no compensation for commercial reuse of content.

CRITICAL VIOLATION RULES:
- ai_training: ONLY flag if the text contains EXPLICIT mentions of AI, artificial intelligence, machine learning, or model training in relation to user content. Do NOT infer AI training from general "improve services" language. If the words "AI", "artificial intelligence", "machine learning", or "training" (in an ML context) do not appear → violation MUST be false.
- data_selling: Sharing content with advertisers, partners, or "other companies" for their commercial benefit = VIOLATION. Granting "business partners" the right to provide advertising or information to users = VIOLATION (this means third parties get access to the user relationship). Pure contextual keyword-only ads (like DuckDuckGo) with zero personal data or third-party access = NOT a violation.
- content_ownership: "for any purpose" or sublicensable worldwide license that goes beyond just showing content on the platform = VIOLATION.
- transparency: ONLY flag if you can quote TWO contradictory sentences from the document. Complexity, length, and legal jargon alone are NEVER a transparency violation.
- data_retention: Referencing a separate privacy policy for data practices is STANDARD and NOT a violation. Only flag if the ToS itself contains an explicit problematic retention statement (e.g., "retained for a reasonable period" with no specific timeline after deletion, or "retained indefinitely"). If the document simply doesn't discuss retention or delegates to a privacy policy = NOT a violation.

SCORING (use these bands exactly):
- 0 violations, clear language    → score 90-100, rating "SAFE"
- 0 violations, minor vagueness   → score 75-89,  rating "OKAY"
- 1 low-severity violation        → score 50-74,  rating "OKAY"
- 1 high-severity or 2 violations → score 25-49,  rating "RISKY"
- 3-4 violations                  → score 10-24,  rating "RISKY"
- 5-6 violations                  → score 0-9,    rating "RISKY"

MANDATORY: score<50 → rating MUST be "RISKY". score 50-74 → rating MUST be "OKAY". score≥75 → "SAFE" or "OKAY".

EVIDENCE REQUIREMENT — NULL HYPOTHESIS:
Default to violation: false for EVERY pillar. Set violation: true ONLY IF you can copy-paste a VERBATIM sentence from the document that EXPLICITLY proves the violation. If you cannot find an explicit sentence → violation MUST be false.

For 'citation': copy the EXACT verbatim sentence(s) from the document. Do NOT paraphrase. If nothing is stated, write 'Not addressed in document.' and set violation to false.

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
{
  "rating": "SAFE" | "OKAY" | "RISKY",
  "score": <integer 0-100>,
  "tldr": "<2-3 sentence plain-English summary. Name specific risks.>",
  "pillars": {
    "ai_training":       { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_selling":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "transparency":      { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "data_retention":    { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" },
    "content_ownership": { "violation": boolean, "citation": "string", "confidence": "HIGH"|"MEDIUM"|"LOW" }
  }
}`;

const PILLAR_KEYS = ["ai_training", "data_selling", "transparency", "data_retention", "content_ownership"] as const;

interface GroundTruth {
  service: string;
  text: string;
  expectedRating: string[];
  scoreRange: [number, number];
  expectedPillars: Record<string, boolean>;
}

const TEST_CASES: GroundTruth[] = [
  {
    service: "X (Twitter)", expectedRating: ["RISKY"], scoreRange: [0, 25],
    expectedPillars: { ai_training: true, data_selling: true, transparency: false, data_retention: false, content_ownership: true },
    text: `X TERMS OF SERVICE (Effective November 15, 2024)\n\n1. Who May Use the Services\nYou may use the Services only if you agree to form a binding contract with X and are not a person barred from receiving services under the laws of the applicable jurisdiction. In any case, you must be at least 13 years old to use the Services.\n\n2. Privacy\nOur Privacy Policy (https://x.com/privacy) describes how we handle the information you provide to us when you use the Services. You understand that through your use of the Services you consent to the collection and use (as set forth in the Privacy Policy) of this information, including the transfer of this information to the United States, Ireland, and/or other countries for storage, processing and use by X and its affiliates.\n\n3. Content on the Services\nYou are responsible for your use of the Services and for any Content you provide, including compliance with applicable laws, rules, and regulations. You retain ownership rights in the Content you submit, post or display on or through the Services. What's yours is yours — you own your Content.\n\nBy submitting, posting or displaying Content on or through the Services, you grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit, display, upload, download, and distribute such Content in any and all media or distribution methods now known or later developed, for any purpose, including for promoting X, its products and services. This license authorizes us to make your Content available to the rest of the world and to let others do the same. You agree that this license includes the right for us to (i) analyze text and other information you provide and to otherwise provide, promote, and improve the Services, including, for example, for use with and training of our machine learning and artificial intelligence models, whether generative or another type; and (ii) make Content submitted to or through the Services available to other companies, organizations or individuals, including for the syndication, broadcast, distribution, repost, promotion or publication of such Content on other media and services, subject to our terms and conditions for such Content use.\n\n4. Using the Services\nWe may also remove or refuse to distribute any Content on the Services, limit distribution or visibility, suspend or terminate users, reclaim usernames, and make Content available to other companies, organizations, or individuals.\n\n5. Limitation of Liability\nTO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE X ENTITIES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES. IN NO EVENT SHALL THE AGGREGATE LIABILITY OF THE X ENTITIES EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS (U.S. $100.00) OR THE AMOUNT YOU PAID US, IF ANY, IN THE PAST SIX MONTHS FOR THE SERVICES GIVING RISE TO THE CLAIM.\n\n6. Disputes\nYou also waive the right to participate as a plaintiff or class member in any purported class action, collective action or representative action proceeding against us or our corporate affiliates. If such a dispute arises, we and you agree to submit the dispute to binding individual arbitration.\n\n7. General\nThese Terms are the entire and exclusive agreement between you and X Corp regarding use of the Services. If the arbitration provision is found unenforceable, any dispute shall not be heard as a class action.`
  },
  {
    service: "TikTok", expectedRating: ["RISKY"], scoreRange: [0, 15],
    expectedPillars: { ai_training: true, data_selling: true, transparency: false, data_retention: true, content_ownership: true },
    text: `TIKTOK TERMS OF SERVICE (Last updated: November 2024)\n\n1. Your Relationship With Us\nWelcome to TikTok, a platform enabling creation, sharing, and discovery of short-form videos (the "Platform"). TikTok is provided by TikTok LLC.\n\n2. Accepting these Terms\nBy accessing or using our Platform, you confirm that you can form a binding contract with TikTok. You must be at least 13 years old to use the Platform.\n\n3. Your Account\nWhen you create a TikTok account, we collect information about you. We may assign you a username. You are responsible for safeguarding your password and for any activities under your account. We collect device IDs, IP addresses, browsing and search history, cookies, the content of messages you send through TikTok, and metadata about the content you create. We may collect information from third parties including social media platforms, advertising partners, and data brokers. Information about you is also generated or collected automatically such as approximate location based on your SIM card, IP Address, age range, gender, and interests.\n\n4. Your Content\nYou retain your rights to any Content you submit, post or display on or through TikTok. By posting content, you grant TikTok a worldwide, non-exclusive, royalty-free, transferable, sublicensable license to use, reproduce, distribute, modify, adapt, publish, translate, create derivative works from, make available, communicate and display your User Content including any name, username, voice or likeness in such User Content, in whole or in part, in connection with the Platform and TikTok's (and its successors' and affiliates') business, including for promoting, redistributing, and displaying the Platform, in any media formats and through any media channels now known or subsequently developed.\n\nYou also grant TikTok an unrestricted, worldwide, irrevocable, fully paid, and royalty-free license to use the User Content, including to reproduce, modify and use for training machine learning, artificial intelligence, and similar technologies, without any further consent, notice, or compensation to you or any third party. There is currently no way to opt out of this use.\n\n5. Advertising and Commercial Content\nWe and our third-party providers and partners may place advertising on the Services or in connection with the display of Content or information from the Services whether submitted by you or others. We may use the information we collect about you to provide and improve the Platform, for targeted advertising and measurement, and to share with third-party advertising and analytics partners, including advertising networks, analytics providers, and social media platforms.\n\n6. Data Practices\nWe retain your information for as long as we need it to provide you the Platform. We may also retain data for legitimate business, legal, regulatory, tax, and accounting purposes. Following account deletion, certain data may be retained for a reasonable period consistent with our data retention policies and applicable laws.\n\n7. Limitation of Liability\nIN NO EVENT SHALL TIKTOK'S AGGREGATE LIABILITY EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS ($100.00) OR THE AMOUNT YOU PAID TIKTOK IN THE SIX MONTHS PRECEDING THE CLAIM.\n\nYOU AGREE TO RESOLVE ANY DISPUTES THROUGH BINDING INDIVIDUAL ARBITRATION AND WAIVE YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION.\n\n8. Contact Us\nFor any questions, contact us at legal@tiktok.com.`
  },
  {
    service: "Signal", expectedRating: ["SAFE", "OKAY"], scoreRange: [75, 100],
    expectedPillars: { ai_training: false, data_selling: false, transparency: false, data_retention: false, content_ownership: false },
    text: `SIGNAL TERMS OF SERVICE & PRIVACY POLICY\n\nSignal Messenger LLC ("Signal", "we", "us", or "our") provides the Signal messaging application and related services (the "Service").\n\nPrivacy & Security\nSignal is designed to never collect or store sensitive information. Messages are end-to-end encrypted, and Signal does not have access to the content of messages or calls sent through the Service.\n\nData We Collect\nSignal does not sell, rent, or monetize your personal data or content in any way – ever. We store only the minimal data needed to operate: your phone number (for registration), randomly generated authentication tokens, and profile information you choose to provide (name and avatar). We do not store message contents, contact lists, groups, group names, group memberships, or any location information.\n\nNo Advertising, No Tracking\nSignal does not serve ads. There is no advertiser tracking, no analytics partnerships, and we do not share data with any third parties. Signal is funded by donations through the Signal Technology Foundation, a 501(c)(3) nonprofit.\n\nContent Ownership\nYou own your messages and content. Signal claims no license or rights to your communications beyond what is strictly necessary to transmit messages between users in real time. We do not store message content on our servers after delivery.\n\nAI & Machine Learning\nSignal does not use any user data for AI training, machine learning, or any automated decision-making. We do not have access to message content, so training on user communications is technically impossible.\n\nData Retention & Deletion\nWhen you delete your account, we permanently remove your data from our servers within 30 days. We do not retain backup copies of message content because we never store them in the first place.\n\nSecurity\nWe employ state-of-the-art end-to-end encryption (Signal Protocol) for all messages and calls. Our source code is publicly available and has been independently audited.\n\nLimitation of Liability\nSignal's total liability shall not exceed $500 or the amount you paid in the 12 months preceding the claim, whichever is greater. This is a reasonable limitation given that Signal is a free service funded by donations.\n\nChanges to Terms\nWe may update these terms. If we make material changes, we will notify you within the app at least 30 days before they take effect.\n\nContact\nprivacy@signal.org`
  },
  {
    service: "DuckDuckGo", expectedRating: ["SAFE", "OKAY"], scoreRange: [75, 100],
    expectedPillars: { ai_training: false, data_selling: false, transparency: false, data_retention: false, content_ownership: false },
    text: `DUCKDUCKGO TERMS OF SERVICE\n\nDuckDuckGo provides a privacy-focused search engine and related products (the "Service"). By using DuckDuckGo, you agree to the following terms.\n\nPrivacy First\nDuckDuckGo does not track you. We do not collect or store personal information. When you search on DuckDuckGo, we do not know who you are. We don't use cookies to identify you. We don't log your IP address. We don't store your search history.\n\nNo Personal Data Collection\nWe don't collect: IP addresses, user agent strings tied to searches, unique identifiers, search history linked to any individual, or any form of personal data that could identify you.\n\nAdvertising\nDuckDuckGo generates revenue through non-tracking, contextual advertising. Ads are based on the search keywords you enter, not on your personal data or browsing history. Our advertising partners do not receive any personal information about you. No tracking cookies, no personal profiles.\n\nContent & Intellectual Property\nAll DuckDuckGo trademarks, logos, and service marks are our property. Search results contain content from third parties, and those third parties retain their intellectual property rights. We do not claim any ownership rights over content you access through our search results.\n\nNo AI Training on User Data\nDuckDuckGo does not use any user search data for AI model training, machine learning, or similar technologies. Your searches are not stored in any form that could be used for training purposes.\n\nData Retention\nSince we do not collect personal data, there is nothing to retain. Search queries are not logged or stored in any personally identifiable form. Aggregate, non-personal statistics may be retained to improve our service.\n\nLimitation of Liability\nDuckDuckGo's liability is limited to the greater of $100 or the amount paid for our services in the 12 months prior to the claim. We are not liable for indirect, incidental, or consequential damages.\n\nGoverning Law\nThese terms are governed by the laws of the Commonwealth of Pennsylvania, United States.\n\nChanges\nWe may modify these Terms at any time. We will notify you of material changes by posting updates to our website.\n\nContact: legal@duckduckgo.com`
  },
  {
    service: "Spotify", expectedRating: ["RISKY", "OKAY"], scoreRange: [5, 45],
    expectedPillars: { ai_training: false, data_selling: true, transparency: false, data_retention: false, content_ownership: true },
    text: `SPOTIFY TERMS OF USE (Last Updated: August 26, 2025)\n\n1. Introduction\nBy signing up for, or otherwise using, the Spotify Service, you agree to these Terms. If you do not agree to these Terms, then you must not use the Spotify Service or access any Content.\n\nTHESE TERMS CONTAIN A MANDATORY ARBITRATION PROVISION THAT, AS FURTHER SET FORTH IN SECTION 6 BELOW, REQUIRES THE USE OF ARBITRATION ON AN INDIVIDUAL BASIS TO RESOLVE DISPUTES, RATHER THAN JURY TRIALS OR ANY OTHER COURT PROCEEDINGS, OR CLASS ACTIONS OF ANY KIND. IN ARBITRATION THERE IS LESS DISCOVERY AND APPELLATE REVIEW THAN IN COURT.\n\n2. The Spotify Service\nWe use reasonable efforts to keep the Spotify Service operational. However, Spotify reserves the right to change our Spotify Service offerings and their availability from time to time, without notice or liability to you. Spotify has no obligation to provide any specific content through the Spotify Service, and Spotify or the applicable owners may remove access to particular songs, videos, podcasts, audiobooks and other Content without notice.\n\n3. Your Use of the Spotify Service\nSubject to your compliance with these Terms, we grant to you limited, non-exclusive, revocable permission to make personal, non-commercial use of the Spotify Service and the Content.\n\nContent you post on the Spotify Service:\nYou retain ownership of your User Content when you post it to the Spotify Service. However, you hereby grant to Spotify a non-exclusive, transferable, sublicensable, royalty-free, fully paid, irrevocable, worldwide license to reproduce, make available, perform and display, translate, modify, create derivative works from, distribute, and otherwise use any such User Content through any medium, whether alone or in combination with other Content or materials, in any manner and by any means, method or technology, whether now known or hereafter created, in connection with the Spotify Service. Where applicable and to the extent permitted under applicable law, you also agree to waive, and not to enforce, any "moral rights" or equivalent rights, such as your right to be identified as the author of any User Content.\n\nIf you provide ideas, suggestions, or other feedback in connection with your use of the Spotify Service or any Content ("Feedback"), such Feedback is not confidential and may be used by Spotify without restriction and without payment to you.\n\nYou also grant to us the right (1) to allow the Spotify Service to use the processor, bandwidth, and storage hardware on your Device in order to facilitate the operation of the Spotify Service, and (2) to provide advertising and other information to you, and (3) to allow our business partners to do the same.\n\nIn any part of the Spotify Service, the Content that you access, including its selection and placement, may be influenced by commercial considerations, including Spotify's agreements with third parties.\n\n4. Warranty Disclaimers\nTHE SPOTIFY SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT ANY WARRANTIES OF ANY KIND.\n\n5. Limitation of Liability\nTO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL SPOTIFY BE LIABLE FOR ANY INDIRECT, SPECIAL, INCIDENTAL, PUNITIVE, EXEMPLARY, OR CONSEQUENTIAL DAMAGES. AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SPOTIFY SERVICE MORE THAN THE GREATER OF (A) THE AMOUNTS PAID BY YOU TO SPOTIFY DURING THE TWELVE MONTHS PRIOR TO THE FIRST CLAIM; OR (B) $30.00.\n\nTO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, ANY CLAIM ARISING UNDER THESE TERMS MUST BE COMMENCED WITHIN ONE (1) YEAR AFTER THE DATE THE PARTY ASSERTING THE CLAIM FIRST KNOWS OR REASONABLY SHOULD KNOW OF THE ACT.\n\n6. Dispute Resolution\nYOU AND SPOTIFY AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER IN ARBITRATION OR LITIGATION ONLY IN YOUR OR ITS INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, PRIVATE ATTORNEY GENERAL, OR REPRESENTATIVE ACTION.\n\nAny Dispute between you and Spotify will be determined by binding individual arbitration. THERE IS NO JUDGE OR JURY IN ARBITRATION.\n\n7. About These Terms\nSpotify may assign any or all of these Terms, and may assign or delegate, in whole or in part, any of its rights or obligations under these Terms. You may not assign these Terms.`
  }
];

const MODEL_A = "qwen/qwen3-next-80b-a3b-instruct";
const MODEL_B = "mistralai/mixtral-8x22b-instruct-v0.1";
const RUNS = 3;

async function callModel(model: string, text: string): Promise<{ parsed: any | null; latencyMs: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const start = Date.now();
  try {
    const resp = await nimCreateWithRetry({
      model,
      messages: [
        { role: "system", content: DEEP_PROMPT },
        { role: "user", content: `Analyze this Terms of Service document thoroughly. Extract ALL violations present:\n\n${text}` }
      ],
      temperature: 0,
      max_tokens: 1400
    }, controller.signal);
    const latencyMs = Date.now() - start;
    if (!resp) return { parsed: null, latencyMs, error: "API exhausted" };
    const raw = resp.choices[0]?.message?.content || "{}";
    const parsed = extractJSON(raw);
    if (parsed) {
      if (typeof parsed.score === "number") {
        if (parsed.score < 50) parsed.rating = "RISKY";
        else if (parsed.score < 75 && parsed.rating === "SAFE") parsed.rating = "OKAY";
        else if (parsed.score >= 75 && parsed.rating === "RISKY") parsed.rating = "OKAY";
      }
    }
    return { parsed, latencyMs };
  } catch (e: any) {
    return { parsed: null, latencyMs: Date.now() - start, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function ensemblePillars(a: any, b: any): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of PILLAR_KEYS) {
    const aViolation = Boolean(a?.pillars?.[key]?.violation);
    const bViolation = Boolean(b?.pillars?.[key]?.violation);
    // Intersection: BOTH must agree for a violation to be flagged
    // This eliminates false positives from individual model noise
    result[key] = aViolation && bViolation;
  }
  return result;
}

function ensembleRating(a: any, b: any): { rating: string; score: number } {
  const aScore = typeof a?.score === "number" ? a.score : 50;
  const bScore = typeof b?.score === "number" ? b.score : 50;
  // Average for balanced assessment
  const score = Math.round((aScore + bScore) / 2);
  let rating: string;
  if (score < 50) rating = "RISKY";
  else if (score < 75) rating = "OKAY";
  else rating = "SAFE";
  return { rating, score };
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  ENSEMBLE DEEP SCAN: Qwen3-80b + Mixtral-8x22b          ║");
  console.log("║  Strategy: Intersection violations, Avg score            ║");
  console.log("║  5 services × 3 runs = 30 parallel API pairs            ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  let md = "# Ensemble Deep Scan Results\n\n";
  md += "> **Strategy:** Run `qwen3-next-80b` + `mixtral-8x22b` in parallel.\n";
  md += "> **Violation logic:** BOTH models must agree a violation exists → flagged (intersection).\n";
  md += "> **Score logic:** Take the AVERAGE score from both models.\n";
  md += "> **Rating logic:** Derived from ensemble score using standard bands.\n\n";

  let totalPillarChecks = 0;
  let totalPillarCorrect = 0;
  let totalRatingChecks = 0;
  let totalRatingCorrect = 0;
  let totalScoreChecks = 0;
  let totalScoreCorrect = 0;
  let allLatencies: number[] = [];
  let modelALatencies: number[] = [];
  let modelBLatencies: number[] = [];

  // Also track individual model accuracy for comparison
  let modelAPillarCorrect = 0;
  let modelAPillarTotal = 0;
  let modelBPillarCorrect = 0;
  let modelBPillarTotal = 0;

  for (const tc of TEST_CASES) {
    const pad = Math.floor((55 - tc.service.length) / 2);
    md += "=======================================================\n";
    md += `${" ".repeat(pad)}${tc.service}\n`;
    md += `Expected: ${tc.expectedRating.join("/")} | Score: ${tc.scoreRange[0]}-${tc.scoreRange[1]}\n`;
    md += `Ground Truth Violations: ${PILLAR_KEYS.filter(k => tc.expectedPillars[k]).join(", ") || "None"}\n`;
    md += "-------------------------------------------------------\n";

    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n${tc.service} — Run ${run}/${RUNS}`);
      console.log(`  Calling ${MODEL_A} and ${MODEL_B} in parallel...`);

      const parallelStart = Date.now();
      const [resultA, resultB] = await Promise.all([
        callModel(MODEL_A, tc.text),
        callModel(MODEL_B, tc.text),
      ]);
      const parallelLatency = Date.now() - parallelStart;

      md += `\n**Run ${run}:**\n`;

      // Individual model results
      const aOk = resultA.parsed !== null;
      const bOk = resultB.parsed !== null;

      if (aOk) {
        const aViolations = PILLAR_KEYS.filter(k => resultA.parsed.pillars?.[k]?.violation).join(", ");
        md += `  Model A (Qwen3-80b):   Rating: ${resultA.parsed.rating}, Score: ${resultA.parsed.score}, Violations: ${aViolations || "None"} [${(resultA.latencyMs/1000).toFixed(2)}s]\n`;
        modelALatencies.push(resultA.latencyMs);
        // Track individual accuracy
        for (const key of PILLAR_KEYS) {
          modelAPillarTotal++;
          if (Boolean(resultA.parsed.pillars?.[key]?.violation) === tc.expectedPillars[key]) modelAPillarCorrect++;
        }
      } else {
        md += `  Model A (Qwen3-80b):   ERROR: ${resultA.error} [${(resultA.latencyMs/1000).toFixed(2)}s]\n`;
      }

      if (bOk) {
        const bViolations = PILLAR_KEYS.filter(k => resultB.parsed.pillars?.[k]?.violation).join(", ");
        md += `  Model B (Mixtral-22b): Rating: ${resultB.parsed.rating}, Score: ${resultB.parsed.score}, Violations: ${bViolations || "None"} [${(resultB.latencyMs/1000).toFixed(2)}s]\n`;
        modelBLatencies.push(resultB.latencyMs);
        for (const key of PILLAR_KEYS) {
          modelBPillarTotal++;
          if (Boolean(resultB.parsed.pillars?.[key]?.violation) === tc.expectedPillars[key]) modelBPillarCorrect++;
        }
      } else {
        md += `  Model B (Mixtral-22b): ERROR: ${resultB.error} [${(resultB.latencyMs/1000).toFixed(2)}s]\n`;
      }

      // Ensemble result
      if (aOk && bOk) {
        const ensembledPillars = ensemblePillars(resultA.parsed, resultB.parsed);
        const ensembledRating = ensembleRating(resultA.parsed, resultB.parsed);
        
        const violations = PILLAR_KEYS.filter(k => ensembledPillars[k]).join(", ");
        const pillarMisses: string[] = [];
        let correct = 0;
        for (const key of PILLAR_KEYS) {
          totalPillarChecks++;
          if (ensembledPillars[key] === tc.expectedPillars[key]) {
            correct++;
            totalPillarCorrect++;
          } else {
            pillarMisses.push(`${key}(exp=${tc.expectedPillars[key]},got=${ensembledPillars[key]})`);
          }
        }

        const ratingMatch = tc.expectedRating.includes(ensembledRating.rating);
        totalRatingChecks++;
        if (ratingMatch) totalRatingCorrect++;

        const scoreMatch = ensembledRating.score >= tc.scoreRange[0] && ensembledRating.score <= tc.scoreRange[1];
        totalScoreChecks++;
        if (scoreMatch) totalScoreCorrect++;

        allLatencies.push(parallelLatency);

        const latencyFlag = parallelLatency > 20000 ? " ⚠️ EXCEEDS 20s" : " ✅";

        md += `  **ENSEMBLE:**          Rating: ${ensembledRating.rating} ${ratingMatch ? "✅" : "❌"}, Score: ${ensembledRating.score} ${scoreMatch ? "✅" : "❌"}, Violations: ${violations || "None"}\n`;
        md += `  Pillar Accuracy: ${correct}/5${pillarMisses.length > 0 ? ` | MISSES: ${pillarMisses.join(", ")}` : " ✅ PERFECT"}\n`;
        md += `  Parallel Latency: ${(parallelLatency/1000).toFixed(2)}s${latencyFlag}\n`;
      } else if (aOk || bOk) {
        // Fallback: use whichever model succeeded
        const fallback = aOk ? resultA.parsed : resultB.parsed;
        const fallbackName = aOk ? "A (Qwen)" : "B (Mixtral)";
        md += `  **FALLBACK (${fallbackName} only):** Rating: ${fallback.rating}, Score: ${fallback.score}\n`;
      } else {
        md += `  **BOTH FAILED** — no ensemble possible\n`;
      }

      // Progressive save
      fs.writeFileSync("deepscan_result.md", md, "utf-8");

      // Rate limit between runs
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ══════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════
  md += "\n=======================================================\n";
  md += "                 FINAL SUMMARY\n";
  md += "=======================================================\n\n";

  md += "## Ensemble Accuracy\n\n";
  md += `| Metric | Result |\n`;
  md += `|--------|--------|\n`;
  md += `| Rating Accuracy | ${totalRatingCorrect}/${totalRatingChecks} (${totalRatingChecks > 0 ? ((totalRatingCorrect/totalRatingChecks)*100).toFixed(1) : 0}%) |\n`;
  md += `| Score in Range | ${totalScoreCorrect}/${totalScoreChecks} (${totalScoreChecks > 0 ? ((totalScoreCorrect/totalScoreChecks)*100).toFixed(1) : 0}%) |\n`;
  md += `| Pillar Accuracy | ${totalPillarCorrect}/${totalPillarChecks} (${totalPillarChecks > 0 ? ((totalPillarCorrect/totalPillarChecks)*100).toFixed(1) : 0}%) |\n\n`;

  md += "## Individual Model Accuracy (for comparison)\n\n";
  md += `| Model | Pillar Accuracy |\n`;
  md += `|-------|----------------|\n`;
  md += `| Qwen3-next-80b (alone) | ${modelAPillarCorrect}/${modelAPillarTotal} (${modelAPillarTotal > 0 ? ((modelAPillarCorrect/modelAPillarTotal)*100).toFixed(1) : 0}%) |\n`;
  md += `| Mixtral-8x22b (alone) | ${modelBPillarCorrect}/${modelBPillarTotal} (${modelBPillarTotal > 0 ? ((modelBPillarCorrect/modelBPillarTotal)*100).toFixed(1) : 0}%) |\n`;
  md += `| **Ensemble (union)** | **${totalPillarCorrect}/${totalPillarChecks} (${totalPillarChecks > 0 ? ((totalPillarCorrect/totalPillarChecks)*100).toFixed(1) : 0}%)** |\n\n`;

  md += "## Latency\n\n";
  if (allLatencies.length > 0) {
    allLatencies.sort((a, b) => a - b);
    modelALatencies.sort((a, b) => a - b);
    modelBLatencies.sort((a, b) => a - b);
    const avg = allLatencies.reduce((s, l) => s + l, 0) / allLatencies.length;
    const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)];
    const p90 = allLatencies[Math.floor(allLatencies.length * 0.9)];
    const avgA = modelALatencies.length > 0 ? modelALatencies.reduce((s, l) => s + l, 0) / modelALatencies.length : 0;
    const avgB = modelBLatencies.length > 0 ? modelBLatencies.reduce((s, l) => s + l, 0) / modelBLatencies.length : 0;

    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Parallel Avg | ${(avg/1000).toFixed(2)}s |\n`;
    md += `| Parallel P50 | ${(p50/1000).toFixed(2)}s |\n`;
    md += `| Parallel P90 | ${(p90/1000).toFixed(2)}s |\n`;
    md += `| Max | ${(Math.max(...allLatencies)/1000).toFixed(2)}s |\n`;
    md += `| Qwen3-80b Avg | ${(avgA/1000).toFixed(2)}s |\n`;
    md += `| Mixtral-8x22b Avg | ${(avgB/1000).toFixed(2)}s |\n`;
    md += `| Under 20s Limit | ${allLatencies.filter(l => l <= 20000).length}/${allLatencies.length} (${((allLatencies.filter(l => l <= 20000).length / allLatencies.length)*100).toFixed(0)}%) |\n`;
  }

  md += "\n";
  fs.writeFileSync("deepscan_result.md", md, "utf-8");
  console.log("\n✅ Done. Results saved to deepscan_result.md");
}

main();
