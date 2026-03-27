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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'ANALYZE_TEXT') {
    analyzeText(message.text, sender.tab?.id, message.forceDeep ?? false);
  }
  // Allow popup to ping for status
  if (message.type === 'PING') return true;
});

async function analyzeText(text, tabId, forceDeep = false) {
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
    //   forceDeep=true  → user clicked "Run Deep Scan" from quick result panel
    //   text > 30k      → auto-promote to deep for large documents
    //   otherwise       → quick (instant badge)
    const autoTier = forceDeep || text.length > 30000 ? 'deep' : 'quick';

    // Allow up to 90s for multi-block parallel analysis
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          if (data.rating) result = data;
        } catch (_) { /* partial chunk, ignore */ }
      }
    }

    if (result) {
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
