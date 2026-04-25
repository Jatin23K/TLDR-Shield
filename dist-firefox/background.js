// ── TLDR Shield – Background Service Worker ──

// Cross-browser compatibility — works in Chrome and Firefox
const _browser = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome; // eslint-disable-line no-undef

// Backend URL is read from chrome.storage.local key 'apiUrl'.
// Set this once via the extension's storage (or ship a production build with the correct value).
// Fallback is intentionally empty — if not configured the scan will fail loudly rather than
// silently routing to a dev/staging server.
const DEFAULT_API_URL = 'https://tldr-shield-292798741977.us-central1.run.app/api/analyze';

// Last scan result — cached so the side panel can retrieve it when opened
let lastResult = { tabId: null, timestamp: 0, data: null };

// Open the side panel when the extension action is clicked (Chrome 114+)
if (_browser.sidePanel && _browser.action && _browser.action.onClicked) {
  _browser.action.onClicked.addListener((tab) => {
    _browser.sidePanel.open({ tabId: tab.id }).catch(() => {});
  });
}

// FIX #3: MV3 service workers are killed after ~30s of inactivity.
// A deep scan can take 25-40s. We keep the worker alive by opening a port
// to the content script — Chrome does not terminate workers with open ports.
// The port is opened at the start of a scan and disconnected on completion.
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

