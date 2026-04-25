// ── TLDR Shield – Auth Bridge ────────────────────────────────────────────────
// Handles auth token relay between the web app and the Chrome extension.
// Loaded AFTER content.js via manifest.json content_scripts order.
//
// Listens for:
//   - window.postMessage('TLDR_AUTH_TOKEN') → forwards to background.js STORE_AUTH
//   - window.postMessage('TLDR_AUTH_SIGNOUT') → forwards to background.js CLEAR_AUTH
//   - chrome.runtime.onMessage('REQUEST_AUTH_SYNC') → dispatches 'tldr-request-auth' event
//
// No dependencies on other content scripts — fully self-contained.

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const type = e.data?.type;
  if (type !== 'TLDR_AUTH_TOKEN' && type !== 'TLDR_AUTH_SIGNOUT') return;
  
  // Safety check: ensure context is valid before calling chrome.storage or chrome.runtime
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage) return;

  chrome.storage.local.get({ apiUrl: '' }, ({ apiUrl }) => {
    let trustedOrigin = '';
    try {
      const base = (apiUrl || '').replace(/\/api\/analyze$/, '');
      if (base) trustedOrigin = new URL(base).origin;
    } catch {
      trustedOrigin = '';
    }
    
    const allowedOrigins = new Set([
      trustedOrigin,
      'https://tldr-shield-292798741977.us-central1.run.app'
    ]);
    
    if (!allowedOrigins.has(e.origin)) return;

    if (type === 'TLDR_AUTH_TOKEN') {
      chrome.runtime.sendMessage({
        type: 'STORE_AUTH',
        token: e.data.token,
        uid: e.data.uid,
        email: e.data.email,
      });
      return;
    }
    chrome.runtime.sendMessage({ type: 'CLEAR_AUTH' });
  });
});

// ── REQUEST_AUTH_SYNC — popup asks us to prod the web app to re-fire its token ─
chrome.runtime.onMessage.addListener((message) => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  if (message.type !== 'REQUEST_AUTH_SYNC') return;
  try {
    window.dispatchEvent(new CustomEvent('tldr-request-auth'));
  } catch {}
});
