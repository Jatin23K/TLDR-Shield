import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env', quiet: true });
const keys = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean);
if (!keys.length) { console.error('No keys'); process.exit(1); }
let ki = 0;
const baseURL = 'https://integrate.api.nvidia.com/v1';

const models = ['deepseek-ai/deepseek-v3.2', 'deepseek-ai/deepseek-v3.1-terminus'];
const cases = [
  {
    id: 'safe_clear',
    expected: 'SAFE',
    text: 'We do not sell personal data. We do not use your data for AI training. We delete all personal data within 30 days of account deletion. You retain ownership of your content.'
  },
  {
    id: 'risky_multi',
    expected: 'RISKY',
    text: 'You grant us a worldwide sublicensable license for any purpose including AI training. We share your personal data with advertising partners for commercial purposes. We may retain your data indefinitely after account deletion. You waive class actions and agree to binding arbitration.'
  },
  {
    id: 'okay_optout',
    expected: 'OKAY',
    text: 'We share data with marketing partners, but you may opt out at any time in settings. We do not train AI on your content by default. We delete account data within 60 days after deletion.'
  }
];

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function call(model, tier, text) {
  const key = keys[ki % keys.length];
  ki++;
  const client = new OpenAI({ apiKey: key, baseURL });
  const ctl = new AbortController();
  const timeoutMs = tier === 'quick' ? 30000 : 70000;
  const timeout = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: tier === 'quick' ? 180 : 1400,
      messages: [
        { role: 'system', content: tier === 'quick' ? 'Return only JSON: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}' : 'Return only JSON: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"...","pillars":{"ai_training":{"violation":boolean,"citation":"string"},"data_selling":{"violation":boolean,"citation":"string"},"transparency":{"violation":boolean,"citation":"string"},"data_retention":{"violation":boolean,"citation":"string"},"content_ownership":{"violation":boolean,"citation":"string"},"dark_patterns":{"violation":boolean,"citation":"string"}}}' },
        { role: 'user', content: `Analyze this legal text:\n${text}` }
      ]
    }, { signal: ctl.signal });

    const ms = Date.now() - start;
    const content = resp.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(content);
    return { ok: true, ms, parsed, parseOk: !!parsed };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, status: e?.status || 0, err: e?.message || String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

for (const model of models) {
  const summary = { model, quick: { latencies: [], ok: 0, parseOk: 0, ratingOk: 0, total: cases.length }, deep: { latencies: [], ok: 0, parseOk: 0, ratingOk: 0, total: cases.length } };
  for (const c of cases) {
    const q = await call(model, 'quick', c.text);
    if (q.ok) {
      summary.quick.ok++;
      summary.quick.latencies.push(q.ms);
      if (q.parseOk) summary.quick.parseOk++;
      if (q.parsed?.rating === c.expected) summary.quick.ratingOk++;
    }
    const d = await call(model, 'deep', c.text);
    if (d.ok) {
      summary.deep.ok++;
      summary.deep.latencies.push(d.ms);
      if (d.parseOk) summary.deep.parseOk++;
      if (d.parsed?.rating === c.expected) summary.deep.ratingOk++;
    }
  }
  const med = (arr) => arr.length ? [...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null;
  const out = {
    model,
    quick: {
      calls_ok: `${summary.quick.ok}/${summary.quick.total}`,
      p50_ms: med(summary.quick.latencies),
      parse_ok: `${summary.quick.parseOk}/${summary.quick.total}`,
      rating_accuracy_pct: Math.round((summary.quick.ratingOk / summary.quick.total) * 100)
    },
    deep: {
      calls_ok: `${summary.deep.ok}/${summary.deep.total}`,
      p50_ms: med(summary.deep.latencies),
      parse_ok: `${summary.deep.parseOk}/${summary.deep.total}`,
      rating_accuracy_pct: Math.round((summary.deep.ratingOk / summary.deep.total) * 100)
    }
  };
  console.log(JSON.stringify(out, null, 2));
}
