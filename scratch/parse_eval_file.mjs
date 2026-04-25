import fs from 'fs';
const files = [
  'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/eval_quick_nvidia_llama-3.3-nemotron-super-49b-v1.txt',
  'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/eval_deep_nvidia_llama-3.3-nemotron-super-49b-v1.txt',
  'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/eval_quick_nvidia_llama-3.3-nemotron-super-49b-v1.5.txt',
  'C:/projects/TLDR Shield [Too Long, Didn\'t Read]/2. TLDR/scratch/eval_deep_nvidia_llama-3.3-nemotron-super-49b-v1.5.txt',
];
function extract(raw){
  let depth=0,start=-1;
  for(let i=0;i<raw.length;i++){
    if(raw[i]==='{'){ if(depth===0) start=i; depth++; }
    else if(raw[i]==='}'){
      depth--; if(depth===0 && start!==-1){
        const s=raw.slice(start,i+1);
        try{ const o=JSON.parse(s); if(o?.tier&&o?.accuracy) return o; }catch{}
        start=-1;
      }
    }
  }
  return null;
}
for (const f of files){
  const raw = fs.existsSync(f) ? fs.readFileSync(f,'utf8') : '';
  const o = extract(raw);
  console.log('\nFILE:', f.split('/').pop());
  if(!o){ console.log('NO_PARSED_JSON'); continue; }
  const errs = o.perCase?.filter?.(c=>c.error)?.length ?? 0;
  console.log(JSON.stringify({tier:o.tier, ratingPct:o.accuracy.ratingPct, pillarsPct:o.accuracy.pillarsPct, p50:o.latencyMs.p50, p90:o.latencyMs.p90, parseFails:o.parseFails, errors:errs}, null, 2));
}
