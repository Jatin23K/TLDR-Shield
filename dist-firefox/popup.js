// ── TLDR Shield – Popup Script ──

// Cross-browser compatibility — works in Chrome and Firefox
const _browser = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome; // eslint-disable-line no-undef

// ── Auto-close after 5 seconds ───────────────────────────────────────────────
// Starts when popup opens. Cancelled while scanning. Restarts 5s after result.
let _autoCloseTimer = null;
let _scanInProgress = false;

function startAutoClose(delayMs = 5000) {
  clearTimeout(_autoCloseTimer);
  if (_scanInProgress) return;
  // Animate the countdown bar: shrink from 100% → 0% over delayMs
  const bar = document.getElementById('auto-close-progress');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    // Force reflow so the reset takes effect before starting animation
    void bar.offsetWidth;
    bar.style.transition = `transform ${delayMs}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }
  _autoCloseTimer = setTimeout(() => window.close(), delayMs);
}

function cancelAutoClose() {
  clearTimeout(_autoCloseTimer);
  _autoCloseTimer = null;
  // Freeze bar in place
  const bar = document.getElementById('auto-close-progress');
  if (bar) {
    const computed = getComputedStyle(bar).transform;
    bar.style.transition = 'none';
    bar.style.transform = computed;
  }
}

// ── Update notification check ────────────────────────────────────────────────
// Probe the active tab's content script on popup open.
// If stale (context invalidated after reload), show only the update message.
(function checkForUpdate() {
  _browser.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tabId = tabs[0]?.id;
    if (!tabId) return;

    const timeout = setTimeout(function () { showUpdateNotice(); }, 800);

    _browser.tabs.sendMessage(tabId, { type: 'PING' }, function () {
      clearTimeout(timeout);
      if (_browser.runtime.lastError) showUpdateNotice();
    });
  });

  function showUpdateNotice() {
    // Clear all children safely, then show only the update message
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    document.body.style.cssText = 'width:280px; background:#13141c; padding:16px 20px; display:flex; align-items:center; gap:10px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    const icon = document.createElement('span');
    icon.textContent = '\uD83D\uDEE1\uFE0F';
    icon.style.fontSize = '18px';

    const msg = document.createElement('span');
    msg.textContent = 'TLDR Shield updated \u2014 refresh to apply';
    msg.style.cssText = 'font-size:13px; font-weight:600; color:#dde3ed; line-height:1.4;';

    document.body.appendChild(icon);
    document.body.appendChild(msg);

    // Auto-close after 5 seconds
    setTimeout(function () { window.close(); }, 5000);
  }
})();

// Start the countdown immediately on open (normal popup path)
startAutoClose(5000);

// Any interaction resets the timer — user is actively using the popup
document.addEventListener('mousemove', () => startAutoClose(5000), { passive: true });
document.addEventListener('keydown',   () => startAutoClose(5000), { passive: true });


// Set the production backend URL here before shipping.
// Intentionally empty so misconfigured builds fail loudly rather than routing to a dev server.
const DEFAULT_API_URL = 'https://tldr-shield-292798741977.us-central1.run.app/api/analyze';

// ── DOM references ──────────────────────────────────────────────────────────
const scanBtn          = document.getElementById('scan-btn');
const statusText       = document.getElementById('status-text');
const statusDot        = document.getElementById('status-dot');
const apiUrlInput      = document.getElementById('api-url-input');
const saveUrlBtn       = document.getElementById('save-url-btn');
const urlSavedMsg      = document.getElementById('url-saved-msg');
const eli5Toggle       = document.getElementById('eli5-toggle');
const eli5Switch       = document.getElementById('eli5-switch');
const dpToggle         = document.getElementById('dp-toggle');
const dpSwitch         = document.getElementById('dp-switch');
const openDashBtn      = document.getElementById('open-dashboard');
const authBanner       = document.getElementById('auth-banner');
const userRow          = document.getElementById('user-row');
const userEmail        = document.getElementById('user-email');
const userAvatarInitial = document.getElementById('user-avatar-initial');
const signInBtn        = document.getElementById('signin-btn');
const signOutBtn       = document.getElementById('signout-btn');
const creditsPill      = document.getElementById('credits-pill');
const creditsVal       = document.getElementById('credits-val');
const footerApiUrl     = document.getElementById('footer-api-url');
const resultCard        = document.getElementById('result-card');
const resultHeader      = document.getElementById('result-header');
const resultRatingBadge = document.getElementById('result-rating-badge');
const resultScore       = document.getElementById('result-score');
const resultTldrShort   = document.getElementById('result-tldr-short');
const resultTldrFull    = document.getElementById('result-tldr-full');
const resultTruncated   = document.getElementById('result-truncated');
const scanTypeLabel       = document.getElementById('scan-type-label');
const cacheLabel          = document.getElementById('cache-label');
const resultQuickFlags    = document.getElementById('result-quick-flags');
const resultPillars       = document.getElementById('result-pillars');
const resultAuditFooter   = document.getElementById('result-audit-footer');

// ── Pillar display names ─────────────────────────────────────────────────────
const PILLAR_NAMES = {
  ai_training:       'AI Training',
  data_selling:      'Data Selling',
  transparency:      'Transparency',
  data_retention:    'Data Retention',
  content_ownership: 'Content Rights',
  dark_patterns:     'Dark Patterns',
};

// ── State ───────────────────────────────────────────────────────────────────
let eli5Mode    = true;
let darkPatterns = true;
let selectedTier = 'quick'; // 'quick' | 'deep'

// ── Tier selector ────────────────────────────────────────────────────────────
const tierBtns = document.querySelectorAll('.tier-btn');
tierBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (scanBtn.disabled) return; // don't allow tier change mid-scan
    selectedTier = btn.dataset.tier;
    _browser.storage.local.set({ tier: selectedTier });
    tierBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

function setStatus(msg, type = 'idle') {
  statusText.textContent = msg;
  statusDot.className = 'status-indicator';
  if (type === 'scanning') statusDot.classList.add('scanning');
  if (type === 'done')     statusDot.classList.add('done');
  if (type === 'error')    statusDot.classList.add('error');
}

// ── Time-ago helper ──────────────────────────────────────────────────────────
function timeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 2)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Quick scan flag grid (Fix 2 — violation booleans, no citations) ──────────
function renderQuickFlags(flagged) {
  if (!resultQuickFlags || !flagged || typeof flagged !== 'object') return;

  const KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership', 'dark_patterns'];
  const availableKeys = KEYS.filter(k => flagged[k] !== undefined);
  if (availableKeys.length === 0) { resultQuickFlags.style.display = 'none'; return; }

  while (resultQuickFlags.firstChild) resultQuickFlags.removeChild(resultQuickFlags.firstChild);

  const header = document.createElement('div');
  header.className = 'quick-flags-header';
  header.textContent = 'Pillar Flags';
  resultQuickFlags.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'quick-flags-grid';
  for (const k of availableKeys) {
    const violated = !!flagged[k];
    const item = document.createElement('div');
    item.className = 'quick-flag-item' + (violated ? ' violated' : '');
    const icon = document.createElement('span');
    icon.textContent = violated ? '\uD83D\uDD34' : '\u2705'; // 🔴 / ✅
    icon.style.fontSize = '9px';
    item.appendChild(icon);
    item.appendChild(document.createTextNode('\u00a0' + (PILLAR_NAMES[k] || k)));
    grid.appendChild(item);
  }
  resultQuickFlags.appendChild(grid);
  resultQuickFlags.style.display = 'block';
}

// ── Render pillar breakdown (deep scan only) ────────────────────────────────
function renderPillars(pillars) {
  if (!resultPillars || !pillars || typeof pillars !== 'object') return;

  const KEYS = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership', 'dark_patterns'];
  const availableKeys = KEYS.filter(k => pillars[k] !== undefined);

  if (availableKeys.length === 0) {
    resultPillars.style.display = 'none';
    return;
  }

  // Clear previous content using safe DOM methods (no innerHTML)
  while (resultPillars.firstChild) resultPillars.removeChild(resultPillars.firstChild);

  // Header
  const header = document.createElement('div');
  header.className = 'pillars-header';
  header.textContent = 'Pillar Breakdown';
  resultPillars.appendChild(header);

  for (const k of availableKeys) {
    const p        = pillars[k];
    const violated = !!p?.violation;
    const rawConf  = (p?.confidence || 'medium').toLowerCase();
    let   conf     = ['high', 'medium', 'low'].includes(rawConf) ? rawConf : 'medium';
    // Non-violated pillars are safe — LOW confidence is misleading (absence of
    // violation doesn't need a verbatim citation). Clamp to minimum MEDIUM for
    // cached results that may have been stored before the server-side fix.
    if (!violated && conf === 'low') conf = 'medium';
    const name     = PILLAR_NAMES[k] || k;
    const rawCit   = p?.citation || '';
    const hasCit   = violated && rawCit && rawCit !== 'Not addressed in document.' && rawCit !== '[NOT_FOUND]';

    // Row container
    const row = document.createElement('div');
    row.className = 'pillar-row';

    // Icon
    const icon = document.createElement('span');
    icon.className = 'pillar-icon';
    icon.textContent = violated ? '\uD83D\uDD34' : '\u2705'; // red circle or check mark
    row.appendChild(icon);

    // Body
    const body = document.createElement('div');
    body.className = 'pillar-body';

    // Name row with confidence dot
    const nameEl = document.createElement('span');
    nameEl.className = 'pillar-name';
    const nameText = document.createTextNode(name + '\u00a0'); // non-breaking space before dot
    nameEl.appendChild(nameText);

    const dot = document.createElement('span');
    dot.className = 'conf-dot ' + conf;
    dot.title = conf.charAt(0).toUpperCase() + conf.slice(1) + ' confidence';
    nameEl.appendChild(dot);
    body.appendChild(nameEl);

    // Citation (truncated, violated pillars only)
    if (hasCit) {
      const citEl = document.createElement('div');
      citEl.className = 'pillar-citation';
      const truncated = rawCit.length > 80 ? rawCit.slice(0, 80) + '\u2026' : rawCit;
      citEl.textContent = '\u201c' + truncated + '\u201d'; // curly quotes
      body.appendChild(citEl);
    }

    row.appendChild(body);
    resultPillars.appendChild(row);
  }

  resultPillars.style.display = 'block';
}

// ── Show inline scan result ──────────────────────────────────────────────────
function showResult(data) {
  if (!data || !data.rating) return;

  // Degraded fallback — AI analysis failed. Show a clean retry prompt instead of
  // the misleading deterministic result with "AI analysis unavailable" text.
  if (data.degraded) {
    showError('AI scan could not be completed. Please try again in a moment.');
    return;
  }

  const cls = data.rating.toLowerCase(); // 'safe' | 'okay' | 'risky'
  const isCautious = data.rating === 'OKAY' && typeof data.score === 'number' && data.score < 60;

  // Rating badge + score
  resultRatingBadge.textContent = data.rating;
  if (isCautious) {
    const chip = document.createElement('span');
    chip.className = 'cautious-chip';
    chip.textContent = 'CAUTIOUS';
    resultRatingBadge.appendChild(chip);
  }
  resultRatingBadge.className   = 'result-rating-badge ' + cls;
  resultScore.textContent       = (data.score ?? '–') + '/100';
  resultScore.className         = 'result-score ' + cls;

  // Header background
  resultHeader.className = 'result-header ' + cls;

  // TLDR — first sentence as header, rest as body
  const tldr = data.tldr || '';
  const sentenceEnd = tldr.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd < 80) {
    resultTldrShort.textContent = tldr.slice(0, sentenceEnd + 1);
    resultTldrFull.textContent  = tldr.slice(sentenceEnd + 2);
    resultTldrFull.style.display = resultTldrFull.textContent ? 'block' : 'none';
  } else {
    resultTldrShort.textContent = tldr.length > 90 ? tldr.slice(0, 87) + '…' : tldr;
    resultTldrFull.textContent  = tldr.length > 90 ? tldr : '';
    resultTldrFull.style.display = tldr.length > 90 ? 'block' : 'none';
  }

  // Truncation warning — shown when document exceeded 80k char analysis cap
  if (resultTruncated) {
    if (data.truncated && data.truncatedPercent) {
      resultTruncated.textContent = `⚠️ Document too large — ${data.truncatedPercent}% skipped. Use Deep scan for best coverage.`;
      resultTruncated.style.display = 'flex';
    } else if (data.truncated) {
      resultTruncated.textContent = '⚠️ Document too large — first 80,000 chars analyzed.';
      resultTruncated.style.display = 'flex';
    } else {
      resultTruncated.style.display = 'none';
    }
  }

  // C1/C2: Pillar breakdown (deep scan only)
  if (resultPillars) {
    if (data.pillars !== null &&
        typeof data.pillars === 'object' &&
        !Array.isArray(data.pillars) &&
        Object.keys(data.pillars).length > 0) {
      renderPillars(data.pillars);
    } else {
      resultPillars.style.display = 'none';
    }
  }

  // Fix 2: Quick scan flag grid (pillar violated/safe without citations)
  if (resultQuickFlags) {
    if (data.flagged && typeof data.flagged === 'object' && data.pillars === null) {
      renderQuickFlags(data.flagged);
    } else {
      resultQuickFlags.style.display = 'none';
    }
  }

  // C3: Scan type label
  if (scanTypeLabel) {
    const isDeep = data.pillars !== null &&
                   typeof data.pillars === 'object' &&
                   !Array.isArray(data.pillars) &&
                   Object.keys(data.pillars).length > 0;
    scanTypeLabel.textContent = isDeep ? 'Deep Scan \u00b7 Full analysis' : 'Quick Scan \u00b7 Basic verdict';
    scanTypeLabel.style.display = 'block';
  }

  // Fix 4: Cache age label
  if (cacheLabel) {
    if (data.cached && data.scannedAt) {
      cacheLabel.textContent = 'Cached \u00b7 ' + timeAgo(data.scannedAt);
      cacheLabel.style.display = 'block';
    } else {
      cacheLabel.style.display = 'none';
    }
  }

  // Fix 9: Audit footer — model, chunk count, request ID
  if (resultAuditFooter) {
    const parts = [];
    if (data.model) {
      const m = data.model;
      const modelShort = m.includes('nemotron') ? 'Nemotron-49B'
                       : m.includes('llama') ? 'Llama-70B'
                       : m.split('/').pop() || m;
      parts.push(modelShort);
    }
    if (data.chunkCount && data.chunkCount > 1) parts.push(data.chunkCount + ' chunks');
    if (data.requestId) parts.push('#' + data.requestId.slice(0, 6));
    if (parts.length > 0) {
      resultAuditFooter.textContent = parts.join(' \u00b7 ');
      resultAuditFooter.style.display = 'block';
    } else {
      resultAuditFooter.style.display = 'none';
    }
  }

  resultCard.style.display = 'block';
  const statusLabel = isCautious ? 'OKAY · CAUTIOUS' : data.rating;
  setStatus(statusLabel + ' · ' + (data.score ?? '–') + '/100', 'done');
}

function updateToggleUI() {
  eli5Switch.className = 'toggle-switch eli5' + (eli5Mode    ? ' on' : '');
  dpSwitch.className   = 'toggle-switch dp'   + (darkPatterns ? ' on' : '');
  eli5Toggle.setAttribute('aria-pressed', eli5Mode ? 'true' : 'false');
  dpToggle.setAttribute('aria-pressed', darkPatterns ? 'true' : 'false');
}

// ── Auth state ───────────────────────────────────────────────────────────────
function renderAuthState({ authEmail, authTokenExpiry } = {}) {
  const TOKEN_SKEW_BUFFER = 5 * 60 * 1000; // 5-min grace for clock skew
  const signedIn = authEmail && authTokenExpiry > (Date.now() - TOKEN_SKEW_BUFFER);
  authBanner.style.display = signedIn ? 'none'  : 'block';
  userRow.style.display    = signedIn ? 'flex'  : 'none';
  scanBtn.disabled         = !signedIn;
  if (signedIn) {
    userEmail.textContent = authEmail;
    if (userAvatarInitial) {
      userAvatarInitial.textContent = (authEmail[0] || '?').toUpperCase();
    }
  }
}

// ── Load all settings and auth state in a single storage read ───────────────
_browser.storage.local.get(
  {
    authEmail: null,
    authTokenExpiry: 0,
    authCredits: null,
    authToken: null,
    apiUrl: DEFAULT_API_URL,
    eli5Mode: true,
    darkPatterns: true,
    tier: 'quick',
  },
  (data) => {
    // Auth state
    renderAuthState(data);
    if (data.authCredits != null) {
      creditsPill.style.display = 'block';
      creditsVal.textContent = data.authCredits + ' credits';
    }

    // Toggles
    eli5Mode     = data.eli5Mode;
    darkPatterns = data.darkPatterns;
    updateToggleUI();

    selectedTier = data.tier || 'quick';
    tierBtns.forEach(b => {
      if (b.dataset.tier === selectedTier) b.classList.add('active');
      else b.classList.remove('active');
    });

    // Backend URL input
    apiUrlInput.value = data.apiUrl || '';

    // Show the active backend URL in the footer (base URL without path)
    if (footerApiUrl) {
      try {
        const base = (data.apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
        const display = new URL(base).hostname;
        footerApiUrl.textContent = display;
        footerApiUrl.title = base;
      } catch (_) {
        footerApiUrl.textContent = '';
      }
    }

    // Fetch live credits from server if signed in
    const TOKEN_SKEW_BUFFER = 5 * 60 * 1000;
    const validToken = data.authToken && data.authTokenExpiry > (Date.now() - TOKEN_SKEW_BUFFER) ? data.authToken : null;
    if (validToken && (data.apiUrl || DEFAULT_API_URL)) {
      const base = (data.apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
      const creditsController = new AbortController();
      const creditsTimeout = setTimeout(() => creditsController.abort(), 5000);
      fetch(base + '/api/credits', {
        headers: {
          'Authorization': 'Bearer ' + validToken,
        },
        signal: creditsController.signal,
      })
        .then(r => {
          if (r.status === 401) {
            // E-2: Token was revoked (e.g. password change) — clear stale credentials
            // and show signed-out state so user knows they need to re-authenticate.
            _browser.storage.local.remove(['authToken', 'authUid', 'authEmail', 'authTokenExpiry', 'authCredits']);
            renderAuthState({});
            creditsPill.style.display = 'none';
            if (authBanner) {
              authBanner.style.display = 'block';
              const msg = authBanner.querySelector('p') || authBanner;
              msg.textContent = 'Session expired — please sign in again.';
            }
            return null;
          }
          return r.ok ? r.json() : null;
        })
        .then(d => {
          if (d && typeof d.credits === 'number') {
            _browser.storage.local.set({ authCredits: d.credits });
            creditsPill.style.display = 'block';
            creditsVal.textContent = d.credits + ' credits';
          } else if (d && d.unavailable) {
            // Firestore flapping — keep cached credits, don't break UI
          }
        })
        .catch(() => {}) // silently ignore network errors — cached value stays displayed
        .finally(() => clearTimeout(creditsTimeout));
    }

    // ── Active auth probe ─────────────────────────────────────────────────────
    // If the popup shows "signed out" but the web app might be open and signed in,
    // inject a tiny script that asks the web app to re-broadcast its Firebase token.
    // This handles: extension installed AFTER sign-in, expired token refresh, etc.
    const signedIn = data.authEmail && data.authTokenExpiry > Date.now();
    if (!signedIn) {
      const webAppOrigin = (data.apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
      _browser.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id && tab.url && tab.url.startsWith(webAppOrigin)) {
            // Found an open web app tab — ask the content script to request a token re-sync
            _browser.tabs.sendMessage(tab.id, { type: 'REQUEST_AUTH_SYNC' }).catch(() => {});
            break;
          }
        }
      });
    }
  }
);

// Sign in — opens TLDR Shield web app so user can authenticate
signInBtn.addEventListener('click', () => {
  _browser.storage.local.get({ apiUrl: DEFAULT_API_URL }, ({ apiUrl }) => {
    const dashUrl = (apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
    _browser.tabs.create({ url: dashUrl });
    window.close();
  });
});

// ── Live auth state + credits updates ────────────────────────────────────────
// Covers: sign-in propagating from web app, token refresh, and credits deducted
// after each scan (background.js writes authCredits on every ANALYSIS_RESULT).
_browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Auth state changed — re-render signed-in / signed-out UI
  if (changes.authEmail || changes.authTokenExpiry) {
    _browser.storage.local.get(['authEmail', 'authTokenExpiry', 'authCredits'], (data) => {
      renderAuthState(data);
      if (data.authCredits != null) {
        creditsPill.style.display = 'block';
        creditsVal.textContent = data.authCredits + ' credits';
      }
    });
  }
  // Credits changed — update pill immediately without a full re-render
  if (changes.authCredits) {
    const val = changes.authCredits.newValue;
    if (val != null) {
      creditsPill.style.display = 'block';
      creditsVal.textContent = val + ' credits';
    }
  }
});

// Sign out — clear stored token
signOutBtn.addEventListener('click', () => {
  _browser.storage.local.remove(['authToken', 'authUid', 'authEmail', 'authTokenExpiry', 'authCredits'], () => {
    renderAuthState({});
    creditsPill.style.display = 'none';
    setStatus('Signed out.', 'idle');
  });
});

// ── Save URL ─────────────────────────────────────────────────────────────────
saveUrlBtn.addEventListener('click', () => {
  const val = apiUrlInput.value.trim();
  if (val) {
    try { new URL(val); } catch (_) {
      setStatus('Invalid URL — must start with https://', 'error');
      return;
    }
  }
  if (!val) {
    setStatus('Enter a valid backend URL.', 'error');
    return;
  }
  _browser.storage.local.set({ apiUrl: val }, () => {
    urlSavedMsg.style.display = 'block';
    setTimeout(() => { urlSavedMsg.style.display = 'none'; }, 2000);
    // Update footer URL display with new hostname
    if (footerApiUrl) {
      try {
        const base = val.replace(/\/api\/analyze$/, '');
        const display = new URL(base).hostname;
        footerApiUrl.textContent = display;
        footerApiUrl.title = base;
      } catch (_) {
        footerApiUrl.textContent = '';
      }
    }
  });
});

// ── Toggle ELI5 ──────────────────────────────────────────────────────────────
eli5Toggle.addEventListener('click', () => {
  eli5Mode = !eli5Mode;
  _browser.storage.local.set({ eli5Mode });
  updateToggleUI();
});

// ── Toggle Dark Patterns ──────────────────────────────────────────────────────
dpToggle.addEventListener('click', () => {
  darkPatterns = !darkPatterns;
  _browser.storage.local.set({ darkPatterns });
  updateToggleUI();
});

// ── Scan button ───────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  _scanInProgress = true;
  cancelAutoClose(); // hold popup open during the full scan
  scanBtn.disabled = true;
  resultCard.style.display = 'none'; // clear previous result
  setStatus('Extracting document…', 'scanning');

  try {
    const [tab] = await _browser.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      setStatus('No active tab found.', 'error');
      scanBtn.disabled = false;
      return;
    }

    // Guard: don't scan the TLDR Shield app itself — it's not a ToS page
    const appOrigin = DEFAULT_API_URL.replace(/\/api\/analyze$/, '');
    if (tab.url && tab.url.startsWith(appOrigin)) {
      setStatus('Navigate to a Terms of Service or Privacy Policy page first.', 'error');
      scanBtn.disabled = false;
      return;
    }

    // Guard: can't inject into chrome:// or extension pages
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
      setStatus('Can\'t scan browser system pages.', 'error');
      scanBtn.disabled = false;
      return;
    }

    // FIX #9: Ask the content script (Agent 2) to extract text using its smart
    // extraction logic — modal detection, semantic containers, pagination.
    // Falls back to executeScript raw grab if the content script is unreachable
    // (e.g. chrome:// pages, extension pages, PDF viewer).
    let pageText = '';

    try {
      const response = await _browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOR_POPUP' });
      pageText = response?.text ?? '';
    } catch (_) {
      // Content script not available on this page — fall back to raw body text
      try {
        const [{ result }] = await _browser.scripting.executeScript({
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
    // eli5Mode and darkPatterns are read from storage by background.js — not passed in message
    _browser.runtime.sendMessage({ 
      type: 'ANALYZE_TEXT', 
      text: pageText, 
      tier: selectedTier,
      tabId: tab.id, 
      url: tab.url || null 
    });
    // Re-enable after sending; result will appear below when ready
    setTimeout(() => {
      setStatus('Analyzing… result will appear below.', 'scanning');
      scanBtn.disabled = false;
    }, 1500);

  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    scanBtn.disabled = false;
  }
});

// ── Batch Scan ──────────────────────────────────────────────────────────────
const batchScanBtn     = document.getElementById('batch-scan-btn');
const batchProgress    = document.getElementById('batch-progress');
const batchStatus      = document.getElementById('batch-status');
const batchResultsList = document.getElementById('batch-results-list');

function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

// Detect legal links on active tab to decide whether to show batch button
_browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (!tabId) return;
  _browser.tabs.sendMessage(tabId, { type: 'GET_LEGAL_LINKS' }, (response) => {
    const batchSection = document.getElementById('batch-section');
    const btn = document.getElementById('batch-scan-btn');
    if (!batchSection || !btn) return;
    batchSection.style.display = 'block';
    if (_browser.runtime.lastError || !response?.links?.length) {
      btn.disabled = true;
      btn.title = 'No legal links found on this page';
      return;
    }
    btn.disabled = false;
    btn.title = '';
    batchSection.dataset.links = JSON.stringify(response.links);
  });
});

if (batchScanBtn) {
  batchScanBtn.addEventListener('click', () => {
    const batchSection = document.getElementById('batch-section');
    let links;
    try {
      links = JSON.parse(batchSection?.dataset.links ?? '[]');
    } catch (_) {
      links = [];
    }
    if (!links.length) return;

    batchScanBtn.disabled = true;
    batchScanBtn.textContent = 'Scanning\u2026';
    if (batchProgress) batchProgress.style.display = 'block';
    if (batchStatus) batchStatus.textContent = `Starting scan of ${links.length} link(s)\u2026`;
    clearChildren(batchResultsList);

    // Get current tier from storage
    _browser.storage.local.get({ tier: 'quick' }, ({ tier }) => {
      _browser.runtime.sendMessage({
        type: 'BATCH_SCAN',
        urls: links,
        tier: tier,
      });
    });
  });
}

// Listen for background messages
_browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'ANALYSIS_RESULT') {
    _scanInProgress = false;
    if (message.data) {
      // Show result inline in the popup
      showResult(message.data);
      startAutoClose(5000); // close 5s after result arrives
      // Local AI badge for WASM results
      if (message.data.local) {
        const badge = document.getElementById('local-ai-badge');
        if (badge) badge.style.display = 'inline-block';
      }
    } else if (message.error) {
      _scanInProgress = false;
      startAutoClose(5000);
      // Translate technical errors into plain-English messages
      const err = message.error || '';
      let friendlyMsg;
      if (err.includes('Sign in required') || err.includes('401')) {
        friendlyMsg = 'Session expired — open the dashboard and sign in again.';
      } else if (err.includes('timed out') || err.includes('AbortError')) {
        friendlyMsg = 'Scan timed out. Try Quick tier or a shorter page.';
      } else if (err.includes('connection') || err.includes('fetch') || err.includes('network')) {
        friendlyMsg = 'No connection to server. Check your internet and try again.';
      } else if (err.includes('No readable text') || err.includes('Page has no')) {
        friendlyMsg = 'Page has no readable text. Try on a proper ToS/Privacy Policy page.';
      } else {
        friendlyMsg = err.length < 80 ? err : 'Analysis failed. Try again or switch to Deep scan.';
      }
      setStatus(friendlyMsg, 'error');
    }
  }
  if (message.type === 'OUT_OF_CREDITS') {
    const resetMsg = message.resetDate ? ` Resets ${message.resetDate}.` : ' Resets on the 1st.';
    setStatus('Out of credits.' + resetMsg, 'error');
  }
  if (message.type === 'ANALYSIS_PROGRESS') {
    setStatus(message.status, 'scanning');
  }
  if (message.type === 'WASM_PROGRESS') {
    const statusEl = document.getElementById('status-text') || document.getElementById('loading-status');
    if (statusEl) statusEl.textContent = message.message;
  }
  if (message.type !== 'BATCH_PROGRESS' && message.type !== 'BATCH_COMPLETE') return;

  if (batchStatus) {
    batchStatus.textContent = message.type === 'BATCH_COMPLETE'
      ? `Done \u2014 scanned ${message.total} link(s)`
      : `Scanning ${message.completed + 1} of ${message.total}: ${(message.currentUrl ?? '').replace(/^https?:\/\//, '').slice(0, 40)}`;
  }

  // Render results using safe DOM construction — no innerHTML with user data
  if (batchResultsList && message.results?.length) {
    clearChildren(batchResultsList);
    message.results.forEach(r => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07); font-size:11px; cursor:pointer;';
      div.addEventListener('click', () => {
        _browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (tabId && _browser.sidePanel) {
            _browser.sidePanel.open({ tabId }).catch(() => {});
          }
          window.close();
        });
      });

      const hostname = (() => { try { return new URL(r.url).hostname; } catch (_) { return r.url; } })();

      const hostnameSpan = document.createElement('span');
      hostnameSpan.style.color = 'rgba(255,255,255,0.5)';
      hostnameSpan.textContent = hostname;

      const statusSpan = document.createElement('span');
      statusSpan.style.fontWeight = '600';
      if (r.error) {
        statusSpan.style.color = '#f87171';
        statusSpan.textContent = r.error === 'OUT_OF_CREDITS' ? ' \u2014 Out of credits' : ' \u2014 Error';
      } else {
        const colors = { SAFE: '#34d399', OKAY: '#fbbf24', RISKY: '#f87171' };
        statusSpan.style.color = colors[r.rating] || '#fff';
        statusSpan.textContent = ` ${r.rating} ${r.score}/100`;
      }

      div.appendChild(hostnameSpan);
      div.appendChild(statusSpan);
      batchResultsList.appendChild(div);
    });
  }

  if (message.type === 'BATCH_COMPLETE' && batchScanBtn) {
    batchScanBtn.disabled = false;
    batchScanBtn.textContent = '\uD83D\uDD0D Scan Again';
  }
});

// ── Open side panel ───────────────────────────────────────────────────────────
const openPanelBtn = document.getElementById('open-panel');
if (openPanelBtn) {
  openPanelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    _browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId && _browser.sidePanel) {
        _browser.sidePanel.open({ tabId }).catch(() => {});
      }
      window.close();
    });
  });
}

// ── Open dashboard ────────────────────────────────────────────────────────────
openDashBtn.addEventListener('click', (e) => {
  e.preventDefault();
  _browser.storage.local.get({ apiUrl: DEFAULT_API_URL }, ({ apiUrl }) => {
    // Strip /api/analyze suffix to get the dashboard root
    const dashUrl = (apiUrl || DEFAULT_API_URL).replace(/\/api\/analyze$/, '');
    _browser.tabs.create({ url: dashUrl });
  });
});
