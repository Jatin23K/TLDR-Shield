/**
 * Stability harness — runs the same eval dataset N times and reports
 * verdict variance per case.
 *
 * Why this exists: a system that scores 95% on a single run but flips
 * verdicts (SAFE → RISKY) across trials isn't credible. Stability is
 * just as important as accuracy. This harness measures it.
 *
 * Usage:
 *   npm run eval:stability                        # 3 trials, deep20 dataset
 *   GEMINI_MODEL_PRIMARY=gemini-3.1-flash-lite-preview \
 *   GEMINI_MODEL_CORROBORATOR=gemini-2.5-flash-lite \
 *     npm run eval:stability                       # swap models via .env, no code
 *   STABILITY_TRIALS=5 npm run eval:stability     # more trials
 *   STABILITY_DATASET=eval/dataset_basic.jsonl npm run eval:stability
 *
 * Output: per-case verdict array + variance flag. A case is "stable"
 * if all trials produce the same rating. Overall stability % is the
 * fraction of cases with zero variance across all trials.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { describeConfig as describeGeminiConfig } from './geminiConfig.js';

const TRIALS  = Number(process.env.STABILITY_TRIALS ?? 3);
const DATASET = process.env.STABILITY_DATASET ?? 'eval/dataset_deep.jsonl';
const TIER    = process.env.STABILITY_TIER ?? 'deep';

interface CaseResult { id: string; rating: string; score: number | null; }

async function runOnce(trial: number): Promise<CaseResult[]> {
    return new Promise((resolve, reject) => {
        const args = ['eval/runEval.ts', `--dataset=${DATASET}`, `--tier=${TIER}`];
        const child = spawn('tsx', args, {
            stdio: ['ignore', 'pipe', 'inherit'],
            shell: process.platform === 'win32',
            env: { ...process.env, EVAL_QUIET: '1' },
        });
        let buf = '';
        child.stdout.on('data', (d) => { buf += d.toString(); });
        child.on('exit', (code) => {
            if (code !== 0) return reject(new Error(`Trial ${trial} exited ${code}`));
            try {
                // runEval prints two JSON blocks (quick + deep). Find the last { … }
                // matching the requested tier.
                const matches = [...buf.matchAll(/\{[\s\S]*?"results":\s*\[[\s\S]*?\][\s\S]*?\}/g)];
                if (!matches.length) return reject(new Error(`Trial ${trial}: no JSON block found`));
                const lastJson = JSON.parse(matches[matches.length - 1][0]);
                const cases: CaseResult[] = (lastJson.results ?? []).map((r: any) => ({
                    id: r.id,
                    rating: r.predicted?.rating ?? 'NULL',
                    score:  r.predicted?.score ?? null,
                }));
                resolve(cases);
            } catch (err) {
                reject(err);
            }
        });
        child.on('error', reject);
    });
}

async function main() {
    console.log(`[stability] ${describeGeminiConfig()}`);
    console.log(`[stability] dataset=${DATASET}  tier=${TIER}  trials=${TRIALS}`);
    const trials: CaseResult[][] = [];
    for (let i = 1; i <= TRIALS; i++) {
        console.log(`[stability] trial ${i}/${TRIALS} starting…`);
        const t0 = Date.now();
        const r = await runOnce(i);
        console.log(`[stability] trial ${i}/${TRIALS} complete (${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.length} cases)`);
        trials.push(r);
    }

    // Aggregate per-case verdicts.
    const ids = Array.from(new Set(trials.flatMap(t => t.map(c => c.id))));
    const perCase = ids.map(id => {
        const ratings = trials.map(t => t.find(c => c.id === id)?.rating ?? 'MISSING');
        const scores  = trials.map(t => t.find(c => c.id === id)?.score  ?? null);
        const stable  = ratings.every(r => r === ratings[0]);
        const scoreSpread = scores.filter((s): s is number => typeof s === 'number');
        const scoreMin = scoreSpread.length ? Math.min(...scoreSpread) : null;
        const scoreMax = scoreSpread.length ? Math.max(...scoreSpread) : null;
        return { id, ratings, stable, scoreMin, scoreMax, scoreRange: scoreMin !== null && scoreMax !== null ? scoreMax - scoreMin : null };
    });

    const stableCount = perCase.filter(c => c.stable).length;
    const stabilityPct = (stableCount / perCase.length) * 100;
    const avgScoreRange = perCase
        .map(c => c.scoreRange)
        .filter((n): n is number => typeof n === 'number')
        .reduce((a, b) => a + b, 0) / Math.max(1, perCase.filter(c => typeof c.scoreRange === 'number').length);

    const summary = {
        config: describeGeminiConfig(),
        dataset: DATASET,
        tier: TIER,
        trials: TRIALS,
        casesEvaluated: perCase.length,
        stableCases: stableCount,
        stabilityPct: Number(stabilityPct.toFixed(2)),
        avgScoreRange: Number(avgScoreRange.toFixed(2)),
        unstableCases: perCase.filter(c => !c.stable),
    };
    console.log('\n=== STABILITY SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));

    const outPath = path.resolve('eval', `stability-report-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify({ summary, perCase }, null, 2));
    console.log(`\n[stability] full report written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
