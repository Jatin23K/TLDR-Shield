import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env', quiet: true });
const keys = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean);
if (!keys.length) { console.error('No keys'); process.exit(1); }
let keyIdx = 0;
const baseURL = 'https://integrate.api.nvidia.com/v1';

const candidates = [
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'meta/llama-3.3-70b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'mistralai/mistral-medium-3-instruct',
  'mistralai/mistral-nemotron',
  'deepseek-ai/deepseek-v3.2',
  'qwen/qwen3.5-122b-a10b',
  'moonshotai/kimi-k2.5',
  'stepfun-ai/step-3.5-flash',
];

const quickUser = 'Analyze quickly and return strict JSON: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}. Text: We do not sell personal data. We delete data within 30 days. We do not use data for AI training.';
const clause = 'By using the service, you grant us a worldwide sublicensable royalty-free license for any purpose including training machine learning models. We may share your personal data with advertising partners for commercial purposes. You waive class action rights and agree to binding arbitration. We may retain data indefinitely after account deletion.';
const deepUser = `Analyze this legal text and output strict JSON with 6 pillars and citations. TEXT:\n${(clause + ' ').repeat(35)}`;

async function runOne(model, tier) {
  const quick = tier === 'quick';
  const client = new OpenAI({ apiKey: keys[keyIdx % keys.length], baseURL });
  keyIdx++;
  const start = Date.now();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), quick ? 30000 : 60000);
  try {
    await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: quick ? 120 : 1400,
      messages: [
        { role: 'system', content: quick ? 'Return strict compact JSON only.' : 'Return strict JSON only with citations.' },
        { role: 'user', content: quick ? quickUser : deepUser },
      ],
    }, { signal: ctl.signal });
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, status: e?.status || 0, err: e?.message || String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function median(arr){ const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)] ?? null; }

const out = [];
for (const model of candidates) {
  const quickRuns = [];
  const deepRuns = [];
  for (let i=0;i<2;i++) quickRuns.push(await runOne(model,'quick'));
  for (let i=0;i<2;i++) deepRuns.push(await runOne(model,'deep'));

  const qOk = quickRuns.filter(r=>r.ok).map(r=>r.ms);
  const dOk = deepRuns.filter(r=>r.ok).map(r=>r.ms);
  out.push({
    model,
    quick_ok: qOk.length,
    quick_p50_ms: qOk.length ? median(qOk) : null,
    quick_raw: quickRuns,
    deep_ok: dOk.length,
    deep_p50_ms: dOk.length ? median(dOk) : null,
    deep_raw: deepRuns,
  });
  console.log(JSON.stringify(out[out.length-1]));
}

console.log('\nFINAL_SUMMARY');
for (const r of out) {
  console.log(`${r.model}\tquick_p50=${r.quick_p50_ms}\tdeep_p50=${r.deep_p50_ms}\tquick_ok=${r.quick_ok}/2\tdeep_ok=${r.deep_ok}/2`);
}
