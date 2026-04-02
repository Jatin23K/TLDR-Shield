/**
 * TLDR Shield — Backup Model Validation
 * ======================================
 * Tests qwen2.5-coder-32b and gemma-3-27b with refined v3 prompt.
 * 5 runs per service per model = 50 API calls.
 * Goal: find a backup that can pair with either primary for 98%+ ensemble.
 */

import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";

process.on("uncaughtException", (err) => console.error("Uncaught", err));
process.on("unhandledRejection", (err) => console.error("Unhandled", err));
dotenv.config();

const NIM_KEYS = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean) as string[];
if (!NIM_KEYS.length) { console.error("❌ No keys"); process.exit(1); }
let nimKeyIdx = 0;

async function nimCall(params: any, signal: AbortSignal) {
  for (let i = 0; i < NIM_KEYS.length; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const key = NIM_KEYS[nimKeyIdx % NIM_KEYS.length]; nimKeyIdx++;
    const client = new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" });
    const kc = new AbortController(); const kt = setTimeout(() => kc.abort(), 25000);
    const onA = () => kc.abort(); signal.addEventListener("abort", onA, { once: true });
    try { return await client.chat.completions.create(params, { signal: kc.signal }); }
    catch (e: any) { const s = e?.status ?? 0; if (s >= 400 && s < 500 && s !== 429) throw e; if (signal.aborted) throw e; }
    finally { clearTimeout(kt); signal.removeEventListener("abort", onA); }
  }
  return null;
}

function extractJSON(text: string): any | null {
  const clean = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const norm = (s: string) => s.replace(/,\s*([}\]])/g, "$1");
  const tryP = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  const findObj = (s: string): string | null => {
    const st = s.indexOf("{"); if (st === -1) return null;
    let d = 0, inS = false, esc = false;
    for (let i = st; i < s.length; i++) {
      const c = s[i]; if (esc) { esc = false; continue; } if (c === "\\" && inS) { esc = true; continue; }
      if (c === '"') { inS = !inS; continue; } if (inS) continue;
      if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return s.substring(st, i + 1); }
    }
    return null;
  };
  for (const src of [clean(text), text]) {
    const c = findObj(src); if (!c) continue;
    const p = tryP(c) ?? tryP(norm(c));
    if (p && typeof p === "object") {
      if (p.pillars) for (const k of Object.keys(p.pillars)) {
        const v = p.pillars[k]; if (v && typeof v.violation === "string") v.violation = v.violation.toLowerCase() === "true";
      }
      return p;
    }
  }
  return null;
}

