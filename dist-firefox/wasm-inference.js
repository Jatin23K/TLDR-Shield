// TLDR Shield — WASM Inference (runs in offscreen document)
const LOCAL_MAX_CHARS = 5000;
let worker = null;
let modelReady = false;
let modelLoading = false;
let msgId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL('wasm-worker.js'));
  worker.onmessage = ({ data }) => {
    const { id, type, result, error, message } = data;
    if (type === 'PROGRESS') {
      chrome.runtime.sendMessage({ type: 'WASM_PROGRESS', message }).catch(() => {});
      return;
    }
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    if (type === 'RESULT')  cb(null, result);
    else if (type === 'LOADED') cb(null, 'ready');
    else if (type === 'LOADING') cb(null, 'loading');
    else cb(new Error(error ?? 'Unknown'), null);
  };
  return worker;
}

function post(msg) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (err, val) => err ? rej(err) : res(val));
    getWorker().postMessage({ ...msg, id });
  });
}

async function loadLocalModel() {
  if (modelReady || modelLoading) return;
  modelLoading = true;
  try { await post({ type: 'LOAD' }); modelReady = true; }
  catch { modelReady = false; }
  finally { modelLoading = false; }
}

async function inferLocal(text) {
  if (!text || text.length > LOCAL_MAX_CHARS || !modelReady) return null;
  return post({ type: 'INFER', text }).catch(() => null);
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WASM_LOAD') {
    loadLocalModel().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'WASM_INFER') {
    inferLocal(msg.text)
      .then(result => sendResponse({ result }))
      .catch(() => sendResponse({ result: null }));
    return true;
  }
});
