import dotenv from 'dotenv';
import OpenAI from 'openai';

const envPath = 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env';
dotenv.config({ path: envPath, quiet: true });
const keys = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean);
if (!keys.length) {
  console.error('No NIM keys in .env');
  process.exit(1);
}

const all = new Map();
for (let i = 0; i < keys.length; i++) {
  const client = new OpenAI({ apiKey: keys[i], baseURL: 'https://integrate.api.nvidia.com/v1' });
  try {
    const list = await client.models.list();
    const ids = list.data.map(m => m.id).sort();
    console.log(`key${i+1}: ${ids.length} models`);
    for (const id of ids) all.set(id, (all.get(id) || 0) + 1);
  } catch (e) {
    console.error(`key${i+1} failed:`, e?.status || '', e?.message || e);
  }
}

const shared = [...all.entries()].filter(([,count]) => count === keys.length).map(([id]) => id).sort();
const partial = [...all.entries()].filter(([,count]) => count < keys.length).sort((a,b)=>a[0].localeCompare(b[0]));
console.log('\n=== Shared Across All Keys ===');
for (const id of shared) console.log(id);
console.log(`TOTAL_SHARED=${shared.length}`);
console.log('\n=== Partial Access ===');
for (const [id,count] of partial) console.log(`${id} :: ${count}/${keys.length}`);
