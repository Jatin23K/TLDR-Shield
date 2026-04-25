// TLDR Shield — WASM Inference Worker
// Model: Xenova/bert-base-multilingual-uncased-sentiment (~170MB, cached after first load)
// Loaded via @huggingface/transformers from CDN.

const MODEL_ID = 'Xenova/bert-base-multilingual-uncased-sentiment';
let pipeline = null;
let loading = false;

self.onmessage = async (e) => {
  const { id, type, text } = e.data;

  if (type === 'LOAD') {
    if (pipeline) { self.postMessage({ id, type: 'LOADED' }); return; }
    if (loading)  { self.postMessage({ id, type: 'LOADING' }); return; }
    loading = true;
    try {
      const { pipeline: mk, env } = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'
      );
      env.allowLocalModels = false;
      self.postMessage({ id, type: 'PROGRESS', message: 'Downloading model (~170MB)…' });
      pipeline = await mk('text-classification', MODEL_ID, {
        progress_callback: (p) => {
          if (p.status === 'progress')
            self.postMessage({ id, type: 'PROGRESS', message: `Loading: ${Math.round(p.progress)}%` });
        },
      });
      loading = false;
      self.postMessage({ id, type: 'LOADED' });
    } catch (err) {
      loading = false;
      self.postMessage({ id, type: 'ERROR', error: String(err.message) });
    }
    return;
  }

  if (type === 'INFER') {
    if (!pipeline) { self.postMessage({ id, type: 'ERROR', error: 'Model not loaded' }); return; }
    try {
      const chunks = [];
      for (let i = 0; i < Math.min(text.length, 5000); i += 512)
        chunks.push(text.slice(i, i + 512));
      const results = await Promise.all(chunks.map(c => pipeline(c)));
      // Model returns labels "1 star"–"5 stars"; parse the star count from each result.
      let totalStars = 0;
      results.forEach(r => {
        const label = Array.isArray(r) ? r[0].label : r.label;
        const stars = parseInt(label, 10) || 3; // fallback to 3 if parse fails
        totalStars += stars;
      });
      const avgStars = totalStars / results.length;
      const score = Math.min(100, Math.max(0, Math.round(avgStars * 20)));
      let rating;
      if      (avgStars <= 2) rating = 'RISKY';
      else if (avgStars <= 3) rating = 'OKAY';
      else                    rating = 'SAFE';
      self.postMessage({
        id, type: 'RESULT',
        result: { rating, score, tldr: `Local AI: avg sentiment ${avgStars.toFixed(1)}/5 stars across ${results.length} segment(s).`, local: true, pillars: null },
      });
    } catch (err) {
      self.postMessage({ id, type: 'ERROR', error: String(err.message) });
    }
  }
};
