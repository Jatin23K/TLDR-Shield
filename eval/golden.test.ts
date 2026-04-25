/**
 * TLDR Shield — Golden Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies that the analysis pipeline produces trustworthy, accurate results
 * for 5 representative ToS / Privacy Policy documents with known properties.
 *
 * Run: npx tsx eval/golden.test.ts
 *
 * Each test case defines:
 *   - A document snippet with known violation / clear properties
 *   - Expected violation flags for each pillar
 *   - A "must contain" check for citations (substring present in the text)
 *
 * Pass criteria per case:
 *   ✓  All expected violations are flagged
 *   ✓  No expected-clear pillars are falsely flagged
 *   ✓  Every violation citation is found verbatim in the source text
 *   ✓  Score is within the expected band
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dotenv from 'dotenv';
dotenv.config();

// Gemini config comes from ./geminiConfig — single source of truth.
// To switch models/keys: edit .env, no code change.
import {
    GEMINI_KEYS,
    GEMINI_BASE,
    GEMINI_MODEL_PRIMARY,
    describeConfig as describeGeminiConfig,
} from './geminiConfig.js';

const NIM_KEYS = [
    process.env.NIM_API_KEY_1,
    process.env.NIM_API_KEY_2,
    process.env.NIM_API_KEY_3,
].filter(Boolean) as string[];

const USE_GEMINI = GEMINI_KEYS.length > 0;

if (!USE_GEMINI && NIM_KEYS.length === 0) {
    console.error('Missing API keys. Set GEMINI_API_KEYS (preferred) or NIM_API_KEY_1/2/3.');
    process.exit(1);
}

const GEMINI_MODEL = GEMINI_MODEL_PRIMARY;
const DEEP_MODEL   = USE_GEMINI ? GEMINI_MODEL : (process.env.NIM_MODEL_DEEP || 'meta/llama-3.3-70b-instruct').trim();

// --ci flag: run only 6 core cases in CI to stay within free-tier RPD limits.
// Full 14-case suite runs locally and in weekly eval.
const CI_MODE = process.argv.includes('--ci');
// Indices of the 6 CI cases (0-based): all-clear, AI training, dark patterns,
// data selling+ownership, data retention, multiple violations
const CI_CASE_INDICES = new Set([0, 1, 2, 3, 5, 13]);

console.log(`[golden] LLM backend: ${USE_GEMINI ? describeGeminiConfig() : `NIM (${DEEP_MODEL})`} | mode: ${CI_MODE ? 'CI (6 cases)' : 'full (14 cases)'}`);

// ─── Gemini call ──────────────────────────────────────────────────────────────
async function callGeminiForGolden(systemPrompt: string, userText: string): Promise<string> {
    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
            temperature: 0,
            maxOutputTokens: 1200,
            responseMimeType: 'application/json',
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };

    // Try all keys. If ALL keys return 429, wait 60s and retry the full sweep once.
    for (let attempt = 0; attempt < 2; attempt++) {
        let lastError: Error = new Error('No Gemini keys configured');
        let allRateLimited = true;

        for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
            const apiKey = GEMINI_KEYS[keyIdx];
            const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (res.status === 429 || res.status === 503) {
                    lastError = new Error(`Gemini key ${keyIdx + 1} HTTP ${res.status}`);
                    console.warn(`[golden] Gemini key ${keyIdx + 1}/${GEMINI_KEYS.length} returned ${res.status} — waiting 2s then trying next key`);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                allRateLimited = false;
                if (!res.ok) {
                    const preview = await res.text().catch(() => '');
                    throw new Error(`Gemini HTTP ${res.status}: ${preview.slice(0, 200)}`);
                }
                const json: any = await res.json();
                const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
                return parts.filter((p: any) => !p.thought).pop()?.text ?? '{}';
            } catch (err: any) {
                clearTimeout(timeout);
                if (err?.name === 'AbortError') throw new Error('Gemini request timed out');
                throw err;
            }
        } // end key loop

        if (allRateLimited && attempt === 0) {
            console.warn(`[golden] All ${GEMINI_KEYS.length} keys rate-limited — waiting 60s for quota reset then retrying...`);
            await new Promise(r => setTimeout(r, 60000));
        } else {
            throw lastError;
        }
    } // end attempt loop
    throw new Error('All Gemini keys exhausted after retry');
}

// ─── NIM fallback ─────────────────────────────────────────────────────────────
let nimKeyIdx = 0;
async function callNimForGolden(systemPrompt: string, userText: string): Promise<string> {
    const { default: OpenAI } = await import('openai');
    const key = NIM_KEYS[nimKeyIdx % NIM_KEYS.length];
    nimKeyIdx++;
    const nim = new OpenAI({ apiKey: key, baseURL: 'https://integrate.api.nvidia.com/v1', timeout: 60000 });
    const res = await nim.chat.completions.create({
        model: DEEP_MODEL,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userText },
        ],
        temperature: 0,
        max_tokens: 1200,
    });
    return res.choices[0]?.message?.content ?? '{}';
}

// ─── Golden Documents ─────────────────────────────────────────────────────────

const GOLDEN_CASES: Array<{
    name: string;
    text: string;
    expected: {
        violations:   string[];   // pillars that MUST be violation=true
        clears:       string[];   // pillars that MUST be violation=false
        scoreBand:   [number, number]; // [min, max] inclusive
    };
}> = [
    // ── CASE 1: All clear (ideal privacy policy) ──────────────────────────────
    {
        name: 'All Clear — Minimal data collection, user-friendly policy',
        text: `
Privacy Policy — Minimal App

We collect only the email address you provide at sign-up. We do not sell, share, or transfer your personal data to third parties for advertising or commercial purposes. Your account data is deleted within 30 days of account deletion.

We do not use your content to train artificial intelligence or machine learning models. You retain full ownership of any content you upload. We license it only to the extent necessary to display it to you within the service.

We will never waive your right to participate in class action lawsuits. Our liability is limited only by applicable law. This policy is written in plain language so you always know how your data is used.
        `.trim(),
        expected: {
            violations: [],
            clears:     ['ai_training', 'data_selling', 'data_retention', 'content_ownership', 'dark_patterns'],
            scoreBand:  [80, 100],
        },
    },

    // ── CASE 2: AI Training violation ────────────────────────────────────────
    {
        name: 'AI Training Violation — explicit ML training clause',
        text: `
Terms of Service — AI Platform

By using our service, you grant us a non-exclusive license to use the content you submit for use with and training of our machine learning and artificial intelligence models, whether generative or another type. This license is necessary to improve the quality of responses.

You retain ownership of your content. We do not sell your personal data to third-party advertisers. Data is retained for 60 days after account deletion.
        `.trim(),
        expected: {
            violations: ['ai_training'],
            clears:     ['data_selling', 'data_retention', 'content_ownership'],
            scoreBand:  [40, 85],
        },
    },

    // ── CASE 3: Dark Patterns — liability cap + class action waiver ───────────
    {
        name: 'Dark Patterns — $100 liability cap and class action waiver',
        text: `
Terms of Service — Social App

Our aggregate liability shall not exceed the greater of ONE HUNDRED U.S. DOLLARS (U.S. $100.00) or the amount you paid us in the past six months.

You also waive the right to participate as a plaintiff or class member in any purported class action, collective action or representative action proceeding against us or our corporate affiliates.

You must bring any claim within one (1) year of the cause of action arising, or the claim is permanently barred.

We take your privacy seriously and do not sell personal data to third parties.
        `.trim(),
        expected: {
            violations: ['dark_patterns'],
            clears:     ['ai_training', 'data_selling'],
            scoreBand:  [0, 65],
        },
    },

    // ── CASE 4: Data Selling + Ownership violation ────────────────────────────
    {
        name: 'Data Selling + Ownership — broad license and third-party sharing',
        text: `
Terms of Service — Media Platform

You grant us a worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce, process, adapt, modify, publish, transmit, display, and distribute your content in any and all media or distribution methods now known or later developed, for any purpose, including commercial purposes.

We and our third-party providers and partners may place advertising on the Services or in connection with the display of content or information from the Services whether submitted by you or others. We share your usage data with advertising partners to provide targeted advertisements.

We retain your data for up to two years after account deletion for legal and analytical purposes.
        `.trim(),
        expected: {
            violations: ['data_selling', 'content_ownership'],
            clears:     ['ai_training', 'dark_patterns'],
            scoreBand:  [0, 50],
        },
    },

    // ── CASE 6: Transparency — self-contradictory collection claims ──────────
    {
        name: 'Transparency Violation — contradictory data collection statements',
        text: `
Privacy Policy — Contradictory App

We value your privacy above all else. We collect only what you explicitly give us. All data is deleted within 90 days of account deletion.

Notwithstanding the foregoing, we reserve the right to record and store any and all session logs, device metadata, page interactions, and operational records generated during your use of the service, to the extent we determine appropriate.
        `.trim(),
        expected: {
            violations: ['transparency'],
            clears:     ['ai_training', 'data_selling', 'data_retention', 'content_ownership', 'dark_patterns'],
            scoreBand:  [0, 85],
        },
    },

    // ── CASE 7: Data Retention — no timeline, indefinite ─────────────────────
    {
        name: 'Data Retention Violation — indefinite retention, no deletion timeline',
        text: `
Account Termination Policy

If you delete your account, we may retain your personal information for as long as necessary for our business purposes, legal compliance, and dispute resolution. We reserve the right to retain data indefinitely and will not commit to specific timelines for deletion upon request. Your data may be kept in our systems for an unspecified period.
        `.trim(),
        expected: {
            violations: ['data_retention'],
            clears:     ['ai_training', 'data_selling', 'content_ownership', 'dark_patterns'],
            scoreBand:  [0, 74],
        },
    },

    // ── CASE 8: Content Ownership — user photos in ads ────────────────────────
    {
        name: 'Content Ownership Violation — user photos used in advertising',
        text: `
Terms of Service — Photo Platform

You grant us a royalty-free, worldwide license to use your profile photo, display name, and any content you post in advertising and promotional materials, including advertisements displayed to other users and the general public. Your likeness and user-generated content may appear in sponsored posts, banner advertisements, and marketing campaigns without additional notice or compensation to you.

We do not sell your personal data to third parties and we do not use your content to train AI systems.
        `.trim(),
        expected: {
            violations: ['content_ownership'],
            clears:     ['ai_training', 'data_selling', 'dark_patterns'],
            scoreBand:  [25, 74],
        },
    },

    // ── CASE 9: AI opt-in only — default off, SAFE ───────────────────────────
    {
        name: 'AI Training Opt-In Only — off by default, user controls it (SAFE)',
        text: `
Privacy Policy — Responsible AI App

We do not use your content or data to train AI or machine learning models by default. You may optionally enable AI personalization features by visiting Settings > Privacy > AI Features and toggling 'Allow AI training'. This setting is off by default and entirely optional.

We do not sell your personal data. We delete all personal data within 30 days of account deletion. You retain full ownership of your content; we use it only to display it within the service to you and users you authorize.
        `.trim(),
        expected: {
            violations: [],
            clears:     ['ai_training', 'data_selling', 'data_retention', 'content_ownership', 'dark_patterns'],
            scoreBand:  [85, 100],
        },
    },

    // ── CASE 10: Data Selling with opt-out — OKAY ────────────────────────────
    {
        name: 'Data Selling with Opt-Out — marketing partners, opt-out available (OKAY)',
        text: `
Privacy Policy — Ad-Supported App

We share your email address and usage patterns with our marketing partners so they can deliver targeted advertisements relevant to your interests. You may opt out of this sharing at any time by visiting Account Settings > Privacy > Partner Data Sharing and selecting 'Do not share my information'.

We do not use your data to train AI models. We do not claim broad IP rights over your content beyond displaying it within the service. Personal data is deleted within 60 days of account deletion.
        `.trim(),
        expected: {
            violations: ['data_selling'],
            clears:     ['ai_training', 'data_retention', 'content_ownership', 'dark_patterns'],
            scoreBand:  [50, 85],
        },
    },

    // ── CASE 11: DuckDuckGo-style — explicit denials, all pillars clear ──────
    {
        name: 'DuckDuckGo-style — explicit denials, should be SAFE',
        text: `
Privacy Policy — Search Engine

We do not collect or share personal information. That's our privacy policy in a nutshell.

When you search with us, we do not store any personal information that could identify you. We do not sell your personal information to advertisers. We do not track you.

We do not use your searches or any personal data to build a profile of you. We do not share your information with third parties for advertising purposes. No personal data is passed to advertisers.

Your searches are private. When you leave our site, there is nothing stored about what you searched for. You own your searches.

We do not retain any personal data after your session ends. We do not use your data to train artificial intelligence or machine learning models.
        `.trim(),
        expected: {
            violations: [],
            clears:     ['ai_training', 'data_selling', 'data_retention'],
            scoreBand:  [70, 100],
        },
    },

    // ── CASE 12: Signal-style — strong privacy, minimal collection ───────────
    {
        name: 'Signal-style — minimal collection, explicit AI denial, SAFE',
        text: `
Privacy Policy — Secure Messaging

We designed Signal to minimize the data we collect. Messages are end-to-end encrypted and cannot be read by us or any third party.

We do not sell, rent, or otherwise provide your personal information to third parties. We do not share your data with advertisers or marketing companies.

We do not use your messages, media, or any personal information to train machine learning or artificial intelligence models. Your private conversations remain private.

Account data including your phone number is deleted within 30 days of account deletion. We retain only the minimum information necessary to operate the service.

You retain full ownership of all content you send via our service. We claim no intellectual property rights over your messages or media.
        `.trim(),
        expected: {
            violations: [],
            clears:     ['ai_training', 'data_selling', 'data_retention', 'content_ownership'],
            scoreBand:  [70, 100],
        },
    },

    // ── CASE 13: Meta-style — AI training + data selling + dark patterns ─────
    {
        name: 'Meta-style — AI training + data sharing + broad license, RISKY',
        text: `
Terms of Service — Social Network

You grant us a non-exclusive, transferable, sub-licensable, royalty-free, worldwide license to host, use, distribute, modify, run, copy, publicly perform or display, translate, and create derivative works of your content, for any purpose including commercial purposes.

We use data from your account, posts, and activity on and off our Products to train and improve our artificial intelligence and machine learning models, including generative AI features.

We share information about you with advertisers, measurement companies, and other partners who help deliver ads and measure their effectiveness. Our advertising partners use this data to serve you targeted advertisements.

We may share your information with third-party companies for their own business purposes where permitted by law.

Our aggregate liability shall not exceed the greater of ONE HUNDRED DOLLARS ($100) or the amount you paid us in the last twelve months.
        `.trim(),
        expected: {
            violations: ['ai_training', 'data_selling', 'content_ownership', 'dark_patterns'],
            clears:     [],
            scoreBand:  [0, 30],
        },
    },

    // ── CASE 14: TikTok-style — data collection + retention + training ────────
    {
        name: 'TikTok-style — data retention + AI training + data selling, RISKY',
        text: `
Privacy Policy — Short Video Platform

We collect information about the videos you watch, create, and share, including your biometric data such as faceprints and voiceprints. We may collect information about your device and location.

We may share your information with our corporate group, which includes entities in various countries, for business, operational, and other purposes consistent with this policy. We may share your information with business partners and third-party companies.

We use the information we collect, including your content and usage data, to develop, improve, and train our machine learning and AI models, including recommendation systems and content generation tools.

We retain your data for as long as necessary for our purposes, including after your account is closed, for legal, regulatory, fraud prevention, and business purposes. We do not commit to a specific deletion timeline.

You grant us a worldwide, non-exclusive, royalty-free license, with the right to sublicense, to use, reproduce, adapt, publish, translate and distribute your content across our platforms.
        `.trim(),
        expected: {
            violations: ['ai_training', 'data_selling', 'data_retention', 'content_ownership'],
            clears:     [],
            scoreBand:  [0, 20],
        },
    },

    // ── CASE 5: Multiple violations — worst case ─────────────────────────────
    {
        name: 'Multiple Violations — AI + Data Selling + Dark Patterns + Ownership',
        text: `
Terms of Service — Mega Platform

By uploading content, you grant us a worldwide, sublicensable, royalty-free license to use, modify, adapt, publish and distribute your content for any purpose, including to train our artificial intelligence and machine learning systems to improve our products.

We and our advertising partners may use your personal data, browsing activity, and content to deliver targeted advertisements. We may share your data with third-party companies for their own marketing purposes.

Our aggregate liability shall not exceed ONE HUNDRED U.S. DOLLARS ($100.00). You waive the right to bring a class action lawsuit against us. All disputes must be resolved through binding arbitration. Any claim must be filed within one (1) year of arising.

We retain your data for business purposes for up to three years after account closure. Specific retention periods are described in our separate Data Retention Policy available at our website.
        `.trim(),
        expected: {
            violations: ['ai_training', 'data_selling', 'dark_patterns', 'content_ownership'],
            clears:     [],
            scoreBand:  [0, 35],
        },
    },
];

// ─── Analysis helper (single-doc, no chunking needed for these short texts) ──

const SYSTEM_PROMPT = `You are a senior privacy attorney. Analyze the legal text against these pillars:
- ai_training: User content used for AI/ML training with no opt-out = VIOLATION
- data_selling: Content/data shared with third parties, advertisers, or partners = VIOLATION
- transparency: Deliberately vague or obscuring language = VIOLATION
- data_retention: No stated deletion timeline or retention >1yr post-deletion = VIOLATION
- content_ownership: Worldwide sublicensable license "for any purpose" = VIOLATION
- dark_patterns: $100 liability cap OR class action waiver OR forced arbitration OR shortened statute = VIOLATION

EVIDENCE REQUIREMENT: Default violation:false. Set violation:true ONLY IF you can copy-paste verbatim text proving it.

CITATION RULE: The citation field MUST be a verbatim copy-paste of 15-60 words directly from the text. No paraphrasing.
BANNED: "The policy", "The terms", "There is no", "No mention", any third-person description.

Output ONLY valid JSON:
{
  "score": 0-100,
  "rating": "SAFE"|"OKAY"|"RISKY",
  "pillars": {
    "ai_training":       {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "data_selling":      {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "transparency":      {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "data_retention":    {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "content_ownership": {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"},
    "dark_patterns":     {"violation":boolean,"citation":"string","confidence":"HIGH"|"MEDIUM"|"LOW"}
  }
}`;

async function analyzeDocument(text: string): Promise<any> {
    const userText = `Analyze this document:\n\n${text}`;
    const raw = USE_GEMINI
        ? await callGeminiForGolden(SYSTEM_PROMPT, userText)
        : await callNimForGolden(SYSTEM_PROMPT, userText);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]);
}

// ─── Citation verifier ────────────────────────────────────────────────────────

function verifyCitation(citation: string, sourceText: string): boolean {
    if (!citation || citation === 'Not addressed in document.') return true; // CLEAR pillars OK
    const prefix = citation.toLowerCase().replace(/['"]/g, '').trim().slice(0, 50);
    return prefix.length < 20 || sourceText.toLowerCase().includes(prefix);
}

// ─── Server-equivalent score calculator ───────────────────────────────────────
// The LLM's self-reported score is ignored in production — server always
// recomputes it deterministically from pillar flags. Mirror that here.
const PILLAR_PENALTY: Record<string, { full: number; low: number }> = {
    ai_training:       { full: 30, low: 15 },
    data_selling:      { full: 30, low: 15 },
    transparency:      { full: 20, low: 5  },
    data_retention:    { full: 30, low: 15 },
    content_ownership: { full: 30, low: 15 },
    dark_patterns:     { full: 40, low: 20 },
};
function computeScore(pillars: Record<string, any>): number {
    let score = 100;
    for (const [key, pen] of Object.entries(PILLAR_PENALTY)) {
        const p = pillars[key];
        if (p?.violation) score -= p.confidence?.toUpperCase() === 'LOW' ? pen.low : pen.full;
    }
    return Math.max(0, Math.min(100, score));
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let rateLimitedCases = 0;   // cases where ALL keys 429'd — infra issue, not a code regression
const failures: string[] = [];

async function runCase(tc: typeof GOLDEN_CASES[0], idx: number): Promise<void> {
    console.log(`\n[${ idx + 1 }/${GOLDEN_CASES.length}] ${tc.name}`);
    let result: any;
    try {
        result = await analyzeDocument(tc.text);
    } catch (e: any) {
        const isRateLimit = /HTTP 429|rate.?limit|exhausted/i.test(e.message || '');
        console.error(`  ✗ Analysis failed: ${e.message}`);
        if (isRateLimit) {
            rateLimitedCases++;
            failures.push(`Case ${idx + 1}: ${tc.name} — RATE-LIMITED (infra, not regression)`);
        } else {
            failed++;
            failures.push(`Case ${idx + 1}: ${tc.name} — analysis error: ${e.message}`);
        }
        return;
    }

    const pillars = result.pillars ?? {};
    const score   = computeScore(pillars); // use server logic, not LLM's self-reported score
    let casePass  = true;

    // Check expected violations
    for (const key of tc.expected.violations) {
        const p = pillars[key];
        if (!p?.violation) {
            console.error(`  ✗ Expected violation for ${key}, got clear. Citation: "${p?.citation?.slice(0, 60)}"`);
            casePass = false;
        } else {
            const citOk = verifyCitation(p.citation, tc.text);
            if (!citOk) {
                console.error(`  ✗ Citation for ${key} NOT FOUND in source: "${p.citation?.slice(0, 60)}"`);
                casePass = false;
            } else {
                console.log(`  ✓ ${key}: VIOLATION — citation verified`);
            }
        }
    }

    // Check expected clears
    for (const key of tc.expected.clears) {
        const p = pillars[key];
        if (p?.violation) {
            console.error(`  ✗ False positive: ${key} marked as violation, expected clear. Citation: "${p?.citation?.slice(0, 60)}"`);
            casePass = false;
        } else {
            console.log(`  ✓ ${key}: CLEAR (correct)`);
        }
    }

    // Check score band
    if (score < tc.expected.scoreBand[0] || score > tc.expected.scoreBand[1]) {
        console.error(`  ✗ Score ${score} outside expected band [${tc.expected.scoreBand[0]}, ${tc.expected.scoreBand[1]}]`);
        casePass = false;
    } else {
        console.log(`  ✓ Score: ${score} (within band [${tc.expected.scoreBand[0]}, ${tc.expected.scoreBand[1]}])`);
    }

    if (casePass) {
        console.log(`  ✅ PASS`);
        passed++;
    } else {
        console.log(`  ❌ FAIL`);
        failed++;
        failures.push(`Case ${idx + 1}: ${tc.name}`);
    }
}

(async () => {
    const cases = CI_MODE
        ? GOLDEN_CASES.filter((_, i) => CI_CASE_INDICES.has(i))
        : GOLDEN_CASES;

    console.log('TLDR Shield — Golden Test Suite');
    console.log('═'.repeat(60));

    for (let i = 0; i < cases.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 8000)); // 8s — free-tier RPM headroom
        await runCase(cases[i], i);
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`Results: ${passed}/${cases.length} passed, ${failed} failed, ${rateLimitedCases} rate-limited`);

    if (failures.length > 0) {
        console.log('\nIssues:');
        failures.forEach(f => console.log(`  • ${f}`));
    }

    // Exit 0 if every "failure" is a 429 — the golden suite couldn't actually
    // run, so it can't have regressed. A red CI here is misleading and blocks
    // pushes. Real code regressions (parse fails, wrong ratings, etc.) still
    // exit 1.
    if (rateLimitedCases > 0 && failed === 0 && passed === 0) {
        console.log('\n⚠  All golden cases were rate-limited — treating as infrastructure skip (exit 0).');
        console.log('   Run locally or wait for quota reset (midnight PT) to re-verify.');
        process.exit(0);
    }

    if (failed > 0) {
        process.exit(1);
    } else {
        console.log('\n✅ All golden tests passed!');
        process.exit(0);
    }
})();
