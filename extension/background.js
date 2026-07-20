// ── TLDR Shield – Background Service Worker ──

// Cross-browser compatibility — works in Chrome and Firefox
const _browser = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome; // eslint-disable-line no-undef

//   Agent 4 → aggregate + display result    (content.js)
//
// KEEP-ALIVE ARCHITECTURE:
// MV3 service workers are killed after ~30s of inactivity. However, a Gemini 1.5 Pro
// deep scan can take 35-50s (reasoning + grounding). We keep the worker alive by 
// opening a messaging port to the content script; as long as the port is open, 
// Chrome's "idle timer" is suspended.

const DEFAULT_API_URL = 'https://tldr-shield.onrender.com/api/analyze';

// Last scan result — cached so the side panel can retrieve it when opened
let lastResult = { tabId: null, timestamp: 0, data: null };

// Open the side panel when the extension action is clicked (Chrome 114+)
if (_browser.sidePanel && _browser.action && _browser.action.onClicked) {
  _browser.action.onClicked.addListener((tab) => {
    _browser.sidePanel.open({ tabId: tab.id }).catch(() => {});
  });
}
const activePorts = new Map(); // tabId → port

_browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  const tabId = port.sender?.tab?.id;
  if (tabId) activePorts.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (tabId) activePorts.delete(tabId);
  });
});

// Purge stale ports and cache on tab removal to prevent memory leaks
_browser.tabs.onRemoved.addListener((tabId) => {
  if (activePorts.has(tabId)) {
    const port = activePorts.get(tabId);
    try { port.disconnect(); } catch (_) {}
    activePorts.delete(tabId);
  }
  if (lastResult.tabId === tabId) {
    lastResult = { tabId: null, timestamp: 0, data: null };
  }
});

// NOTE: WASM local inference path removed — it was calling ensureOffscreenDocument
// and sending WASM_INFER to a handler that was never implemented in offscreen.js,
// silently returning null on every short-text scan and adding unnecessary latency.

// ── PDF extraction via offscreen document ─────────────────────────────────
// chrome.offscreen is MV3 — creates a hidden document that can use ESM + pdf.js
// without the CSP restrictions that apply to content scripts.

async function ensureOffscreenDocument() {
  const existing = await _browser.offscreen.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [_browser.runtime.getURL('offscreen.html')],
  }).catch(() => []);
  if (existing.length > 0) return;
  await _browser.offscreen.createDocument({
    url:    'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Extract text from PDF Terms & Conditions pages',
  });
}

async function extractPdfAndAnalyze(pdfUrl, tabId) {
  try {
    await ensureOffscreenDocument();
    _browser.runtime.sendMessage({ type: 'EXTRACT_PDF', url: pdfUrl, tabId });
  } catch (err) {
    _browser.tabs.sendMessage(tabId, {
      type: 'ANALYSIS_RESULT',
      error: 'Could not read PDF: ' + (err?.message ?? err),
    });
  }
}

_browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // PDF text extracted by offscreen.js — forward to analysis
  if (message.type === 'PDF_TEXT') {
    analyzeText(message.text, message.tabId, true /* forceDeep — PDFs are always large */, 'deep', message.url ?? null);
    return;
  }
  if (message.type === 'PDF_ERROR') {
    if (message.tabId) {
      _browser.tabs.sendMessage(message.tabId, {
        type: 'ANALYSIS_RESULT',
        error: 'PDF extraction failed: ' + message.error,
      });
    }
    return;
  }
  if (message.type === 'ANALYZE_TEXT') {
    // If message comes from popup, sender.tab is undefined — use message.tabId
    const tabId = message.tabId ?? sender.tab?.id;
    // FIX #3: Service worker messaging must return true for async operations.
    // Try WASM local inference for short texts (free, offline), then fall through to cloud.
    (async () => {
      try {
        // Fall through directly to cloud analysis (WASM path removed — dead code)
        await analyzeText(
          message.text,
          tabId,
          message.forceDeep ?? false,
          message.tier ?? null,
          message.url ?? sender.tab?.url ?? null,
          message.forceRefresh ?? false
        );
      } catch (err) {
        console.error('[TLDR Shield] Cloud Analysis error:', err);
        if (tabId) {
          _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: 'Analysis process failed.' }).catch(() => {});
        }
      }
    })();
    return true; // Keep message channel open for async IIFE
  }
  // PDF page detected by content script — route through offscreen
  if (message.type === 'ANALYZE_PDF') {
    extractPdfAndAnalyze(message.url, sender.tab?.id);
  }
  // Auth token storage — sent by content.js after web app sign-in.
  // Fix #20: Auth tokens are stored in chrome.storage.session (memory-only,
  // cleared on browser close) instead of chrome.storage.local (persisted on disk).
  // The token already expires after 1 hour; session storage matches its real lifetime.
  if (message.type === 'STORE_AUTH') {
    _browser.storage.session.set({
      authToken:       message.token,
      authUid:         message.uid,
      authEmail:       message.email,
      // Firebase ID tokens expire after 1 hour; store expiry so we know when to prompt re-login
      authTokenExpiry: Date.now() + 55 * 60 * 1000,
    });
    // Mirror email to local for popup display (non-sensitive)
    _browser.storage.local.set({ authEmail: message.email });
  }
  if (message.type === 'CLEAR_AUTH') {
    _browser.storage.session.remove(['authToken', 'authUid', 'authEmail', 'authTokenExpiry']);
    _browser.storage.local.remove(['authEmail', 'authCredits']);
  }
  // Allow popup / side panel to read auth state
  if (message.type === 'GET_AUTH') {
    _browser.storage.session.get(
      ['authEmail', 'authUid', 'authTokenExpiry'],
      (data) => {
        const valid = !!(data.authEmail && data.authTokenExpiry > Date.now());
        if (sender.tab) {
          _browser.tabs.sendMessage(sender.tab.id, { type: 'AUTH_STATE', ...data, valid });
        } else {
          sendResponse({ type: 'AUTH_STATE', ...data, valid });
        }
      }
    );
    return true;
  }
  // Side panel requests last cached scan result
  if (message.type === 'GET_LAST_RESULT') {
    sendResponse({ data: lastResult });
    return true;
  }
  // Allow popup to ping for status
  if (message.type === 'PING') return true;
  // BATCH_SCAN — Removed for Portfolio MVP
});

// ── Batch Scan — Removed for Portfolio MVP ──