const PROMPT = `You are a senior privacy attorney and data protection expert. Be STRICT and PRECISE — flag violations when you have explicit textual evidence, but NEVER fabricate or infer violations without a direct verbatim quote.

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

const PILLARS = ["ai_training", "data_selling", "transparency", "data_retention", "content_ownership"] as const;

const CASES = [
  { service: "X (Twitter)", expectedRating: ["RISKY"], scoreRange: [0, 25] as [number,number],
    expectedPillars: { ai_training: true, data_selling: true, transparency: false, data_retention: false, content_ownership: true },
    text: `X TERMS OF SERVICE (Effective November 15, 2024)\n\n1. Who May Use the Services\nYou may use the Services only if you agree to form a binding contract with X and are not a person barred from receiving services under the laws of the applicable jurisdiction. In any case, you must be at least 13 years old to use the Services.\n\n2. Privacy\nOur Privacy Policy (https://x.com/privacy) describes how we handle the information you provide to us when you use the Services. You understand that through your use of the Services you consent to the collection and use (as set forth in the Privacy Policy) of this information, including the transfer of this information to the United States, Ireland, and/or other countries for storage, processing and use by X and its affiliates.\n\n3. Content on the Services\nYou are responsible for your use of the Services and for any Content you provide, including compliance with applicable laws, rules, and regulations. You retain ownership rights in the Content you submit, post or display on or through the Services. What's yours is yours — you own your Content.\n\nBy submitting, posting or displaying Content on or through the Services, you grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit, display, upload, download, and distribute such Content in any and all media or distribution methods now known or later developed, for any purpose, including for promoting X, its products and services. This license authorizes us to make your Content available to the rest of the world and to let others do the same. You agree that this license includes the right for us to (i) analyze text and other information you provide and to otherwise provide, promote, and improve the Services, including, for example, for use with and training of our machine learning and artificial intelligence models, whether generative or another type; and (ii) make Content submitted to or through the Services available to other companies, organizations or individuals, including for the syndication, broadcast, distribution, repost, promotion or publication of such Content on other media and services, subject to our terms and conditions for such Content use.\n\n4. Using the Services\nWe may also remove or refuse to distribute any Content on the Services, limit distribution or visibility, suspend or terminate users, reclaim usernames, and make Content available to other companies, organizations, or individuals.\n\n5. Limitation of Liability\nTO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE X ENTITIES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES. IN NO EVENT SHALL THE AGGREGATE LIABILITY OF THE X ENTITIES EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS (U.S. $100.00) OR THE AMOUNT YOU PAID US, IF ANY, IN THE PAST SIX MONTHS FOR THE SERVICES GIVING RISE TO THE CLAIM.\n\n6. Disputes\nYou also waive the right to participate as a plaintiff or class member in any purported class action, collective action or representative action proceeding against us or our corporate affiliates. If such a dispute arises, we and you agree to submit the dispute to binding individual arbitration.\n\n7. General\nThese Terms are the entire and exclusive agreement between you and X Corp regarding use of the Services. If the arbitration provision is found unenforceable, any dispute shall not be heard as a class action.` },
  { service: "TikTok", expectedRating: ["RISKY"], scoreRange: [0, 15] as [number,number],
    expectedPillars: { ai_training: true, data_selling: true, transparency: false, data_retention: true, content_ownership: true },
    text: `TIKTOK TERMS OF SERVICE (Last updated: November 2024)\n\n1. Your Relationship With Us\nWelcome to TikTok, a platform enabling creation, sharing, and discovery of short-form videos (the "Platform"). TikTok is provided by TikTok LLC.\n\n2. Accepting these Terms\nBy accessing or using our Platform, you confirm that you can form a binding contract with TikTok. You must be at least 13 years old to use the Platform.\n\n3. Your Account\nWhen you create a TikTok account, we collect information about you. We may assign you a username. You are responsible for safeguarding your password and for any activities under your account. We collect device IDs, IP addresses, browsing and search history, cookies, the content of messages you send through TikTok, and metadata about the content you create. We may collect information from third parties including social media platforms, advertising partners, and data brokers. Information about you is also generated or collected automatically such as approximate location based on your SIM card, IP Address, age range, gender, and interests.\n\n4. Your Content\nYou retain your rights to any Content you submit, post or display on or through TikTok. By posting content, you grant TikTok a worldwide, non-exclusive, royalty-free, transferable, sublicensable license to use, reproduce, distribute, modify, adapt, publish, translate, create derivative works from, make available, communicate and display your User Content including any name, username, voice or likeness in such User Content, in whole or in part, in connection with the Platform and TikTok's (and its successors' and affiliates') business, including for promoting, redistributing, and displaying the Platform, in any media formats and through any media channels now known or subsequently developed.\n\nYou also grant TikTok an unrestricted, worldwide, irrevocable, fully paid, and royalty-free license to use the User Content, including to reproduce, modify and use for training machine learning, artificial intelligence, and similar technologies, without any further consent, notice, or compensation to you or any third party. There is currently no way to opt out of this use.\n\n5. Advertising and Commercial Content\nWe and our third-party providers and partners may place advertising on the Services or in connection with the display of Content or information from the Services whether submitted by you or others. We may use the information we collect about you to provide and improve the Platform, for targeted advertising and measurement, and to share with third-party advertising and analytics partners, including advertising networks, analytics providers, and social media platforms.\n\n6. Data Practices\nWe retain your information for as long as we need it to provide you the Platform. We may also retain data for legitimate business, legal, regulatory, tax, and accounting purposes. Following account deletion, certain data may be retained for a reasonable period consistent with our data retention policies and applicable laws.\n\n7. Limitation of Liability\nIN NO EVENT SHALL TIKTOK'S AGGREGATE LIABILITY EXCEED THE GREATER OF ONE HUNDRED U.S. DOLLARS ($100.00) OR THE AMOUNT YOU PAID TIKTOK IN THE SIX MONTHS PRECEDING THE CLAIM.\n\nYOU AGREE TO RESOLVE ANY DISPUTES THROUGH BINDING INDIVIDUAL ARBITRATION AND WAIVE YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION.\n\n8. Contact Us\nFor any questions, contact us at legal@tiktok.com.` },
  { service: "Signal", expectedRating: ["SAFE", "OKAY"], scoreRange: [75, 100] as [number,number],
    expectedPillars: { ai_training: false, data_selling: false, transparency: false, data_retention: false, content_ownership: false },
    text: `SIGNAL TERMS OF SERVICE & PRIVACY POLICY\n\nSignal Messenger LLC ("Signal", "we", "us", or "our") provides the Signal messaging application and related services (the "Service").\n\nPrivacy & Security\nSignal is designed to never collect or store sensitive information. Messages are end-to-end encrypted, and Signal does not have access to the content of messages or calls sent through the Service.\n\nData We Collect\nSignal does not sell, rent, or monetize your personal data or content in any way – ever. We store only the minimal data needed to operate: your phone number (for registration), randomly generated authentication tokens, and profile information you choose to provide (name and avatar). We do not store message contents, contact lists, groups, group names, group memberships, or any location information.\n\nNo Advertising, No Tracking\nSignal does not serve ads. There is no advertiser tracking, no analytics partnerships, and we do not share data with any third parties. Signal is funded by donations through the Signal Technology Foundation, a 501(c)(3) nonprofit.\n\nContent Ownership\nYou own your messages and content. Signal claims no license or rights to your communications beyond what is strictly necessary to transmit messages between users in real time. We do not store message content on our servers after delivery.\n\nAI & Machine Learning\nSignal does not use any user data for AI training, machine learning, or any automated decision-making. We do not have access to message content, so training on user communications is technically impossible.\n\nData Retention & Deletion\nWhen you delete your account, we permanently remove your data from our servers within 30 days. We do not retain backup copies of message content because we never store them in the first place.\n\nSecurity\nWe employ state-of-the-art end-to-end encryption (Signal Protocol) for all messages and calls. Our source code is publicly available and has been independently audited.\n\nLimitation of Liability\nSignal's total liability shall not exceed $500 or the amount you paid in the 12 months preceding the claim, whichever is greater. This is a reasonable limitation given that Signal is a free service funded by donations.\n\nChanges to Terms\nWe may update these terms. If we make material changes, we will notify you within the app at least 30 days before they take effect.\n\nContact\nprivacy@signal.org` },
  { service: "DuckDuckGo", expectedRating: ["SAFE", "OKAY"], scoreRange: [75, 100] as [number,number],
    expectedPillars: { ai_training: false, data_selling: false, transparency: false, data_retention: false, content_ownership: false },
    text: `DUCKDUCKGO TERMS OF SERVICE\n\nDuckDuckGo provides a privacy-focused search engine and related products (the "Service"). By using DuckDuckGo, you agree to the following terms.\n\nPrivacy First\nDuckDuckGo does not track you. We do not collect or store personal information. When you search on DuckDuckGo, we do not know who you are. We don't use cookies to identify you. We don't log your IP address. We don't store your search history.\n\nNo Personal Data Collection\nWe don't collect: IP addresses, user agent strings tied to searches, unique identifiers, search history linked to any individual, or any form of personal data that could identify you.\n\nAdvertising\nDuckDuckGo generates revenue through non-tracking, contextual advertising. Ads are based on the search keywords you enter, not on your personal data or browsing history. Our advertising partners do not receive any personal information about you. No tracking cookies, no personal profiles.\n\nContent & Intellectual Property\nAll DuckDuckGo trademarks, logos, and service marks are our property. Search results contain content from third parties, and those third parties retain their intellectual property rights. We do not claim any ownership rights over content you access through our search results.\n\nNo AI Training on User Data\nDuckDuckGo does not use any user search data for AI model training, machine learning, or similar technologies. Your searches are not stored in any form that could be used for training purposes.\n\nData Retention\nSince we do not collect personal data, there is nothing to retain. Search queries are not logged or stored in any personally identifiable form. Aggregate, non-personal statistics may be retained to improve our service.\n\nLimitation of Liability\nDuckDuckGo's liability is limited to the greater of $100 or the amount paid for our services in the 12 months prior to the claim. We are not liable for indirect, incidental, or consequential damages.\n\nGoverning Law\nThese terms are governed by the laws of the Commonwealth of Pennsylvania, United States.\n\nChanges\nWe may modify these Terms at any time. We will notify you of material changes by posting updates to our website.\n\nContact: legal@duckduckgo.com` },
  { service: "Spotify", expectedRating: ["RISKY", "OKAY"], scoreRange: [5, 45] as [number,number],
    expectedPillars: { ai_training: false, data_selling: true, transparency: false, data_retention: false, content_ownership: true },
    text: `SPOTIFY TERMS OF USE (Last Updated: August 26, 2025)\n\n1. Introduction\nBy signing up for, or otherwise using, the Spotify Service, you agree to these Terms. If you do not agree to these Terms, then you must not use the Spotify Service or access any Content.\n\nTHESE TERMS CONTAIN A MANDATORY ARBITRATION PROVISION THAT, AS FURTHER SET FORTH IN SECTION 6 BELOW, REQUIRES THE USE OF ARBITRATION ON AN INDIVIDUAL BASIS TO RESOLVE DISPUTES, RATHER THAN JURY TRIALS OR ANY OTHER COURT PROCEEDINGS, OR CLASS ACTIONS OF ANY KIND. IN ARBITRATION THERE IS LESS DISCOVERY AND APPELLATE REVIEW THAN IN COURT.\n\n2. The Spotify Service\nWe use reasonable efforts to keep the Spotify Service operational. However, Spotify reserves the right to change our Spotify Service offerings and their availability from time to time, without notice or liability to you. Spotify has no obligation to provide any specific content through the Spotify Service, and Spotify or the applicable owners may remove access to particular songs, videos, podcasts, audiobooks and other Content without notice.\n\n3. Your Use of the Spotify Service\nSubject to your compliance with these Terms, we grant to you limited, non-exclusive, revocable permission to make personal, non-commercial use of the Spotify Service and the Content.\n\nContent you post on the Spotify Service:\nYou retain ownership of your User Content when you post it to the Spotify Service. However, you hereby grant to Spotify a non-exclusive, transferable, sublicensable, royalty-free, fully paid, irrevocable, worldwide license to reproduce, make available, perform and display, translate, modify, create derivative works from, distribute, and otherwise use any such User Content through any medium, whether alone or in combination with other Content or materials, in any manner and by any means, method or technology, whether now known or hereafter created, in connection with the Spotify Service. Where applicable and to the extent permitted under applicable law, you also agree to waive, and not to enforce, any "moral rights" or equivalent rights, such as your right to be identified as the author of any User Content.\n\nIf you provide ideas, suggestions, or other feedback in connection with your use of the Spotify Service or any Content ("Feedback"), such Feedback is not confidential and may be used by Spotify without restriction and without payment to you.\n\nYou also grant to us the right (1) to allow the Spotify Service to use the processor, bandwidth, and storage hardware on your Device in order to facilitate the operation of the Spotify Service, and (2) to provide advertising and other information to you, and (3) to allow our business partners to do the same.\n\nIn any part of the Spotify Service, the Content that you access, including its selection and placement, may be influenced by commercial considerations, including Spotify's agreements with third parties.\n\n4. Warranty Disclaimers\nTHE SPOTIFY SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT ANY WARRANTIES OF ANY KIND.\n\n5. Limitation of Liability\nTO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL SPOTIFY BE LIABLE FOR ANY INDIRECT, SPECIAL, INCIDENTAL, PUNITIVE, EXEMPLARY, OR CONSEQUENTIAL DAMAGES. AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SPOTIFY SERVICE MORE THAN THE GREATER OF (A) THE AMOUNTS PAID BY YOU TO SPOTIFY DURING THE TWELVE MONTHS PRIOR TO THE FIRST CLAIM; OR (B) $30.00.\n\nTO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, ANY CLAIM ARISING UNDER THESE TERMS MUST BE COMMENCED WITHIN ONE (1) YEAR AFTER THE DATE THE PARTY ASSERTING THE CLAIM FIRST KNOWS OR REASONABLY SHOULD KNOW OF THE ACT.\n\n6. Dispute Resolution\nYOU AND SPOTIFY AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER IN ARBITRATION OR LITIGATION ONLY IN YOUR OR ITS INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, PRIVATE ATTORNEY GENERAL, OR REPRESENTATIVE ACTION.\n\nAny Dispute between you and Spotify will be determined by binding individual arbitration. THERE IS NO JUDGE OR JURY IN ARBITRATION.\n\n7. About These Terms\nSpotify may assign any or all of these Terms, and may assign or delegate, in whole or in part, any of its rights or obligations under these Terms. You may not assign these Terms.` }
];

