import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const cwd = 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR';
const models = [
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-medium-3-instruct',
  'mistralai/mistral-nemotron',
  'qwen/qwen3.5-122b-a10b',
];

function runEval(model, tier) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      NIM_MODEL_QUICK: model,
      NIM_MODEL_DEEP: model,
    };

    const psCmd = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; npm.cmd run ${tier === 'quick' ? 'eval:quick' : 'eval:deep'}`;
    const child = spawn('powershell.exe', ['-Command', psCmd], { env, windowsHide: true });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); process.stdout.write(d.toString()); });
    child.stderr.on('data', d => { err += d.toString(); process.stderr.write(d.toString()); });
    child.on('close', (code) => {
      const parsed = extractEvalJson(out);
      resolve({ code, parsed, stdout: out, stderr: err });
    });
  });
}

function extractEvalJson(raw) {
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const s = raw.slice(start, i + 1);
        try {
          const obj = JSON.parse(s);
          if (obj?.tier && obj?.accuracy) return obj;
        } catch {}
        start = -1;
      }
    }
  }
  return null;
}

const results = [];
for (const model of models) {
  console.log(`\n=== MODEL: ${model} ===`);
  const quick = await runEval(model, 'quick');
  const deep = await runEval(model, 'deep');
  results.push({
    model,
    quick: quick.parsed ? {
      ratingPct: quick.parsed.accuracy.ratingPct,
      pillarsPct: quick.parsed.accuracy.pillarsPct,
      p50: quick.parsed.latencyMs.p50,
      p90: quick.parsed.latencyMs.p90,
      parseFails: quick.parsed.parseFails,
      errors: quick.parsed.perCase?.filter?.(c => c.error)?.length ?? null,
      code: quick.code,
    } : { parse_error: true, code: quick.code },
    deep: deep.parsed ? {
      ratingPct: deep.parsed.accuracy.ratingPct,
      pillarsPct: deep.parsed.accuracy.pillarsPct,
      p50: deep.parsed.latencyMs.p50,
      p90: deep.parsed.latencyMs.p90,
      parseFails: deep.parsed.parseFails,
      errors: deep.parsed.perCase?.filter?.(c => c.error)?.length ?? null,
      code: deep.code,
    } : { parse_error: true, code: deep.code },
  });
}

writeFileSync(`${cwd}/scratch/model_eval_matrix.json`, JSON.stringify(results, null, 2));
console.log('\nWROTE scratch/model_eval_matrix.json');
console.log(JSON.stringify(results, null, 2));