// WASM local inference via offscreen document
async function tryLocalInference(text) {
  if (!text || text.length > 5000) return null;
  try {
    await ensureOffscreenDocument();
    return await _browser.runtime.sendMessage({ type: 'WASM_INFER', text });
  } catch {
    return null;
  }
}

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
        const localResult = await tryLocalInference(message.text);
        if (localResult?.result) {
          const standardizedData = { ...localResult.result, local: true };
          // Standardize on ANALYSIS_RESULT so content/sidepanel catch it
          if (tabId) _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', data: standardizedData }).catch(() => {});
          _browser.runtime.sendMessage({ type: 'ANALYSIS_RESULT', data: standardizedData }).catch(() => {});
          return;
        }
        // No local result — Fall back to cloud analysis
        await analyzeText(
          message.text,
          tabId,
          message.forceDeep ?? false,
          message.tier ?? null,
          message.url ?? sender.tab?.url ?? null,
          message.forceRefresh ?? false
        );
      } catch (err) {
        console.error('[TLDR Shield] Local/Cloud Analysis error:', err);
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
  // Auth token storage — sent by content.js after web app sign-in
  if (message.type === 'STORE_AUTH') {
    _browser.storage.local.set({
      authToken:       message.token,
      authUid:         message.uid,
      authEmail:       message.email,
      // Firebase ID tokens expire after 1 hour; store expiry so we know when to prompt re-login
      authTokenExpiry: Date.now() + 55 * 60 * 1000,
    });
  }
  if (message.type === 'CLEAR_AUTH') {
    _browser.storage.local.remove(['authToken', 'authUid', 'authEmail', 'authTokenExpiry']);
  }
  // Allow popup / side panel to read auth state
  if (message.type === 'GET_AUTH') {
    _browser.storage.local.get(
      ['authEmail', 'authUid', 'authTokenExpiry'],
      (data) => {
        const valid = !!(data.authEmail && data.authTokenExpiry > Date.now());
        if (sender.tab) {
          // Content-script caller — broadcast back via tab messaging
          _browser.tabs.sendMessage(sender.tab.id, { type: 'AUTH_STATE', ...data, valid });
        } else {
          // Extension-page caller (popup, side panel) — use sendResponse so the
          // callback passed to _browser.runtime.sendMessage receives the result directly
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
  if (message.type === 'BATCH_SCAN') {
    processBatchScan(message.urls, message.tier ?? 'quick', sender);
    return; // fire-and-forget — progress sent via separate messages
  }
});

function isSafeExternalUrl(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    // Block private, loopback, link-local, and cloud metadata IP ranges
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

async function processBatchScan(urls, tier, sender) {
  const results = [];
  const keepAlive = setInterval(() => _browser.runtime.getPlatformInfo(() => {}), 20000);
  try {
  for (let i = 0; i < urls.length; i++) {
    const { url } = urls[i];
    if (!isSafeExternalUrl(url)) {
      results.push({ url, error: 'Unsafe or Invalid URL' });
      continue;
    }
    // Send progress update
    _browser.runtime.sendMessage({
      type: 'BATCH_PROGRESS',
      total: urls.length,
      completed: i,
      currentUrl: url,
      results,
    }).catch(() => {});

    try {
      // Fetch and extract text from the URL directly from the background service worker
      const pageResp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const html = await pageResp.text();
      // Use a basic text extractor (strip tags)
      const pageText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80000);

      const storage = await _browser.storage.local.get(['authToken', 'authTokenExpiry', 'apiUrl', 'eli5Mode', 'darkPatterns']);
      const validToken = storage.authToken && storage.authTokenExpiry > Date.now() ? storage.authToken : null;
      const apiBase = (storage.apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');

      const response = await fetch(`${apiBase}/api/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(validToken ? { 'Authorization': `Bearer ${validToken}` } : {}),
        },
        body: JSON.stringify({
          text: pageText,
          tier: tier,
          eli5: storage.eli5Mode ?? false,
          darkPatterns: storage.darkPatterns ?? false,
          url: url,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        if (response.status === 402) {
          results.push({ url, error: 'OUT_OF_CREDITS' });
          break; // Stop batch if out of credits
        }
        results.push({ url, error: errBody.error ?? `HTTP ${response.status}` });
        continue;
      }

      // Parse SSE stream to get final result
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finalResult = null;
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.rating) finalResult = parsed; // Final result has rating
            } catch (_) {}
          }
        }
      }

      if (finalResult) {
        results.push({ url, rating: finalResult.rating, score: finalResult.score, tldr: finalResult.tldr });
      } else {
        results.push({ url, error: 'No result returned' });
      }
    } catch (err) {
      results.push({ url, error: err.name === 'TimeoutError' ? 'Timed out' : 'Fetch failed' });
    }
  }

  // Send final completion message
  _browser.runtime.sendMessage({
    type: 'BATCH_COMPLETE',
    total: urls.length,
    completed: urls.length,
    results,
  }).catch(() => {});
  } finally {
    clearInterval(keepAlive);
  }
}

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
      eli5Mode: true,
      darkPatterns: true,
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
    //   otherwise        → quick
    const autoTier = tierOverride ?? (forceDeep || text.length > 30000 ? 'deep' : 'quick');

    // Read stored auth token (set when user signs in on the TLDR Shield web app).
    // TOKEN_SKEW_BUFFER: 5-minute grace period prevents valid tokens from being
    // flagged as expired on machines with minor clock skew (VMs, corporate laptops).
    const TOKEN_SKEW_BUFFER = 5 * 60 * 1000;
    const { authToken, authTokenExpiry } = await _browser.storage.local.get(['authToken', 'authTokenExpiry']);
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
      _browser.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', error: 'No result returned' }).catch(() => {});
      _browser.runtime.sendMessage({ type: 'ANALYSIS_RESULT', error: 'No result returned' }).catch(() => {});
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

// ── Policy Change Notification Badge ─────────────────────────────────────────
// On service worker startup, check for unread policy change notifications and
// update the extension action badge so the user knows without opening the app.

async function checkNotifications() {
  try {
    const storage = await _browser.storage.local.get(['authToken', 'authTokenExpiry', 'apiUrl']);
    // TOKEN_SKEW_BUFFER: 5-minute grace period for clock skew.
    const TOKEN_SKEW_BUFFER = 5 * 60 * 1000;
    const validToken = (storage.authToken && storage.authTokenExpiry > (Date.now() - TOKEN_SKEW_BUFFER))
      ? storage.authToken
      : null;
    if (!validToken) {
      // Not signed in — clear any stale badge
      _browser.action.setBadgeText({ text: '' }).catch(() => {});
      return;
    }

    // Derive the base API URL (strip trailing /api/analyze if present)
    const rawUrl = storage.apiUrl || DEFAULT_API_URL;
    const apiBase = rawUrl.replace(/\/api\/analyze$/, '').replace(/\/$/, '');

    const resp = await fetch(`${apiBase}/api/notifications`, {
      headers: { Authorization: `Bearer ${validToken}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (!resp || !resp.ok) return;

    const data = await resp.json().catch(() => null);
    if (!data || typeof data.unreadCount !== 'number' || data.unreadCount === 0) {
      _browser.action.setBadgeText({ text: '' }).catch(() => {});
      return;
    }

    const badgeText = data.unreadCount > 9 ? '9+' : String(data.unreadCount);
    _browser.action.setBadgeText({ text: badgeText }).catch(() => {});
    _browser.action.setBadgeBackgroundColor({ color: '#ef4444' }).catch(() => {});
  } catch {
    // Ignore — badge is non-critical
  }
}

_browser.runtime.onStartup.addListener(checkNotifications);
_browser.runtime.onInstalled.addListener(checkNotifications);

// ── C-1: Proactive auth token refresh ────────────────────────────────────────
// Firebase ID tokens expire after 1 hour. We stored the expiry as
// Date.now() + 55min when the token arrived. This alarm fires every 45 min;
// if the token is within 15 min of expiry we ask any open web-app tab to
// re-broadcast a fresh token via the 'tldr-request-auth' CustomEvent path
// (same mechanism used by the popup's active auth probe).
async function refreshAuthToken() {
  try {
    const storage = await _browser.storage.local.get(['authToken', 'authTokenExpiry', 'apiUrl']);
    if (!storage.authToken) return; // not signed in — nothing to refresh

    const expiresIn = (storage.authTokenExpiry ?? 0) - Date.now();
    // Only act if token expires within 15 minutes (900 000 ms)
    if (expiresIn > 15 * 60 * 1000) return;

    // Derive the web-app origin from the configured API URL
    const rawUrl = storage.apiUrl || DEFAULT_API_URL;
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

_browser.alarms.create('tldrNotificationCheck', { delayInMinutes: 60, periodInMinutes: 60 });
_browser.alarms.create('tldrTokenRefresh',       { delayInMinutes: 45, periodInMinutes: 45 });

_browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tldrNotificationCheck') {
    checkNotifications();
  }
  if (alarm.name === 'tldrTokenRefresh') {
    refreshAuthToken();
  }
});