async function analyzeText(text, tabId, forceDeep = false, tierOverride = null, sourceUrl = null, forceRefresh = false) {
  if (!tabId) return;

  // FIX #3: Keep the service worker alive for the duration of the scan.
  // Content script opens a 'keepalive' port before sending ANALYZE_TEXT;
  // we disconnect it here when the analysis is done.
  let keepAliveInterval = null;
  try {
    // Ping ourselves every 20s via _browser.runtime to prevent idle termination
    keepAliveInterval = setInterval(() => _browser.runtime.getPlatformInfo(() => {}), 20000);
  } catch (_) {}

  try {
    const { apiUrl, eli5Mode, darkPatterns } = await _browser.storage.local.get({
      apiUrl: DEFAULT_API_URL,
      // Defaults match the popup UI initial state (both off).
      // Previously both defaulted to true, causing a split-brain state where
      // users who never opened the popup got ELI5 + dark patterns unexpectedly.
      eli5Mode: false,
      darkPatterns: false, // FIX #4: default off — user must opt-in, not silently lose -40pts
    });

    const url = apiUrl || DEFAULT_API_URL;
    if (!url) {
      _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', result: 'Backend URL is not configured. Set the API URL in extension storage.' });
      return;
    }

    // Tier selection:
    //   tierOverride     → user explicitly chose quick/deep in popup
    //   forceDeep=true   → user clicked "Run Deep Scan" from quick result panel
    //   text > 30k       → auto-promote to deep for large documents
    //   otherwise        → deep (FIX #6: was 'quick', caused most pages to always quick-scan)
    const autoTier = tierOverride ?? (forceDeep || text.length > 30000 ? 'deep' : 'deep');

    // Read stored auth token from session storage (Fix #20).
    // TOKEN_SKEW_BUFFER: 5-minute grace period prevents valid tokens from being
    // flagged as expired on machines with minor clock skew (VMs, corporate laptops).
    const TOKEN_SKEW_BUFFER = 5 * 60 * 1000;
    const { authToken, authTokenExpiry } = await _browser.storage.session.get(['authToken', 'authTokenExpiry']);
    const validToken = authToken && authTokenExpiry > (Date.now() - TOKEN_SKEW_BUFFER) ? authToken : null;

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
          url:          sourceUrl,
          forceRefresh: forceRefresh,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Handle auth errors before trying to parse SSE stream
    if (response.status === 401) {
      _browser.tabs.sendMessage(tabId, {
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
      _browser.storage.local.set({ authCredits: 0 });
      _browser.tabs.sendMessage(tabId, { type: 'OUT_OF_CREDITS', resetDate, creditsLeft }).catch(() => {});
      _browser.runtime.sendMessage({ type: 'OUT_OF_CREDITS', resetDate, creditsLeft }).catch(() => {});
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
          } else if (data.error) {
            // Server-pushed error during stream (e.g. LLM failure, credit error)
            const errPayload = data.requestId ? `${data.error} (ID: ${data.requestId})` : data.error;
            _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: errPayload }).catch(() => {});
            _browser.runtime.sendMessage({ type: 'ANALYSIS_RESULT', error: errPayload }).catch(() => {});
            return; // Exit loop early — error is terminal
          } else if (data.status) {
            // Forward progress steps to content script so user sees activity
            _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_PROGRESS', status: data.status }).catch(() => {});
            // Also forward to side panel (may not be open — ignore errors)
            _browser.runtime.sendMessage({ type: 'ANALYSIS_PROGRESS', status: data.status }).catch(() => {});
          }
        } catch (_) { /* partial chunk, ignore */ }
      }
    }

    if (result) {
      // Persist updated credit balance so popup shows it immediately
      if (typeof result.creditsLeft === 'number') {
        _browser.storage.local.set({ authCredits: result.creditsLeft });
      }
      // Cache result for side panel retrieval
      lastResult = { tabId, timestamp: Date.now(), data: result };
      _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', data: result }).catch(() => {});
      // Also broadcast to side panel (may not be open — ignore errors)
      _browser.runtime.sendMessage({ type: 'ANALYSIS_RESULT', data: result }).catch(() => {});
    } else {
      // FIX: Descriptive error message instead of bare "No result returned"
      const noResultMsg = 'The scan completed but returned no data. The page text may be too short or the server is temporarily unavailable. Please refresh the page and try again.';
      _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: noResultMsg }).catch(() => {});
      _browser.runtime.sendMessage({ type: 'ANALYSIS_RESULT', error: noResultMsg }).catch(() => {});
    }

  } catch (error) {
    console.error('[TLDR Shield] Analysis Error:', error);
    const userMessage = error.name === 'AbortError'
      ? 'Analysis timed out. Try again on a shorter page.'
      : 'Analysis failed. Check your connection.';
    _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: userMessage }).catch(() => {});
  } finally {
    // FIX #3: Stop the keepalive ping regardless of success or failure
    if (keepAliveInterval) clearInterval(keepAliveInterval);
  }
}

// ── Notification Check — Removed for Portfolio MVP ──

_browser.runtime.onStartup.addListener(refreshAuthToken); 
_browser.runtime.onInstalled.addListener(() => {
  console.log('[TLDR Shield] Extension installed/updated.');
});

async function refreshAuthToken() {
  try {
    const storage = await _browser.storage.session.get(['authToken', 'authTokenExpiry']);
    const localStorage = await _browser.storage.local.get(['apiUrl']);
    if (!storage.authToken) return; // not signed in — nothing to refresh

    const expiresIn = (storage.authTokenExpiry ?? 0) - Date.now();
    // Only act if token expires within 15 minutes (900 000 ms)
    if (expiresIn > 15 * 60 * 1000) return;

    // Derive the web-app origin from the configured API URL
    const rawUrl = localStorage.apiUrl || DEFAULT_API_URL;
    const webAppOrigin = rawUrl.replace(/\/api\/analyze$/, '').replace(/\/$/, '');

    // Find any open tab on the web-app origin and ask the content script
    // to dispatch 'tldr-request-auth' so the app re-posts a fresh token.
    const tabs = await _browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && tab.url.startsWith(webAppOrigin)) {
        _browser.tabs.sendMessage(tab.id, { type: 'REQUEST_AUTH_SYNC' }).catch(() => {});
        console.debug('[TLDR Shield] Token refresh ping sent to tab', tab.id);
        break;
      }
    }
  } catch {
    // Non-critical — ignore errors silently
  }
}

_browser.alarms.create('tldrTokenRefresh', { delayInMinutes: 45, periodInMinutes: 45 });
_browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tldrTokenRefresh') refreshAuthToken();
});
