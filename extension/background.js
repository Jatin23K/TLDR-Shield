// ── TLDR Shield – Background Service Worker ──

const DEFAULT_API_URL = 'https://ais-dev-7hajrqzemtlrs4e54xvhfc-762479635980.asia-southeast1.run.app/api/analyze';

// FIX #3: MV3 service workers are killed after ~30s of inactivity.
// A deep scan can take 25-40s. We keep the worker alive by opening a port
// to the content script — Chrome does not terminate workers with open ports.
// The port is opened at the start of a scan and disconnected on completion.
const activePorts = new Map(); // tabId → port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  const tabId = port.sender?.tab?.id;
  if (tabId) activePorts.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (tabId) activePorts.delete(tabId);
  });
});

// ── PDF extraction via offscreen document ─────────────────────────────────
// chrome.offscreen is MV3 — creates a hidden document that can use ESM + pdf.js
// without the CSP restrictions that apply to content scripts.

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  }).catch(() => []);
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url:    'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Extract text from PDF Terms & Conditions pages',
  });
}

async function extractPdfAndAnalyze(pdfUrl, tabId) {
  try {
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ type: 'EXTRACT_PDF', url: pdfUrl, tabId });
  } catch (err) {
    chrome.tabs.sendMessage(tabId, {
      type: 'ANALYSIS_RESULT',
      error: 'Could not read PDF: ' + (err?.message ?? err),
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // PDF text extracted by offscreen.js — forward to analysis
  if (message.type === 'PDF_TEXT') {
    analyzeText(message.text, message.tabId, true /* forceDeep — PDFs are always large */, 'deep');
    return;
  }
  if (message.type === 'PDF_ERROR') {
    if (message.tabId) {
      chrome.tabs.sendMessage(message.tabId, {
        type: 'ANALYSIS_RESULT',
        error: 'PDF extraction failed: ' + message.error,
      });
    }
    return;
  }
  if (message.type === 'ANALYZE_TEXT') {
    analyzeText(message.text, sender.tab?.id, message.forceDeep ?? false, message.tier ?? null);
  }
  // PDF page detected by content script — route through offscreen
  if (message.type === 'ANALYZE_PDF') {
    extractPdfAndAnalyze(message.url, sender.tab?.id);
  }
  // Auth token storage — sent by content.js after web app sign-in
  if (message.type === 'STORE_AUTH') {
    chrome.storage.local.set({
      authToken:       message.token,
      authUid:         message.uid,
      authEmail:       message.email,
      // Firebase ID tokens expire after 1 hour; store expiry so we know when to prompt re-login
      authTokenExpiry: Date.now() + 55 * 60 * 1000,
    });
  }
  if (message.type === 'CLEAR_AUTH') {
    chrome.storage.local.remove(['authToken', 'authUid', 'authEmail', 'authTokenExpiry']);
  }
  // Allow popup to read auth state
  if (message.type === 'GET_AUTH') {
    chrome.storage.local.get(
      ['authEmail', 'authUid', 'authTokenExpiry'],
      (data) => {
        const valid = data.authEmail && data.authTokenExpiry > Date.now();
        sender.tab
          ? chrome.tabs.sendMessage(sender.tab.id, { type: 'AUTH_STATE', ...data, valid })
          : chrome.runtime.sendMessage({ type: 'AUTH_STATE', ...data, valid });
      }
    );
    return true;
  }
  // Allow popup to ping for status
  if (message.type === 'PING') return true;
});

async function analyzeText(text, tabId, forceDeep = false, tierOverride = null) {
  if (!tabId) return;

  // FIX #3: Keep the service worker alive for the duration of the scan.
  // Content script opens a 'keepalive' port before sending ANALYZE_TEXT;
  // we disconnect it here when the analysis is done.
  let keepAliveInterval = null;
  try {
    // Ping ourselves every 20s via chrome.runtime to prevent idle termination
    keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } catch (_) {}

  try {
    const { apiUrl, eli5Mode, darkPatterns } = await chrome.storage.local.get({
      apiUrl: DEFAULT_API_URL,
      eli5Mode: true,
      darkPatterns: true,
    });

    const url = apiUrl || DEFAULT_API_URL;

    // Tier selection:
    //   tierOverride     → user explicitly chose quick/deep in popup
    //   forceDeep=true   → user clicked "Run Deep Scan" from quick result panel
    //   text > 30k       → auto-promote to deep for large documents
    //   otherwise        → quick
    const autoTier = tierOverride ?? (forceDeep || text.length > 30000 ? 'deep' : 'quick');

    // Read stored auth token (set when user signs in on the TLDR Shield web app)
    const { authToken, authTokenExpiry } = await chrome.storage.local.get(['authToken', 'authTokenExpiry']);
    const validToken = authToken && authTokenExpiry > Date.now() ? authToken : null;

    // Allow up to 90s for multi-block parallel analysis
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(validToken ? { 'Authorization': `Bearer ${validToken}` } : {}),
        },
        body: JSON.stringify({
          text:         text,
          tier:         autoTier,
          eli5:         eli5Mode,
          darkPatterns: darkPatterns,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Handle auth errors before trying to parse SSE stream
    if (response.status === 401) {
      chrome.tabs.sendMessage(tabId, {
        type: 'ANALYSIS_RESULT',
        error: 'Sign in required. Open TLDR Shield and sign in with Google to start scanning.',
      });
      return;
    }
    if (response.status === 402) {
      let resetDate = 'the 1st of next month';
      let creditsLeft = 0;
      try {
        const d = await response.json();
        if (d.resetDate) resetDate = d.resetDate;
        if (typeof d.creditsLeft === 'number') creditsLeft = d.creditsLeft;
      } catch (_) {}
      chrome.storage.local.set({ authCredits: 0 });
      chrome.tabs.sendMessage(tabId, { type: 'OUT_OF_CREDITS', resetDate, creditsLeft });
      return;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('No response body');

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   result  = null;
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.rating) {
            result = data;
          } else if (data.status) {
            // Forward progress steps to content script so user sees activity
            chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_PROGRESS', status: data.status }).catch(() => {});
          }
        } catch (_) { /* partial chunk, ignore */ }
      }
    }

    if (result) {
      // Persist updated credit balance so popup shows it immediately
      if (typeof result.creditsLeft === 'number') {
        chrome.storage.local.set({ authCredits: result.creditsLeft });
      }
      chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', data: result });
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: 'No result returned' });
    }

  } catch (error) {
    console.error('[TLDR Shield] Analysis Error:', error);
    const userMessage = error.name === 'AbortError'
      ? 'Analysis timed out. Try again on a shorter page.'
      : 'Analysis failed. Check your connection.';
    chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: userMessage });
  } finally {
    // FIX #3: Stop the keepalive ping regardless of success or failure
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  }
}
