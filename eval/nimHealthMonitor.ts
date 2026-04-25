// Run with: npx tsx eval/nimHealthMonitor.ts
// Output: JSON report to stdout + exit 1 if any key is unhealthy

import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();

interface KeyHealth {
  keyIndex: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface HealthReport {
  timestamp: string;
  healthy: number;
  total: number;
  keys: KeyHealth[];
  allHealthy: boolean;
}

async function checkKey(keyIndex: number, apiKey: string): Promise<KeyHealth> {
  const start = Date.now();
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    timeout: 10000,
  });
  try {
    await client.chat.completions.create({
      model: (process.env.NIM_MODEL_QUICK ?? 'meta/llama-3.3-70b-instruct').trim(),
      messages: [{ role: 'user', content: 'Reply with the single word: healthy' }],
      max_tokens: 5,
    });
    return { keyIndex, ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return {
      keyIndex,
      ok: false,
      latencyMs: Date.now() - start,
      error: err?.status ? `HTTP ${err.status}: ${err?.error?.message ?? err.message}` : String(err?.message ?? err),
    };
  }
}

async function main() {
  const keys: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const k = process.env[`NIM_API_KEY_${i}`];
    if (k) keys.push(k.trim());
  }

  if (keys.length === 0) {
    console.error('No NIM_API_KEY_1/2/3 found in environment');
    process.exit(2);
  }

  const results = await Promise.all(keys.map((k, i) => checkKey(i + 1, k)));

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    healthy: results.filter(r => r.ok).length,
    total: results.length,
    keys: results,
    allHealthy: results.every(r => r.ok),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allHealthy ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
