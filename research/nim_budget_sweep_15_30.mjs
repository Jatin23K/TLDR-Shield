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
  'mistralai/mistral-medium-3-instruct',
  'qwen/qwen3-next-80b-a3b-instruct',
  'stockmark/stockmark-2-100b-instruct',
  'moonshotai/kimi-k2-instruct-0905',
  'meta/llama-4-maverick-17b-128e-instruct',
  'meta/llama-3.1-70b-instruct',
  'mistralai/mixtral-8x22b-instruct-v0.1',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'mistralai/mistral-7b-instruct-v0.3',
  'bytedance/seed-oss-36b-instruct',
  'z-ai/glm5',
  'z-ai/glm4.7',
  'nvidia/llama-3.1-nemotron-51b-instruct',
  'stepfun-ai/step-3.5-flash',
];

const quickPrompt = 'Return strict JSON only: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}. Text: We do not sell your personal data. Data deleted in 30 days. No AI training.';
const deepClause = 'By using this service, you grant us a worldwide sublicensable royalty-free license for any purpose including training machine learning models. We may share personal data with advertising and analytics partners for commercial use. You waive class action rights and agree to binding arbitration. We may retain data indefinitely after account deletion.';
const deepPrompt = `Return strict JSON only with pillars and citations. Analyze this legal text:\n${(deepClause + ' ').repeat(38)}`;

function median(values) {
  const s = [...values].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)] ?? null;
}

function parseJsonLike(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try { JSON.parse(text.slice(start, end + 1)); return true; } catch { return false; }
}

async function callModel(model, tier) {
  const client = new OpenAI({ apiKey: keys[keyIdx % keys.length], baseURL });
  keyIdx++;
  const timeoutMs = tier === 'quick' ? 20000 : 35000;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: tier === 'quick' ? 120 : 1400,
      messages: [
        { role: 'system', content: 'You are a legal-policy analyzer. Output strict JSON only.' },
        { role: 'user', content: tier === 'quick' ? quickPrompt : deepPrompt },
      ],
    }, { signal: ctl.signal });

    const content = resp.choices?.[0]?.message?.content ?? '';
    return {
      ok: true,
      ms: Date.now() - start,
      json_ok: parseJsonLike(content),
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - start,
      status: e?.status || 0,
      err: e?.message || String(e),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const results = [];
for (const model of models) {
  const q1 = await callModel(model, 'quick');
  const q2 = await callModel(model, 'quick');
  const d1 = await callModel(model, 'deep');
  const d2 = await callModel(model, 'deep');

  const qOk = [q1, q2].filter(r => r.ok).map(r => r.ms);
  const dOk = [d1, d2].filter(r => r.ok).map(r => r.ms);
  const qJsonOk = [q1, q2].filter(r => r.ok && r.json_ok).length;
  const dJsonOk = [d1, d2].filter(r => r.ok && r.json_ok).length;

  const quickP50 = qOk.length ? median(qOk) : null;
  const deepP50 = dOk.length ? median(dOk) : null;

  const row = {
    model,
    quick_ok: qOk.length,
    quick_json_ok: qJsonOk,
    quick_p50_ms: quickP50,
    deep_ok: dOk.length,
    deep_json_ok: dJsonOk,
    deep_p50_ms: deepP50,
    basic_15s_pass: quickP50 !== null && quickP50 <= 15000,
    deep_30s_pass: deepP50 !== null && deepP50 <= 30000,
    all_raw: { q1, q2, d1, d2 },
  };

  results.push(row);
  console.log(JSON.stringify({
    model: row.model,
    quick_p50_ms: row.quick_p50_ms,
    deep_p50_ms: row.deep_p50_ms,
    basic_15s_pass: row.basic_15s_pass,
    deep_30s_pass: row.deep_30s_pass,
    quick_ok: row.quick_ok,
    deep_ok: row.deep_ok,
    quick_json_ok: row.quick_json_ok,
    deep_json_ok: row.deep_json_ok,
  }));
}

const summary = {
  tested: results.length,
  pass_both: results.filter(r => r.basic_15s_pass && r.deep_30s_pass).map(r => r.model),
  pass_basic_only: results.filter(r => r.basic_15s_pass && !r.deep_30s_pass).map(r => r.model),
  pass_deep_only: results.filter(r => !r.basic_15s_pass && r.deep_30s_pass).map(r => r.model),
  fail_both: results.filter(r => !r.basic_15s_pass && !r.deep_30s_pass).map(r => r.model),
};

const outPath = 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/nim_budget_sweep_15_30.json';
fs.writeFileSync(outPath, JSON.stringify({ results, summary }, null, 2));
console.log('\nSUMMARY');
console.log(JSON.stringify(summary, null, 2));
console.log('\nWROTE', outPath);