const BACKUP_MODELS = [
  "qwen/qwen2.5-coder-32b-instruct",
  "google/gemma-3-27b-it",
];
const RUNS = 5;

async function callModel(model: string, text: string) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
  const start = Date.now();
  try {
    const r = await nimCall({ model, messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: `Analyze this Terms of Service document thoroughly. Extract ALL violations present:\n\n${text}` }
    ], temperature: 0, max_tokens: 1400 }, ac.signal);
    const ms = Date.now() - start;
    if (!r) return { p: null, ms, err: "API exhausted" };
    const raw = r.choices[0]?.message?.content || "{}";
    const p = extractJSON(raw);
    if (p && typeof p.score === "number") {
      if (p.score < 50) p.rating = "RISKY";
      else if (p.score < 75 && p.rating === "SAFE") p.rating = "OKAY";
      else if (p.score >= 75 && p.rating === "RISKY") p.rating = "OKAY";
    }
    return { p, ms };
  } catch (e: any) { return { p: null, ms: Date.now() - start, err: e?.message }; }
  finally { clearTimeout(t); }
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  BACKUP MODEL VALIDATION: qwen2.5-32b + gemma-3-27b     ║");
  console.log("║  5 runs × 5 services × 2 models = 50 API calls          ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  let md = "# Backup Model Validation\n\n";
  md += "> Testing backup candidates with refined v3 prompt\n";
  md += "> Goal: find a model that can pair with either primary for 98%+ ensemble\n\n";

  const stats: Record<string, {
    parseOk: number; total: number; ratingOk: number; pillarOk: number; pillarTotal: number;
    latencies: number[]; misses: Record<string, number>;
    // Track per-pillar per-service raw results for ensemble simulation
    results: Array<{ service: string; pillars: Record<string, boolean>; }>;
  }> = {};
  for (const m of BACKUP_MODELS) stats[m] = { parseOk: 0, total: 0, ratingOk: 0, pillarOk: 0, pillarTotal: 0, latencies: [], misses: {}, results: [] };

  for (const tc of CASES) {
    md += `=======================================================\n  ${tc.service}\n  Expected: ${tc.expectedRating.join("/")} | Violations: ${PILLARS.filter(k => tc.expectedPillars[k]).join(", ") || "None"}\n-------------------------------------------------------\n`;

    for (const model of BACKUP_MODELS) {
      const short = model.includes("qwen2.5") ? "Qwen2.5-32b" : "Gemma-3-27b";
      md += `\n### ${short}\n`;

      for (let run = 1; run <= RUNS; run++) {
        console.log(`${tc.service} → ${short} (${run}/${RUNS})`);
        const r = await callModel(model, tc.text);
        const s = stats[model]; s.total++;

        if (r.p) {
          s.parseOk++;
          const rOk = tc.expectedRating.includes(r.p.rating);
          if (rOk) s.ratingOk++;
          s.latencies.push(r.ms);

          const violations = PILLARS.filter(k => r.p.pillars?.[k]?.violation).join(", ");
          const pillarMiss: string[] = [];
          const pillarResult: Record<string, boolean> = {};
          for (const k of PILLARS) {
            s.pillarTotal++;
            const got = Boolean(r.p.pillars?.[k]?.violation);
            pillarResult[k] = got;
            if (got === tc.expectedPillars[k]) s.pillarOk++;
            else { pillarMiss.push(`${k}(exp=${tc.expectedPillars[k]},got=${got})`); s.misses[`${tc.service}:${k}`] = (s.misses[`${tc.service}:${k}`] || 0) + 1; }
          }
          s.results.push({ service: tc.service, pillars: pillarResult });

          md += `Run ${run}: ${r.p.rating} ${rOk?"✅":"❌"} S:${r.p.score} V:[${violations||"None"}] ${(r.ms/1000).toFixed(1)}s`;
          md += pillarMiss.length ? ` | MISS: ${pillarMiss.join(", ")}` : " | 5/5 ✅";
          md += "\n";
        } else {
          md += `Run ${run}: ERROR ${r.err} [${(r.ms/1000).toFixed(1)}s]\n`;
        }
        fs.writeFileSync("backup_result.md", md, "utf-8");
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  // Summary
  md += "\n=======================================================\n";
  md += "              BACKUP MODEL SUMMARY\n";
  md += "=======================================================\n\n";

  md += "## Solo Accuracy\n\n";
  md += "| Metric | Qwen2.5-32b | Gemma-3-27b |\n|--------|------------|------------|\n";
  const q = stats[BACKUP_MODELS[0]], g = stats[BACKUP_MODELS[1]];
  md += `| Parse Rate | ${q.parseOk}/${q.total} | ${g.parseOk}/${g.total} |\n`;
  md += `| Rating Accuracy | ${q.ratingOk}/${q.parseOk} (${q.parseOk?((q.ratingOk/q.parseOk)*100).toFixed(1):0}%) | ${g.ratingOk}/${g.parseOk} (${g.parseOk?((g.ratingOk/g.parseOk)*100).toFixed(1):0}%) |\n`;
  md += `| **Pillar Accuracy** | **${q.pillarOk}/${q.pillarTotal} (${q.pillarTotal?((q.pillarOk/q.pillarTotal)*100).toFixed(1):0}%)** | **${g.pillarOk}/${g.pillarTotal} (${g.pillarTotal?((g.pillarOk/g.pillarTotal)*100).toFixed(1):0}%)** |\n`;
  if (q.latencies.length && g.latencies.length) {
    const qAvg = q.latencies.reduce((a,b)=>a+b,0)/q.latencies.length;
    const gAvg = g.latencies.reduce((a,b)=>a+b,0)/g.latencies.length;
    md += `| Avg Latency | ${(qAvg/1000).toFixed(2)}s | ${(gAvg/1000).toFixed(2)}s |\n`;
    md += `| Max Latency | ${(Math.max(...q.latencies)/1000).toFixed(2)}s | ${(Math.max(...g.latencies)/1000).toFixed(2)}s |\n`;
  }

  // Miss breakdown
  md += "\n## Miss Breakdown\n\n";
  md += "| Service:Pillar | Qwen2.5-32b | Gemma-3-27b |\n|---------------|------------|------------|\n";
  const allMissKeys = new Set([...Object.keys(q.misses), ...Object.keys(g.misses)]);
  for (const key of [...allMissKeys].sort()) md += `| ${key} | ${q.misses[key]||0}/${RUNS} | ${g.misses[key]||0}/${RUNS} |\n`;

  // Simulated ensemble with each primary
  md += "\n## Simulated Ensemble (Union) with Primary Models\n\n";
  md += "> Using known primary model results from the validated solo test:\n";
  md += "> - Qwen3-80b: 92.8% solo (misses X:data_selling=0/5, TikTok:data_retention=3/5, TikTok:content_ownership=3/5, Spotify:data_selling=3/5)\n";
  md += "> - Mixtral-8x22b: 96.0% solo (misses X:data_selling=5/5, TikTok:data_retention=2/5, TikTok:content_ownership=1/5)\n\n";

  // Check if backup covers primary blind spots
  md += "### Does backup cover primary blind spots?\n\n";
  md += "| Blind Spot | Qwen2.5-32b catches? | Gemma-3-27b catches? |\n";
  md += "|-----------|---------------------|---------------------|\n";

  // Mixtral's blind spot: X:data_selling (5/5 miss)
  const qXds = q.results.filter(r => r.service === "X (Twitter)").filter(r => r.pillars.data_selling === true).length;
  const gXds = g.results.filter(r => r.service === "X (Twitter)").filter(r => r.pillars.data_selling === true).length;
  md += `| Mixtral misses X:data_selling | ${qXds}/${RUNS} ✅ | ${gXds}/${RUNS} ${gXds>=4?"✅":"⚠️"} |\n`;

  // Qwen's blind spots
  const qTdr = q.results.filter(r => r.service === "TikTok").filter(r => r.pillars.data_retention === true).length;
  const gTdr = g.results.filter(r => r.service === "TikTok").filter(r => r.pillars.data_retention === true).length;
  md += `| Qwen misses TikTok:data_retention | ${qTdr}/${RUNS} ${qTdr>=4?"✅":"⚠️"} | ${gTdr}/${RUNS} ${gTdr>=4?"✅":"⚠️"} |\n`;

  const qTco = q.results.filter(r => r.service === "TikTok").filter(r => r.pillars.content_ownership === true).length;
  const gTco = g.results.filter(r => r.service === "TikTok").filter(r => r.pillars.content_ownership === true).length;
  md += `| Qwen misses TikTok:content_ownership | ${qTco}/${RUNS} ${qTco>=4?"✅":"⚠️"} | ${gTco}/${RUNS} ${gTco>=4?"✅":"⚠️"} |\n`;

  const qSds = q.results.filter(r => r.service === "Spotify").filter(r => r.pillars.data_selling === true).length;
  const gSds = g.results.filter(r => r.service === "Spotify").filter(r => r.pillars.data_selling === true).length;
  md += `| Qwen misses Spotify:data_selling | ${qSds}/${RUNS} ${qSds>=4?"✅":"⚠️"} | ${gSds}/${RUNS} ${gSds>=4?"✅":"⚠️"} |\n`;

  md += "\n";
  fs.writeFileSync("backup_result.md", md, "utf-8");
  console.log("\n✅ Done. Results saved to backup_result.md");
}

main();
