// ── TLDR Shield – Side Panel Script ──

// ── DOM references ─────────────────────────────────────────────────────────
const panelLoading     = document.getElementById('panel-loading');
const panelEmpty       = document.getElementById('panel-empty');
const panelResult      = document.getElementById('panel-result');
const panelError       = document.getElementById('panel-error');
const loadingStatusTxt = document.getElementById('loading-status-text');
const ratingBanner     = document.getElementById('rating-banner');
const ratingLabel      = document.getElementById('rating-label');
const ratingScore      = document.getElementById('rating-score');
const resultUrl        = document.getElementById('result-url');
const tierPill         = document.getElementById('tier-pill');
const tldrText         = document.getElementById('tldr-text');
const pillarsSection   = document.getElementById('pillars-section');
const pillarsList      = document.getElementById('pillars-list');
const scanAgainBtn     = document.getElementById('scan-again-btn');
const panelErrorMsg    = document.getElementById('panel-error-msg');
const retryBtn         = document.getElementById('retry-btn');
const signinPrompt     = document.getElementById('panel-signin-prompt');
const signinBtn        = document.getElementById('panel-signin-btn');

// ── State ───────────────────────────────────────────────────────────────────
let lastResult = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function hideAll() {
  panelLoading.style.display = 'none';
  panelEmpty.style.display   = 'none';
  panelResult.style.display  = 'none';
  panelError.style.display   = 'none';
}

// ── showLoading ─────────────────────────────────────────────────────────────
function showLoading(status) {
  hideAll();
  panelLoading.style.display = 'block';
  if (loadingStatusTxt) {
    loadingStatusTxt.textContent = status || '';
  }
}

// ── showResult ──────────────────────────────────────────────────────────────
const PILLAR_LABELS = {
  ai_training:       'AI Training',
  data_selling:      'Data Selling',
  transparency:      'Transparency',
  data_retention:    'Data Retention',
  content_ownership: 'Content Ownership',
  dark_patterns:     'Dark Patterns',
};

function showResult(data) {
  if (!data) return;
  lastResult = data;
  hideAll();

  // Rating banner
  const rating = (data.rating || 'OKAY').toUpperCase();
  const score  = typeof data.score === 'number' ? data.score : '–';

  ratingBanner.className = 'rating-banner';
  if (rating === 'SAFE')  ratingBanner.classList.add('safe');
  else if (rating === 'RISKY') ratingBanner.classList.add('risky');
  else ratingBanner.classList.add('okay');

  ratingLabel.textContent = rating;
  ratingScore.textContent = String(score);

  // URL
  const rawUrl = data.url || '';
  resultUrl.textContent = rawUrl.length > 60 ? rawUrl.slice(0, 57) + '...' : rawUrl;
  resultUrl.title = rawUrl;

  // TLDR
  tldrText.textContent = data.tldr || '';

  // Tier pill
  const tier = data.tier || 'quick';
  tierPill.textContent = tier === 'deep' ? '\uD83D\uDD2C Deep' : '\u26A1 Quick';

  // Pillars (deep only)
  if (data.pillars && typeof data.pillars === 'object') {
    pillarsList.textContent = ''; // clear safely
    const pillarKeys = Object.keys(PILLAR_LABELS);
    pillarKeys.forEach((key) => {
      const violated = data.pillars[key] === true;
      const row = document.createElement('div');
      row.className = 'pillar-row';

      const top = document.createElement('div');
      top.className = 'pillar-top';

      const dot = document.createElement('span');
      dot.className = 'pillar-dot ' + (violated ? 'violation' : 'clear');

      const name = document.createElement('span');
      name.className = 'pillar-name';
      name.textContent = PILLAR_LABELS[key] || key;

      top.appendChild(dot);
      top.appendChild(name);
      row.appendChild(top);

      if (violated && data.citations && data.citations[key]) {
        const citation = document.createElement('p');
        citation.className = 'pillar-citation';
        citation.textContent = data.citations[key];
        row.appendChild(citation);
      }

      pillarsList.appendChild(row);
    });
    pillarsSection.style.display = 'block';
  } else {
    pillarsSection.style.display = 'none';
  }

  panelResult.style.display = 'flex';
}

// ── showError ───────────────────────────────────────────────────────────────
function showError(msg) {
  hideAll();
  panelErrorMsg.textContent = msg || 'An error occurred.';
  panelError.style.display = 'flex';
}

// ── showEmpty ───────────────────────────────────────────────────────────────
function showEmpty() {
  hideAll();
  panelEmpty.style.display = 'flex';
}

// ── Message listener ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ANALYSIS_RESULT') {
    if (message.error) {
      showError(message.error);
    } else if (message.data) {
      showResult(message.data);
    }
  }
  if (message.type === 'ANALYSIS_PROGRESS') {
    showLoading(message.status);
  }
  if (message.type === 'OUT_OF_CREDITS') {
    showError('No credits remaining. Resets on the 1st of next month.');
  }
});

// ── Go to Tab button ────────────────────────────────────────────────────────
// window.close() has no effect in a Chrome side panel (panels can only be closed
// by the user or via chrome.sidePanel.close which requires Chrome 126+).
// We just focus the active tab so the user can trigger a new scan from the page.
scanAgainBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.update(tabs[0].id, { active: true });
  });
});

// ── Retry button ─────────────────────────────────────────────────────────────
retryBtn.addEventListener('click', () => {
  showEmpty();
});

// ── Sign-in button ───────────────────────────────────────────────────────────
signinBtn.addEventListener('click', () => {
  chrome.storage.local.get({ apiUrl: 'https://tldr-shield-production.up.railway.app/api/analyze' }, ({ apiUrl }) => {
    const dashUrl = (apiUrl || '').replace(/\/api\/analyze$/, '');
    if (dashUrl) chrome.tabs.create({ url: dashUrl });
  });
});

// ── On load: check auth, then request last result ───────────────────────────
function init() {
  showEmpty();

  // Check auth state
  chrome.runtime.sendMessage({ type: 'GET_AUTH' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.valid === false) {
      signinPrompt.style.display = 'block';
    } else {
      signinPrompt.style.display = 'none';
    }
  });

  // Request the last cached scan result from background.js
  chrome.runtime.sendMessage({ type: 'GET_LAST_RESULT' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.data) {
      showResult(response.data);
    }
  });
}

init();
