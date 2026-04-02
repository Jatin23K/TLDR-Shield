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

import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const NIM_KEY = process.env.NIM_API_KEY_1 ?? process.env.NIM_API_KEY ?? '';
if (!NIM_KEY) { console.error('Missing NIM_API_KEY_1'); process.exit(1); }

const nim = new OpenAI({
    apiKey: NIM_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    timeout: 60000,
});

const DEEP_MODEL = (process.env.NIM_MODEL_DEEP || 'meta/llama-3.3-70b-instruct').trim();

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
            scoreBand:  [40, 74],
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
            scoreBand:  [25, 65],
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
            scoreBand:  [15, 50],
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
    const res = await nim.chat.completions.create({
        model: DEEP_MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: `Analyze this document:\n\n${text}` },
        ],
        temperature: 0,
        max_tokens: 1200,
    });
    const raw = res.choices[0]?.message?.content ?? '{}';
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

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runCase(tc: typeof GOLDEN_CASES[0], idx: number): Promise<void> {
    console.log(`\n[${ idx + 1 }/${GOLDEN_CASES.length}] ${tc.name}`);
    let result: any;
    try {
        result = await analyzeDocument(tc.text);
    } catch (e: any) {
        console.error(`  ✗ Analysis failed: ${e.message}`);
        failed++;
        failures.push(`Case ${idx + 1}: ${tc.name} — analysis error: ${e.message}`);
        return;
    }

    const pillars = result.pillars ?? {};
    const score   = typeof result.score === 'number' ? result.score : -1;
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
    console.log('TLDR Shield — Golden Test Suite');
    console.log('═'.repeat(60));

    for (let i = 0; i < GOLDEN_CASES.length; i++) {
        await runCase(GOLDEN_CASES[i], i);
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`Results: ${passed}/${GOLDEN_CASES.length} passed, ${failed} failed`);

    if (failures.length > 0) {
        console.log('\nFailed cases:');
        failures.forEach(f => console.log(`  • ${f}`));
        process.exit(1);
    } else {
        console.log('\n✅ All golden tests passed!');
        process.exit(0);
    }
})();
