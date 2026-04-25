import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'node:fs';

dotenv.config({ path: 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env', quiet: true });
const keys = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean);
if (!keys.length) {
  console.error('No NIM keys found in .env');
  process.exit(1);
}
let keyIdx = 0;
const baseURL = 'https://integrate.api.nvidia.com/v1';

const models = [
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-nemotron',
  'qwen/qwen3-next-80b-a3b-instruct',
  'stockmark/stockmark-2-100b-instruct',
  'moonshotai/kimi-k2-instruct-0905',
  'mistralai/mixtral-8x22b-instruct-v0.1',
];

const quickPrompt = 'Return strict JSON only: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}. Text: We do not sell personal data. Data deleted in 30 days. No AI training without opt-in.';
const deepClause = 'By using this service, you grant us a worldwide sublicensable royalty-free license for any purpose including training machine learning models. We may share personal data with advertising and analytics partners for commercial use. You waive class action rights and agree to binding arbitration. We may retain data indefinitely after account deletion.';
const deepPrompt = `Return strict JSON only with pillars and citations. Analyze this legal text:\n${(deepClause + ' ').repeat(38)}`;

function median(values) {
  const s = [...values].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)] ?? null;
}
function avg(values){
  if(!values.length) return null;
  return Math.round(values.reduce((a,b)=>a+b,0)/values.length);
}

async function callModel(model, tier) {
  const client = new OpenAI({ apiKey: keys[keyIdx % keys.length], baseURL });
  keyIdx++;
  const timeoutMs = tier === 'quick' ? 20000 : 40000;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: tier === 'quick' ? 120 : 1400,
      messages: [
        { role: 'system', content: 'You are a legal-policy analyzer. Output strict JSON only.' },
        { role: 'user', content: tier === 'quick' ? quickPrompt : deepPrompt },
      ],
    }, { signal: ctl.signal });

    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, status: e?.status || 0, err: e?.message || String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

const results = [];
for (const model of models) {
  const quickRuns = [];
  const deepRuns = [];
  for (let i = 0; i < 3; i++) quickRuns.push(await callModel(model, 'quick'));
  for (let i = 0; i < 3; i++) deepRuns.push(await callModel(model, 'deep'));

  const qTimes = quickRuns.filter(r=>r.ok).map(r=>r.ms);
  const dTimes = deepRuns.filter(r=>r.ok).map(r=>r.ms);

  const row = {
    model,
    quick_actual_ms_avg: avg(qTimes),
    quick_actual_ms_p50: median(qTimes),
    deep_actual_ms_avg: avg(dTimes),
    deep_actual_ms_p50: median(dTimes),
    quick_success: `${qTimes.length}/3`,
    deep_success: `${dTimes.length}/3`,
    quick_runs: quickRuns,
    deep_runs: deepRuns,
  };
  results.push(row);

  console.log(JSON.stringify({
    model,
    quick_actual_ms_avg: row.quick_actual_ms_avg,
    quick_actual_ms_p50: row.quick_actual_ms_p50,
    deep_actual_ms_avg: row.deep_actual_ms_avg,
    deep_actual_ms_p50: row.deep_actual_ms_p50,
    quick_success: row.quick_success,
    deep_success: row.deep_success,
  }));
}

const outPath = 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/nim_latency_six_actual.json';
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log('\nWROTE', outPath);
