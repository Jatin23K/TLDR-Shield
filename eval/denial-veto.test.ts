/**
 * Unit tests for applyDenialVeto — the explicit-denial override.
 *
 * applyDenialVeto scans the full policy text for explicit denial phrases
 * ("we do not sell", "we will not use for AI training", etc.) and vetoes
 * a pillar violation back to false even if the LLM flagged it.
 *
 * Run: npx tsx eval/denial-veto.test.ts
 */

// Import the function once it is exported from server.ts.
// If the import fails, the test suite reports a hard failure below.
let applyDenialVeto: (pillars: Record<string, any>, fullText: string) => void;

async function loadFunction(): Promise<boolean> {
    try {
        // Dynamic import so we get a clean error message when not yet implemented.
        const mod = await import('../denial-veto.js');
        applyDenialVeto = mod.applyDenialVeto;
        return true;
    } catch {
        return false;
    }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makePillars(violations: string[]): Record<string, any> {
    const keys = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership', 'dark_patterns'];
    const pillars: Record<string, any> = {};
    for (const k of keys) {
        pillars[k] = { violation: violations.includes(k), citation: 'some citation', confidence: 'HIGH' };
    }
    return pillars;
}

let passed = 0;
let failed = 0;

function check(label: string, actual: boolean, expected: boolean): void {
    if (actual === expected) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label} — expected ${expected}, got ${actual}`);
        failed++;
    }
}

// ─── Test cases ───────────────────────────────────────────────────────────────

function testDataSellingDenial(): void {
    console.log('\n[1] Explicit "we do not sell" vetoes data_selling violation');
    const pillars = makePillars(['data_selling']);
    const text = 'We do not sell your personal data to any third party for commercial purposes.';
    applyDenialVeto(pillars, text);
    check('data_selling vetoed to false', pillars['data_selling'].violation, false);
    check('ai_training unchanged (false)', pillars['ai_training'].violation, false);
}

function testAiTrainingDenial(): void {
    console.log('\n[2] Explicit "we do not use your content to train AI" vetoes ai_training violation');
    const pillars = makePillars(['ai_training']);
    const text = 'We do not use your content or data to train artificial intelligence or machine learning models.';
    applyDenialVeto(pillars, text);
    check('ai_training vetoed to false', pillars['ai_training'].violation, false);
}

function testNeverShareDenial(): void {
    console.log('\n[3] "we never share personal information" vetoes data_selling');
    const pillars = makePillars(['data_selling']);
    const text = 'We never share your personal information with third parties.';
    applyDenialVeto(pillars, text);
    check('data_selling vetoed to false', pillars['data_selling'].violation, false);
}

function testWillNotTrainDenial(): void {
    console.log('\n[4] "will not be used to train" vetoes ai_training');
    const pillars = makePillars(['ai_training']);
    const text = 'Your data will not be used to train machine learning systems or AI models.';
    applyDenialVeto(pillars, text);
    check('ai_training vetoed to false', pillars['ai_training'].violation, false);
}

function testNoDenialPresent(): void {
    console.log('\n[5] No explicit denial — violations remain unchanged');
    const pillars = makePillars(['data_selling', 'ai_training']);
    const text = 'We share your data with advertising partners to deliver relevant advertisements.';
    applyDenialVeto(pillars, text);
    check('data_selling stays true (no denial)', pillars['data_selling'].violation, true);
    check('ai_training stays true (no denial)', pillars['ai_training'].violation, true);
}

function testSellingDenialDoesNotVetoAiTraining(): void {
    console.log('\n[6] data_selling denial does NOT veto ai_training');
    const pillars = makePillars(['ai_training', 'data_selling']);
    const text = 'We do not sell your data.';
    applyDenialVeto(pillars, text);
    check('data_selling vetoed', pillars['data_selling'].violation, false);
    check('ai_training still true (wrong pillar denial)', pillars['ai_training'].violation, true);
}

function testOptOutIsNotDenial(): void {
    console.log('\n[7] Opt-out language alone does NOT veto — only absolute denials');
    const pillars = makePillars(['ai_training']);
    const text = 'You may opt out of AI training by visiting your account settings.';
    applyDenialVeto(pillars, text);
    // Opt-out means training IS happening by default — should NOT veto
    check('ai_training NOT vetoed (opt-out ≠ denial)', pillars['ai_training'].violation, true);
}

function testDuckDuckGoStyle(): void {
    console.log('\n[8] DuckDuckGo-style policy — multiple explicit denials veto all pillars');
    const pillars = makePillars(['ai_training', 'data_selling', 'data_retention']);
    const text = `
        We do not sell or share your personal information to third parties.
        We do not store your personal information.
        We will never use your searches to create a personal profile of you.
        We do not use your data to train AI models.
    `;
    applyDenialVeto(pillars, text);
    check('data_selling vetoed', pillars['data_selling'].violation, false);
    check('ai_training vetoed', pillars['ai_training'].violation, false);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
    console.log('TLDR Shield — applyDenialVeto Unit Tests');
    console.log('═'.repeat(50));

    const loaded = await loadFunction();
    if (!loaded) {
        console.error('\n✗ HARD FAIL: Could not import applyDenialVeto from denial-veto.ts');
        console.error('  Implement and export applyDenialVeto from denial-veto.ts first.\n');
        process.exit(1);
    }

    testDataSellingDenial();
    testAiTrainingDenial();
    testNeverShareDenial();
    testWillNotTrainDenial();
    testNoDenialPresent();
    testSellingDenialDoesNotVetoAiTraining();
    testOptOutIsNotDenial();
    testDuckDuckGoStyle();

    console.log('\n' + '═'.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) process.exit(1);
    else console.log('\n✅ All denial-veto tests passed!');
})();
