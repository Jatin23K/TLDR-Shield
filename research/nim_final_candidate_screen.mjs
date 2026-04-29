import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config({ path: 'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/.env', quiet: true });
const keys=[process.env.NIM_API_KEY_1,process.env.NIM_API_KEY_2,process.env.NIM_API_KEY_3].filter(Boolean);
let i=0;
const models=['moonshotai/kimi-k2-instruct-0905','stockmark/stockmark-2-100b-instruct','deepseek-ai/deepseek-v3.1-terminus'];
const baseURL='https://integrate.api.nvidia.com/v1';
const quickUser='Return strict JSON only: {"rating":"SAFE|OKAY|RISKY","score":0-100,"tldr":"..."}. Text: we do not sell data, delete in 30 days.';
const deepUser='Return strict JSON only with pillars and citations. Text: '+('We may share data with advertisers, retain indefinitely, require arbitration, waive class action, and use content to train AI under a broad sublicensable license. '.repeat(28));
function parse(s){const a=s.indexOf('{'),b=s.lastIndexOf('}'); if(a<0||b<0) return false; try{JSON.parse(s.slice(a,b+1));return true;}catch{return false;}}
async function run(model,tier){
  const c = new OpenAI({apiKey:keys[i%keys.length],baseURL}); i++;
  const ctl=new AbortController(); const t=Date.now();
  const to=setTimeout(()=>ctl.abort(),tier==='quick'?30000:70000);
  try{
    const r=await c.chat.completions.create({model,temperature:0.2,max_tokens:tier==='quick'?120:1400,messages:[{role:'system',content:'Output strict JSON only.'},{role:'user',content:tier==='quick'?quickUser:deepUser}]},{signal:ctl.signal});
    const txt=r.choices?.[0]?.message?.content ?? '';
    return {ok:true,ms:Date.now()-t,json_ok:parse(txt)};
  }catch(e){return {ok:false,ms:Date.now()-t,status:e?.status||0,err:e?.message||String(e)};} finally{clearTimeout(to)}
}
for(const m of models){console.log(JSON.stringify({model:m,quick:await run(m,'quick'),deep:await run(m,'deep')}));}
