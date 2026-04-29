import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env', quiet: true });
const keys = [process.env.NIM_API_KEY_1, process.env.NIM_API_KEY_2, process.env.NIM_API_KEY_3].filter(Boolean);
let ki=0;
const baseURL='https://integrate.api.nvidia.com/v1';

const models=[
  'qwen/qwen3-next-80b-a3b-instruct',
  'mistralai/mistral-large-2-instruct',
  'meta/llama-3.1-405b-instruct',
  'minimaxai/minimax-m2.7',
];

const quickUser='Return strict JSON only: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}. Text: we do not sell data, we delete in 30 days.';
const deepUser='Return strict JSON only with pillars and citations. Text: '+('We may share personal data with advertisers and retain data indefinitely after deletion. You waive class actions and accept arbitration. You grant us a worldwide sublicensable license for any purpose including AI training. '.repeat(30));

function tryParseJson(s){
  const start=s.indexOf('{'); const end=s.lastIndexOf('}');
  if(start<0||end<0||end<=start) return false;
  try{ JSON.parse(s.slice(start,end+1)); return true; } catch { return false; }
}

async function call(model,tier){
  const client=new OpenAI({apiKey:keys[ki%keys.length],baseURL}); ki++;
  const ctl=new AbortController();
  const t=Date.now();
  const timeout = setTimeout(()=>ctl.abort(), tier==='quick'?30000:90000);
  try{
    const r=await client.chat.completions.create({
      model,
      temperature:0.2,
      max_tokens:tier==='quick'?120:1400,
      messages:[
        {role:'system',content:'Legal policy analyzer. Output strict JSON only.'},
        {role:'user',content:tier==='quick'?quickUser:deepUser}
      ]
    },{signal:ctl.signal});
    const txt=r.choices?.[0]?.message?.content ?? '';
    return {ok:true,ms:Date.now()-t,json_ok:tryParseJson(txt)};
  }catch(e){
    return {ok:false,ms:Date.now()-t,status:e?.status||0,err:e?.message||String(e)};
  }finally{clearTimeout(timeout)}
}

for(const m of models){
  const q=await call(m,'quick');
  const d=await call(m,'deep');
  console.log(JSON.stringify({model:m,quick:q,deep:d}));
}
