// ── TLDR Shield – Popup Script ──

const DEFAULT_API_URL = 'https://ais-dev-7hajrqzemtlrs4e54xvhfc-762479635980.asia-southeast1.run.app/api/analyze';
const DASHBOARD_URL   = 'https://ais-dev-7hajrqzemtlrs4e54xvhfc-762479635980.asia-southeast1.run.app';

// ── DOM references ──────────────────────────────────────────────────────────
const scanBtn      = document.getElementById('scan-btn');
const statusText   = document.getElementById('status-text');
const statusDot    = document.getElementById('status-dot');
const apiUrlInput  = document.getElementById('api-url-input');
const saveUrlBtn   = document.getElementById('save-url-btn');
const urlSavedMsg  = document.getElementById('url-saved-msg');
const eli5Toggle   = document.getElementById('eli5-toggle');
const eli5Switch   = document.getElementById('eli5-switch');
const dpToggle     = document.getElementById('dp-toggle');
const dpSwitch     = document.getElementById('dp-switch');
const openDashBtn  = document.getElementById('open-dashboard');

// ── State ───────────────────────────────────────────────────────────────────
let eli5Mode    = true;
let darkPatterns = true;

function setStatus(msg, type = 'idle') {
  statusText.textContent = msg;
  statusDot.className = 'status-indicator';
  if (type === 'scanning') statusDot.classList.add('scanning');
  if (type === 'done')     statusDot.classList.add('done');
  if (type === 'error')    statusDot.classList.add('error');
}

function updateToggleUI() {
  eli5Switch.className = 'toggle-switch eli5' + (eli5Mode    ? ' on' : '');
  dpSwitch.className   = 'toggle-switch dp'   + (darkPatterns ? ' on' : '');
}

// ── Load saved settings ─────────────────────────────────────────────────────
chrome.storage.local.get(
  { apiUrl: DEFAULT_API_URL, eli5Mode: true, darkPatterns: true },
  ({ apiUrl, eli5Mode: el, darkPatterns: dp }) => {
    apiUrlInput.value = apiUrl && apiUrl !== DEFAULT_API_URL ? apiUrl : '';
    apiUrlInput.placeholder = DEFAULT_API_URL;
    eli5Mode     = el;
    darkPatterns = dp;
    updateToggleUI();
  }
);

// ── Save URL ─────────────────────────────────────────────────────────────────
saveUrlBtn.addEventListener('click', () => {
  const val = apiUrlInput.value.trim();
  if (val) {
    try { new URL(val); } catch (_) {
      setStatus('Invalid URL — must start with https://', 'error');
      return;
    }
  }
  const urlToSave = val || DEFAULT_API_URL;
  chrome.storage.local.set({ apiUrl: urlToSave }, () => {
    urlSavedMsg.style.display = 'block';
    setTimeout(() => { urlSavedMsg.style.display = 'none'; }, 2000);
  });
});

// ── Toggle ELI5 ──────────────────────────────────────────────────────────────
eli5Toggle.addEventListener('click', () => {
  eli5Mode = !eli5Mode;
  chrome.storage.local.set({ eli5Mode });
  updateToggleUI();
});

// ── Toggle Dark Patterns ──────────────────────────────────────────────────────
dpToggle.addEventListener('click', () => {
  darkPatterns = !darkPatterns;
  chrome.storage.local.set({ darkPatterns });
  updateToggleUI();
});

// ── Scan button ───────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  setStatus('Extracting document…', 'scanning');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      setStatus('No active tab found.', 'error');
      scanBtn.disabled = false;
      return;
    }

    // FIX #9: Ask the content script (Agent 2) to extract text using its smart
    // extraction logic — modal detection, semantic containers, pagination.
    // Falls back to executeScript raw grab if the content script is unreachable
    // (e.g. chrome:// pages, extension pages, PDF viewer).
    let pageText = '';

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_POPUP' });
      pageText = response?.text ?? '';
    } catch (_) {
      // Content script not available on this page — fall back to raw body text
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const SELECTORS = ['main', 'article', '[role="main"]', '.content', '#content'];
            for (const sel of SELECTORS) {
              const el = document.querySelector(sel);
              if (el && (el.innerText?.trim().length ?? 0) > 500) return el.innerText.trim();
            }
            return document.body?.innerText?.trim() ?? '';
          },
        });
        pageText = result ?? '';
      } catch (e) {
        setStatus('Cannot scan this page type.', 'error');
        scanBtn.disabled = false;
        return;
      }
    }

    if (!pageText || pageText.length < 100) {
      setStatus('Page has no readable text.', 'error');
      scanBtn.disabled = false;
      return;
    }

    setStatus('Reasoning through document…', 'scanning');
    chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text: pageText });
    // Re-enable after sending so user can close popup freely
    setTimeout(() => {
      setStatus('Analysis running — check the page for results.', 'scanning');
      scanBtn.disabled = false;
    }, 1500);

  } catch (err) {
    console.error('[TLDR Shield Popup] Error:', err);
    setStatus('Error: ' + err.message, 'error');
    scanBtn.disabled = false;
  }
});

// ── Open dashboard ────────────────────────────────────────────────────────────
openDashBtn.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.get({ apiUrl: DEFAULT_API_URL }, ({ apiUrl }) => {
    // Strip /api/analyze suffix to get the dashboard root
    const dashUrl = (apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
    chrome.tabs.create({ url: dashUrl });
  });
});
