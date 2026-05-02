// â”€â”€ TLDR Shield â€“ Content Script (UI + Bootstrap) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Multi-agent pipeline (browser side):
//   Agent 1 â†’ detect T&C presence          (detection.js)
//   Agent 2 â†’ extract + clean text          (extraction.js)
//   Agent 3 â†’ send to server for analysis   (background.js)
//   Agent 4 â†’ aggregate + display result    (this file)
//   Auth    â†’ token bridge                  (bridge.js)
//
// detection.js and extraction.js are loaded BEFORE this file by manifest.json.
// They export all shared functions/constants via window.TLDRShield namespace.

// â”€â”€ Re-import from namespace (set by detection.js + extraction.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const {
  SIGNALS, CONFIDENCE_THRESHOLD, TLDR_DEFAULT_API_BASE,
  getReportUrl, LEGAL_URL_PATTERNS, LEGAL_KEYWORDS, BLOCKED_HOSTS,
  COOKIE_BANNER_SELECTORS, TLDR_APP_HOST,
  isBlockedHost, hasLegalKeyword, computeConfidence,
  SEMANTIC_SELECTORS, cleanText, sleep,
  extractPageText, extractPolicySuite, discoverLegalSuite,
} = window.TLDRShield;


// â”€â”€ SHADOW DOM UI ISOLATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Host for all extension UI elements. Using Shadow DOM prevents the page's CSS 
// from leaking into our panels and allows us to bypass some CSP restrictions.
let tldrShadowRoot = null;
let tldrUiHost = null;

// Guard: after extension reload/update, chrome.runtime becomes invalid.
// Any call to chrome.runtime.* throws "Extension context invalidated".
// Check before every use so stale content scripts fail silently.
function isExtensionContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function getUiRoot() {
  if (tldrShadowRoot) return tldrShadowRoot;
  
  tldrUiHost = document.createElement('div');
  tldrUiHost.id = 'tldr-shield-host';
  // closed root is slightly more secure against intentional page tampering
  tldrShadowRoot = tldrUiHost.attachShadow({ mode: 'closed' });
  
  // Inject internal CSS into shadow root
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  if (isExtensionContextValid()) link.href = chrome.runtime.getURL('content.css');
  tldrShadowRoot.appendChild(link);
  
  // Also inject fonts (some sites might allow this inside shadow but block in head)
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,400;0,600;0,700;1,400;1,600&family=JetBrains+Mono:wght@400;500;600&display=swap';
  tldrShadowRoot.appendChild(fontLink);

  document.body.appendChild(tldrUiHost);
  return tldrShadowRoot;
}

function getUiElement(id) {
  return getUiRoot().getElementById(id);
}

// Detection functions (computeConfidence, isBlockedHost, hasLegalKeyword) and
// extraction functions (extractPageText, extractPolicySuite, etc.) are loaded
// from detection.js and extraction.js via the TLDRShield namespace above.




// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TRIGGER BUTTON â€” shown when confidence â‰¥ threshold
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Shield icon SVG
const SHIELD_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L4 6V12C4 16.4 7.4 20.5 12 22C16.6 20.5 20 16.4 20 12V6L12 2Z" fill="#38bdf8"/>
  <path d="M9 12L11 14L15 10" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function setTriggerIdle(btn) {
  btn.dataset.scanning = 'false';
  btn.classList.remove('tldr-scanning');
  btn.classList.add('tldr-idle');
  btn.innerHTML = SHIELD_SVG;
  btn.title = 'Analyze with TLDR Shield';
}

function showUpdateRefreshToast() {
  if (document.getElementById('tldr-update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'tldr-update-toast';
  toast.style.cssText = 'position:fixed;bottom:80px;right:24px;z-index:2147483647;background:#1e1b4b;border:1px solid rgba(139,92,246,0.5);color:#e2e8f0;font-family:system-ui,sans-serif;font-size:13px;padding:12px 16px;border-radius:12px;max-width:260px;box-shadow:0 8px 24px rgba(0,0,0,0.4);display:flex;flex-direction:column;gap:8px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px';
  const icon = document.createElement('span');
  icon.textContent = 'ðŸ”„';
  const label = document.createElement('strong');
  label.style.color = '#a78bfa';
  label.textContent = 'TLDR Shield updated';
  header.appendChild(icon);
  header.appendChild(label);

  const msg = document.createElement('div');
  msg.style.cssText = 'color:#cbd5e1;font-size:12px';
  msg.textContent = 'Refresh this page to apply the latest version.';

  const refreshBtn = document.createElement('button');
  refreshBtn.style.cssText = 'background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600';
  refreshBtn.textContent = 'Refresh page now';
  refreshBtn.addEventListener('click', () => location.reload());

  toast.appendChild(header);
  toast.appendChild(msg);
  toast.appendChild(refreshBtn);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 12000);
}

function setTriggerScanning(btn) {
  btn.dataset.scanning = 'true';
  btn.classList.remove('tldr-idle');
  btn.classList.add('tldr-scanning');
  btn.innerHTML = '<div class="tldr-spinner"></div>';
  btn.title = 'Analyzingâ€¦';
}

function removeContextMenu() {
  getUiElement('tldr-context-menu')?.remove();
}

function showContextMenu(x, y) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'tldr-context-menu';
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top  = '0px';

  const host = location.hostname;

  const disableSite = document.createElement('button');
  disableSite.textContent = `Disable on ${host}`;
  disableSite.className = 'tldr-menu-danger';
  disableSite.onclick = () => {
    chrome.storage.local.get({ disabledSites: [] }, ({ disabledSites }) => {
      if (!disabledSites.includes(host)) disabledSites.push(host);
      chrome.storage.local.set({ disabledSites });
    });
    removeTriggerButton();
    removeContextMenu();
  };

  const disableAll = document.createElement('button');
  disableAll.textContent = 'Disable on all sites';
  disableAll.className = 'tldr-menu-danger';
  disableAll.onclick = () => {
    chrome.storage.local.set({ disabledAll: true });
    removeTriggerButton();
    removeContextMenu();
  };

  menu.appendChild(disableSite);
  menu.appendChild(disableAll);
  getUiRoot().appendChild(menu);

  const mw = menu.offsetWidth  || 210;
  const mh = menu.offsetHeight || 90;
  const left = (x + mw > window.innerWidth)  ? x - mw : x;
  const top  = (y + mh > window.innerHeight) ? y - mh : y;
  menu.style.left       = Math.max(4, left) + 'px';
  menu.style.top        = Math.max(4, top)  + 'px';
  menu.style.visibility = 'visible';

  // FIX: Robust click-outside logic for Shadow DOM
  // We use a capture-phase listener on document to ensure we catch it before site logic,
  // then check composedPath to see if the click was truly outside our UI root.
  const handleGlobalClick = (e) => {
    const path = e.composedPath();
    const root = getUiRoot();
    if (root && !path.includes(root)) {
      removeContextMenu();
      document.removeEventListener('click', handleGlobalClick, true);
    }
  };
  setTimeout(() => document.addEventListener('click', handleGlobalClick, true), 0);
}

function snapBtn(btn, side, top) {
  if (!btn) return;
  btn.style.top    = Math.min(Math.max(top, 60), window.innerHeight - 80) + 'px';
  btn.style.bottom = 'auto';
  if (side === 'left') {
    btn.style.left  = '0';
    btn.style.right = 'auto';
    btn.classList.add('tldr-left-side');
  } else {
    btn.style.right = '0';
    btn.style.left  = 'auto';
    btn.classList.remove('tldr-left-side');
  }
}

function createTriggerButton() {
  if (getUiElement('tldr-shield-trigger')) return;

  const btn = document.createElement('div');
  btn.id = 'tldr-shield-trigger';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Analyze with TLDR Shield');
  setTriggerIdle(btn);
  btn.style.visibility = 'hidden';
  btn.style.cursor = 'pointer';
  getUiRoot().appendChild(btn);

  try {
    chrome.storage.local.get({ fabSide: 'right', fabTop: 180 }, ({ fabSide, fabTop }) => {
      snapBtn(btn, fabSide, fabTop);
      btn.style.visibility = 'visible';
    });
  } catch (e) {
    snapBtn(btn, 'right', 180);
    btn.style.visibility = 'visible';
  }

  // â”€â”€ Drag logic (pointer capture â€” works across all browsers/pages) â”€â”€â”€â”€â”€â”€
  let moved = false, dragging = false, offsetY = 0, startX = 0, startY = 0;

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    moved    = false;
    dragging = false;
    startX   = e.clientX;
    startY   = e.clientY;
    offsetY  = e.clientY - btn.getBoundingClientRect().top;
    btn.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  btn.addEventListener('pointermove', (e) => {
    if (!btn.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // Only enter drag mode after moving â‰¥6px â€” avoids grab cursor on plain click
    if (!dragging && Math.sqrt(dx * dx + dy * dy) < 6) return;
    if (!dragging) {
      dragging = true;
      btn.classList.add('tldr-dragging');
      btn.style.bottom = 'auto';
      btn.style.right  = 'auto';
    }
    moved = true;
    btn.style.left = Math.max(0, e.clientX - 24) + 'px';
    btn.style.top  = Math.min(Math.max(e.clientY - offsetY, 60), window.innerHeight - 80) + 'px';
  });

  btn.addEventListener('pointerup', (e) => {
    try {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      btn.releasePointerCapture(e.pointerId);
      btn.classList.remove('tldr-dragging');
      btn.style.cursor = 'pointer';
      if (dragging) {
        const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
        const top  = parseInt(btn.style.top);
        snapBtn(btn, side, top);
        // Guard: context may be invalidated if extension was reloaded mid-session
        if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
          chrome.storage.local.set({ fabSide: side, fabTop: top });
        }
      }
      dragging = false;
    } catch (err) {
      dragging = false; // always reset even on error
      if (err?.message?.includes('context invalidated') || err?.message?.includes('Extension context')) return;
      throw err;
    }
  });

  // â”€â”€ Click to scan (only if not dragged) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  btn.addEventListener('click', async () => {
    if (moved) { moved = false; return; }
    if (btn.dataset.scanning === 'true') return;

    // Extension was updated but this tab hasn't been refreshed yet â€” show a friendly prompt.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      showUpdateRefreshToast();
      return;
    }

    setTriggerScanning(btn);
    // Show skeleton immediately so user sees feedback right away
    showSkeletonPanel();

    // PERSISTENCE FIX: Read the user's preferred tier (defaulting to quick) from storage
    // so the floating icon respects the selection made in the popup.
    let tier = 'quick';
    try {
      const storage = await chrome.storage.local.get(['tier']);
      if (storage && storage.tier) tier = storage.tier;
    } catch (e) {
      console.warn('[TLDR Shield] Context invalidated during tier fetch. Please refresh.');
      return;
    }

    try {
      // PDF detection: if the page IS a PDF (Chrome shows it via the built-in viewer
      // or the URL ends with .pdf), route to offscreen pdf.js extractor instead.
      const isPdf = document.contentType === 'application/pdf' ||
                    /\.pdf(\?.*)?$/i.test(location.href) ||
                    document.querySelector('embed[type="application/pdf"]') !== null;
      if (isPdf) {
        chrome.runtime.sendMessage({ type: 'ANALYZE_PDF', url: location.href });
        return; // background.js will send ANALYSIS_RESULT when done
      }
      let text = await extractPageText();
      // CREDIBILITY FIX #3: optionally expand to full legal suite (same-origin
      // privacy + terms + cookies + DPA). Triggered if user opted-in via
      // suiteMode flag, OR auto-triggered when primary page is thin (<2500 chars)
      // and at least 2 other legal links exist on the page.
      try {
        const { suiteMode = false } = await chrome.storage.local.get({ suiteMode: false });
        const primaryThin = (text || '').length < 2500;
        const should = suiteMode || (primaryThin && discoverLegalSuite().length >= 2);
        if (should) {
          const expanded = await extractPolicySuite(text);
          if (expanded && expanded.length > text.length) text = expanded;
        }
      } catch (_) { /* non-fatal */ }
      // FIX: Guard against empty extraction — catch it early with a friendly message
      // rather than sending blank text to the server which would return HTTP 400.
      if (!text || text.length < 100) {
        setTriggerIdle(btn);
        showErrorPanel(
          'Could not extract enough text from this page. Try scrolling to load all content, then scan again. For complex pages, copy-paste the text into the TLDR Shield web app.',
          location.href
        );
        return;
      }
      lastScanText = text;
      lastScanUrl  = location.href;
      // keepalive port ensures the service worker stays alive for the full scan
      const _port = chrome.runtime.connect({ name: 'keepalive' });
      void _port;
      chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text, url: location.href, tier });
    } catch (err) {
      // "Extension context invalidated" = extension was reloaded but this tab still
      // has the old content script. Show a friendly reload prompt instead of silent fail.
      if (err?.message?.includes('Extension context invalidated') ||
          err?.message?.includes('context invalidated')) {
        setTriggerIdle(btn);
        btn.title = 'Extension updated â€” please refresh this page (F5)';
        btn.style.outline = '2px solid #f59e0b';
        // Show a small toast on the page
        const toast = document.createElement('div');
        toast.style.cssText = `
          position:fixed; bottom:80px; right:24px; z-index:2147483647;
          background:#1e1b4b; border:1px solid rgba(245,158,11,0.4);
          color:#fcd34d; font-family:system-ui,sans-serif; font-size:13px;
          font-weight:600; padding:10px 16px; border-radius:12px;
          box-shadow:0 4px 20px rgba(0,0,0,0.5); pointer-events:none;
        `;
        toast.textContent = 'âŸ³ Extension updated â€” refresh this page to scan';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
        return;
      }
      setTriggerIdle(btn);
      showErrorPanel('Failed to extract page text. Please try refreshing the page.', location.href);
    }
  });

  // â”€â”€ Right-click context menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });
}

function removeTriggerButton() {
  getUiElement('tldr-shield-trigger')?.remove();
  removeContextMenu();
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AGENT 4 â€” RESULT PANEL
// Handles both Quick (badge-only) and Deep (full pillars) results.
// Quick result shows a "Run Deep Scan â†’" button.
// Loading states: skeleton â†’ step-by-step progress â†’ result
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ Module-level scan state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Captured before each scan so the "Run Deep Scan â†’" button can re-use them.
let lastScanText = '';
let lastScanUrl  = '';

// â”€â”€ Progress step mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PROGRESS_STEPS = [
  { key: 'reading', label: '\uD83D\uDCC1 Reading Legal Text', triggers: ['chunk', 'read', 'extract'] },
  { key: 'clauses', label: '\uD83E\uDDE0 Identifying Clauses', triggers: ['analyz', 'pillar', 'identifying', 'mapping'] },
  { key: 'auditing', label: '\uD83D\uDEE1\uFE0F Auditing Privacy Pillars', triggers: ['ground', 'citation', 'embed', 'audit', 'scanning', 'searching', 'reviewing'] },
  { key: 'scoring',  label: '\uD83D\uDCC8 Calculating Score',     triggers: ['scor', 'aggregat', 'complet', 'calculating'] },
];

// Tracks which progress steps have been reached
let _progressState = { currentStep: -1 };

function _progressStepIndex(status) {
  if (!status) return -1;
  const s = status.toLowerCase();
  // Reverse search so more advanced steps take precedence
  for (let i = PROGRESS_STEPS.length - 1; i >= 0; i--) {
    if (PROGRESS_STEPS[i].triggers.some(t => s.includes(t))) return i;
  }
  return -1;
}

function removeResultPanel() {
  getUiElement('tldr-shield-result')?.remove();
  // Clean up any citation highlights on the page
  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    }
  });
}

// â”€â”€ Skeleton panel â€” shown immediately when scan starts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showSkeletonPanel() {
  removeResultPanel();
  _progressState = { currentStep: -1 };
  injectFonts();

  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';

  // Header (real, not skeleton)
  const header = document.createElement('div');
  header.className = 'tldr-panel-header';
  const brand = document.createElement('div');
  brand.className = 'tldr-panel-brand';
  const dot = document.createElement('div');
  dot.className = 'tldr-panel-brand-dot';
  brand.appendChild(dot);
  brand.appendChild(document.createTextNode('TLDR Shield'));
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = 'âœ•';
  header.appendChild(brand);
  header.appendChild(closeBtn);

  // Skeleton body
  const skeletonBody = document.createElement('div');
  skeletonBody.id = 'tldr-skeleton-body';
  skeletonBody.style.cssText = 'padding:14px 14px 8px; display:flex; flex-direction:column; gap:12px;';

  // Skeleton score card row
  const skCard = document.createElement('div');
  skCard.style.cssText = 'display:flex; align-items:center; gap:14px; padding:10px 4px;';
  const skRing = document.createElement('div');
  skRing.className = 'tldr-skeleton-ring';
  const skLabels = document.createElement('div');
  skLabels.style.cssText = 'flex:1; display:flex; flex-direction:column; gap:8px;';
  const skL1 = document.createElement('div');
  skL1.className = 'tldr-skeleton-line';
  skL1.style.cssText = 'height:12px; width:60%;';
  const skL2 = document.createElement('div');
  skL2.className = 'tldr-skeleton-line';
  skL2.style.cssText = 'height:9px; width:40%;';
  skLabels.appendChild(skL1);
  skLabels.appendChild(skL2);
  skCard.appendChild(skRing);
  skCard.appendChild(skLabels);

  // Skeleton TLDR row
  const skTldr = document.createElement('div');
  skTldr.className = 'tldr-skeleton-block';
  skTldr.style.cssText = 'height:52px; width:100%;';

  // Skeleton progress step rows
  const skSteps = document.createElement('div');
  skSteps.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding-top:4px;';
  const skWidths = ['55%', '65%', '50%', '60%'];
  for (let i = 0; i < 4; i++) {
    const skRow = document.createElement('div');
    skRow.style.cssText = 'display:flex; align-items:center; gap:10px;';
    const skDot = document.createElement('div');
    skDot.className = 'tldr-skeleton-line';
    skDot.style.cssText = 'width:20px; height:20px; border-radius:50%; flex-shrink:0;';
    const skText = document.createElement('div');
    skText.className = 'tldr-skeleton-line';
    skText.style.cssText = 'height:10px; width:' + skWidths[i] + ';';
    skRow.appendChild(skDot);
    skRow.appendChild(skText);
    skSteps.appendChild(skRow);
  }

  skeletonBody.appendChild(skCard);
  skeletonBody.appendChild(skTldr);
  skeletonBody.appendChild(skSteps);

  panel.appendChild(header);
  panel.appendChild(skeletonBody);

  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = getUiElement('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  getUiRoot().appendChild(panel);
  _attachPanelDrag(panel, header, closeBtn);
}

// â”€â”€ Progress update â€” transitions skeleton â†’ step list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function updateProgressPanel(status) {
  const panel = getUiElement('tldr-shield-result');
  if (!panel) return;

  let stepsContainer = panel.querySelector('#tldr-progress-steps');
  if (!stepsContainer) {
    // Remove skeleton body, replace with real step list
    panel.querySelector('#tldr-skeleton-body')?.remove();
    stepsContainer = document.createElement('div');
    stepsContainer.id = 'tldr-progress-steps';
    stepsContainer.className = 'tldr-loading-steps'; // Using the newly added CSS class
    PROGRESS_STEPS.forEach((step) => {
      const row = document.createElement('div');
      row.className = 'tldr-loading-step'; // Using the newly added CSS class
      row.id = 'tldr-step-' + step.key;
      const dot = document.createElement('div');
      dot.className = 'tldr-step-dot'; // Using the newly added CSS class
      const text = document.createElement('span');
      text.style.marginLeft = '8px';
      text.textContent = step.label;
      row.appendChild(dot);
      row.appendChild(text);
      stepsContainer.appendChild(row);
    });
    panel.appendChild(stepsContainer);
  }

  const stepIdx = _progressStepIndex(status);

  // Restart logic: if we're at step 0 but the state shows we were further, reset.
  if (stepIdx === 0 && _progressState.currentStep > 1) {
    PROGRESS_STEPS.forEach((step) => {
      const row = stepsContainer.querySelector('#tldr-step-' + step.key);
      if (row) row.classList.remove('done', 'active');
    });
    _progressState.currentStep = -1;
  }

  if (stepIdx < 0) return;
  if (stepIdx <= _progressState.currentStep) return; // monotonic â€” skip if already at or past this step

  PROGRESS_STEPS.forEach((step, i) => {
    const row = stepsContainer.querySelector('#tldr-step-' + step.key);
    if (!row) return;
    row.classList.remove('done', 'active');
    if (i < stepIdx) {
      row.classList.add('done');
    } else if (i === stepIdx) {
      row.classList.add('active');
    }
  });

  _progressState.currentStep = stepIdx;
}

// â”€â”€ Shared panel drag setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _attachPanelDrag(panel, header, closeBtn) {
  let pOffX = 0, pOffY = 0;
  header.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn || closeBtn.contains(e.target)) return;
    if (e.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    pOffX = e.clientX - rect.left;
    pOffY = e.clientY - rect.top;
    header.setPointerCapture(e.pointerId);
    header.classList.add('tldr-panel-dragging');
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
    panel.style.left   = rect.left + 'px';
    panel.style.top    = rect.top  + 'px';
    e.preventDefault();
  });
  header.addEventListener('pointermove', (e) => {
    if (!header.hasPointerCapture(e.pointerId)) return;
    const x = Math.max(0, Math.min(e.clientX - pOffX, window.innerWidth  - panel.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - pOffY, window.innerHeight - panel.offsetHeight));
    panel.style.left = x + 'px';
    panel.style.top  = y + 'px';
  });
  header.addEventListener('pointerup', (e) => {
    if (!header.hasPointerCapture(e.pointerId)) return;
    header.releasePointerCapture(e.pointerId);
    header.classList.remove('tldr-panel-dragging');
  });
}

// Finds citation text in the page DOM, scrolls to it, and highlights it
// â”€â”€ Citation highlighting using mark.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// mark.js (lib/mark.min.js loaded before this file) handles:
//   - Text split across inline DOM elements (<strong>, <em>, <span>, <a>)
//   - React/Vue rendered content (reconciles text node fragments)
//   - Case-insensitive, diacritic-insensitive matching
//   - Shadow DOM traversal via iframes option
//
// Strategy:
//   1. Try full citation verbatim (most accurate)
//   2. Try longest prefix slices (60, 40 chars)
//   3. Try longest 8â†’5 word windows (handles partial paraphrase survival)
//   Each attempt is case-insensitive, partial accuracy mode.

// The scope for mark.js â€” everything except our own injected UI
function getMarkScope() {
  const body = document.body;
  if (!body) return body;
  // Create a temporary wrapper including everything except our UI elements
  // mark.js accepts a single element as context
  return body;
}

// Exclude selector: mark.js will skip these containers
const MARK_EXCLUDE = [
  '#tldr-shield-result',
  '#tldr-shield-trigger',
  '#tldr-context-menu',
  '#tldr-progress-panel',
  'script', 'style', 'noscript',
];

function highlightCitation(citation) {
  if (!citation || citation === 'Not addressed in document.') return false;
  if (typeof Mark === 'undefined') return highlightCitationFallback(citation);

  // Clear previous highlights
  const scope = getMarkScope();
  const markInstance = new Mark(scope);
  markInstance.unmark({ exclude: MARK_EXCLUDE });

  // Clean surrounding quotes
  const clean = citation.replace(/^["'"'\u201c\u2018]|["'"'\u201d\u2019]$/g, '').trim();
  if (!clean) return false;

  // Build ordered candidates â€” most specific first
  const candidates = [];

  // 1. Full citation
  candidates.push(clean);

  // 2. Prefix slices (longest â†’ shortest)
  for (const len of [80, 60, 40, 25]) {
    const s = clean.slice(0, len).trim();
    if (s.length >= 20 && s !== clean) candidates.push(s);
  }

  // 3. Sliding word windows (8â†’5 words)
  const words = clean.split(/\s+/).filter(Boolean);
  for (const size of [8, 7, 6, 5]) {
    for (let i = 0; i <= words.length - size; i++) {
      candidates.push(words.slice(i, i + size).join(' '));
    }
  }

  // Try each candidate until mark.js finds a match
  return new Promise((resolve) => {
    let found = false;
    let idx   = 0;

    const tryNext = () => {
      if (found || idx >= candidates.length) { resolve(found); return; }
      const needle = candidates[idx++];
      if (!needle || needle.length < 15) { tryNext(); return; }

      markInstance.unmark({ exclude: MARK_EXCLUDE, done: () => {
        markInstance.mark(needle, {
          element:    'mark',
          className:  'tldr-citation-highlight',
          exclude:    MARK_EXCLUDE,
          accuracy:   'partially',
          caseSensitive: false,
          separateWordSearch: false,
          ignorePunctuation: [',', '.', ';', ':', '!', '?', '"', "'"],
          acrossElements: true,
          done: (count) => {
            if (count > 0) {
              found = true;
              // Scroll first highlight into view
              const first = document.querySelector('.tldr-citation-highlight');
              if (first) {
                first.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Fade out after 5s
                setTimeout(() => {
                  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
                    el.style.transition = 'background 0.9s, box-shadow 0.9s, outline 0.9s';
                    el.style.background = 'transparent';
                    el.style.boxShadow  = 'none';
                    el.style.outline    = 'none';
                  });
                }, 5000);
              }
              resolve(true);
            } else {
              tryNext();
            }
          },
        });
      }});
    };

    tryNext();
  });
}

// Synchronous fallback used when mark.js is unavailable
function highlightCitationFallback(citation) {
  if (!citation || citation === 'Not addressed in document.') return false;
  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
    const parent = el.parentNode;
    if (parent) { parent.replaceChild(document.createTextNode(el.textContent), el); parent.normalize(); }
  });
  const clean = citation.replace(/^["'"'\u201c\u2018]|["'"'\u201d\u2019]$/g, '').trim();
  window.getSelection()?.removeAllRanges();
  const found = window.find(clean, false, false, true, false, false, false);
  if (found) {
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      try {
        const span = document.createElement('mark');
        span.className = 'tldr-citation-highlight';
        sel.getRangeAt(0).surroundContents(span);
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      window.getSelection()?.removeAllRanges();
    }
    return true;
  }
  return false;
}

// â”€â”€ Error panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showErrorPanel(errorMsg, pageUrl) {
  removeResultPanel();
  injectFonts();

  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';

  // Header
  const header = document.createElement('div');
  header.className = 'tldr-panel-header';
  const brand = document.createElement('div');
  brand.className = 'tldr-panel-brand';
  const dot = document.createElement('div');
  dot.className = 'tldr-panel-brand-dot';
  brand.appendChild(dot);
  brand.appendChild(document.createTextNode('TLDR Shield'));
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  header.appendChild(brand);
  header.appendChild(closeBtn);

  // Error body
  const body = document.createElement('div');
  body.className = 'tldr-error-body';

  const iconEl = document.createElement('div');
  iconEl.className = 'tldr-error-icon';
  iconEl.textContent = '!';

  const msgEl = document.createElement('div');
  msgEl.className = 'tldr-error-msg';
  msgEl.textContent = errorMsg || 'Something went wrong. Please try again.';

  const retryBtn = document.createElement('button');
  retryBtn.className = 'tldr-retry-btn';
  retryBtn.textContent = '\u21ba Try Again';
  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying\u2026';
    const trigBtn = getUiElement('tldr-shield-trigger');
    if (trigBtn) setTriggerScanning(trigBtn);
    showSkeletonPanel();
    try {
      const _retryPort = chrome.runtime.connect({ name: 'keepalive' });
      void _retryPort;
      const isPdf = document.contentType === 'application/pdf' ||
                    /\.pdf(\?.*)?$/i.test(location.href) ||
                    document.querySelector('embed[type="application/pdf"]') !== null;
      if (isPdf) {
        chrome.runtime.sendMessage({ type: 'ANALYZE_PDF', url: pageUrl || location.href });
        return;
      }
      const text = await extractPageText();
      chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text, url: pageUrl || location.href });
    } catch (err) {
      showErrorPanel('Failed to extract page text. Please refresh the page and try again.', pageUrl);
    }
  });

  // FIX: Add "Try web app" fallback link so users can paste text manually when extraction fails
  const webAppLink = document.createElement('a');
  webAppLink.className = 'tldr-webapp-link';
  webAppLink.textContent = 'Try the web app \u2192';
  webAppLink.target = '_blank';
  webAppLink.rel = 'noopener noreferrer';
  try { webAppLink.href = TLDR_APP_HOST || 'https://tldr-shield-292798741977.us-central1.run.app'; } catch (_) {}

  body.appendChild(iconEl);
  body.appendChild(msgEl);
  body.appendChild(retryBtn);
  body.appendChild(webAppLink);

  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield \u00b7 AI Privacy Analysis';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = getUiElement('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  getUiRoot().appendChild(panel);
  _attachPanelDrag(panel, header, closeBtn);
}

// â”€â”€ Out-of-credits panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showOutOfCreditsPanel(resetDate) {
  removeResultPanel();
  injectFonts();

  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';

  // Header
  const header = document.createElement('div');
  header.className = 'tldr-panel-header';
  const brand = document.createElement('div');
  brand.className = 'tldr-panel-brand';
  const dot = document.createElement('div');
  dot.className = 'tldr-panel-brand-dot';
  brand.appendChild(dot);
  brand.appendChild(document.createTextNode('TLDR Shield'));
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  header.appendChild(brand);
  header.appendChild(closeBtn);

  // OC body
  const body = document.createElement('div');
  body.className = 'tldr-oc-body';

  const iconEl = document.createElement('div');
  iconEl.className = 'tldr-oc-icon';
  iconEl.textContent = '\u26a1'; // âš¡

  const titleEl = document.createElement('div');
  titleEl.className = 'tldr-oc-title';
  titleEl.textContent = 'No credits remaining';

  const subEl = document.createElement('div');
  subEl.className = 'tldr-oc-sub';
  subEl.textContent = "You've used all your credits for this month.";

  const resetNote = document.createElement('div');
  resetNote.className = 'tldr-oc-reset-note';
  const safeDate = document.createElement('span');
  safeDate.textContent = resetDate || 'the 1st of next month';
  resetNote.appendChild(document.createTextNode('Resets on '));
  resetNote.appendChild(safeDate);

  const dashBtn = document.createElement('a');
  dashBtn.className = 'tldr-oc-dashboard-btn';
  dashBtn.target = '_blank';
  dashBtn.rel = 'noopener';
  dashBtn.href = '#';
  dashBtn.textContent = 'View Dashboard \u2192';
  getReportUrl((base) => {
    if (base) dashBtn.href = base + '/dashboard';
  });

  body.appendChild(iconEl);
  body.appendChild(titleEl);
  body.appendChild(subEl);
  body.appendChild(resetNote);
  body.appendChild(dashBtn);

  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield \u00b7 AI Privacy Analysis';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = getUiElement('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  getUiRoot().appendChild(panel);
  _attachPanelDrag(panel, header, closeBtn);
}

// Inject premium fonts once per page session
let tldrFontsInjected = false;
function injectFonts() {
  if (tldrFontsInjected || document.getElementById('tldr-fonts')) return;
  tldrFontsInjected = true;
  const link = document.createElement('link');
  link.id   = 'tldr-fonts';
  link.rel  = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,400;0,600;0,700;1,400;1,600&family=JetBrains+Mono:wght@400;500;600&display=swap';
  document.head.appendChild(link);
}

// L-1: WeakMap to store citation quote boxes without polluting DOM elements
const _quoteBoxMap = new WeakMap();

// Shown instead of a real result when the AI analysis failed (data.degraded === true).
// A clean, honest panel that prompts the user to retry â€” no fake scores or misleading text.
function showDegradedPanel() {
  removeResultPanel();
  injectFonts();
  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';
  panel.className = 'tldr-result-panel';

  const header = document.createElement('div');
  header.className = 'tldr-result-header';
  const brand = document.createElement('span');
  brand.className = 'tldr-brand';
  brand.textContent = 'âš  TLDR SHIELD';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = 'âœ•';
  closeBtn.addEventListener('click', () => panel.remove());
  header.appendChild(brand);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.style.cssText = 'padding:20px 16px 16px; text-align:center; color:#c5c5c5;';
  const msg = document.createElement('p');
  msg.style.cssText = 'margin:0 0 14px; font-size:13px; line-height:1.5;';
  msg.textContent = 'AI analysis could not be completed for this page. This is usually a temporary issue.';
  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = 'background:#c59d3c; color:#13141c; border:none; border-radius:8px; padding:8px 20px; font-size:12px; font-weight:700; cursor:pointer; letter-spacing:0.05em;';
  retryBtn.textContent = 'RETRY SCAN';
  retryBtn.addEventListener('click', () => {
    panel.remove();
    const triggerBtn = getUiElement('tldr-shield-trigger');
    if (triggerBtn) triggerBtn.click();
  });
  body.appendChild(msg);
  body.appendChild(retryBtn);

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);
}

function showResultPanel(data) {
  removeResultPanel();
  injectFonts();

  // Degraded fallback â€” AI was unavailable (e.g., daily quota hit). The server
  // ran a regex-based scan and returned a real result; show it with a clear
  // banner so the user still gets actionable info instead of a dead end.
  const isDegraded = !!data.degraded;

  const ratingClass = data.rating?.toLowerCase() ?? 'risky';
  const score       = typeof data.score === 'number' ? data.score : null;
  const scoreDisplay = score !== null ? score : '?';
  const isQuick     = !data.pillars;

  const PILLAR_LABELS = {
    ai_training:       'AI Training',
    data_selling:      'Data Selling',
    transparency:      'Transparency',
    data_retention:    'Data Retention',
    content_ownership: 'Ownership',
    dark_patterns:     'Dark Patterns',
  };

  const PILLAR_DESCS = {
    ai_training:       'Is your data used to train AI models?',
    data_selling:      'Is your data sold or shared with 3rd parties?',
    transparency:      'Are policies clearly written and accessible?',
    data_retention:    'How long is your data kept after deletion?',
    content_ownership: 'Do you retain rights to your own content?',
    dark_patterns:     'Hidden opt-outs, forced arbitration clauses?',
  };

  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';

  // â”€â”€ Header â”€â”€
  const header = document.createElement('div');
  header.className = 'tldr-panel-header';

  const brand = document.createElement('div');
  brand.className = 'tldr-panel-brand';
  const dot = document.createElement('div');
  dot.className = 'tldr-panel-brand-dot';
  brand.appendChild(dot);
  brand.appendChild(document.createTextNode('TLDR Shield'));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = 'âœ•';

  header.appendChild(brand);
  header.appendChild(closeBtn);

  // â”€â”€ Rating badge with score ring â”€â”€
  const badge = document.createElement('div');
  const isExtremeRisk = data.rating === 'RISKY' && score !== null && score <= 15;
  badge.className = `tldr-rating-badge ${ratingClass}${isExtremeRisk ? ' tldr-extreme' : ''}`;

  // Left: animated SVG ring showing score percentage
  const ringWrap = document.createElement('div');
  ringWrap.className = 'tldr-score-ring-wrap';
  const ringEl = document.createElement('div');
  ringEl.className = 'tldr-score-ring';
  const CIRCUMFERENCE = 201.06; // 2Ï€ Ã— 32
  const scorePct = score !== null ? Math.max(0, Math.min(100, score)) : 0;
  const dashOffset = CIRCUMFERENCE * (1 - scorePct / 100);
  ringEl.innerHTML = `
    <svg viewBox="0 0 74 74" width="74" height="74">
      <circle class="tldr-score-ring-track" cx="37" cy="37" r="32"/>
      <circle class="tldr-score-ring-fill" cx="37" cy="37" r="32"
              style="stroke-dashoffset:${CIRCUMFERENCE}"/>
    </svg>
    <div class="tldr-score-ring-inner">
      <span class="tldr-score-number">${scoreDisplay}</span>
      <span class="tldr-score-denom">/100</span>
    </div>`;
  ringWrap.appendChild(ringEl);

  // Animate ring fill after insertion (must set via setTimeout so transition fires)
  setTimeout(() => {
    const fill = ringEl.querySelector('.tldr-score-ring-fill');
    if (fill) fill.style.strokeDashoffset = dashOffset;
  }, 50);

  // Right: labels
  const labelsEl = document.createElement('div');
  labelsEl.className = 'tldr-score-labels';

  const ratingLabel = document.createElement('div');
  ratingLabel.className = 'tldr-rating-label';
  ratingLabel.textContent = data.rating ?? 'UNKNOWN';

  // CAUTIOUS sub-label: OKAY with score 50-59 is borderline â€” flag it visually
  // without breaking the 3-tier SAFE/OKAY/RISKY system.
  if (data.rating === 'OKAY' && score !== null && score < 60) {
    const cautiousChip = document.createElement('span');
    cautiousChip.className = 'tldr-cautious-chip';
    cautiousChip.textContent = 'CAUTIOUS';
    ratingLabel.appendChild(cautiousChip);
  }

  const ratingMeta = document.createElement('div');
  ratingMeta.className = 'tldr-rating-score';
  // Freshness fragment â€” "Just now" / "Cached Â· 12m ago" / "Cached Â· 2d ago".
  // Users deserve to see when a verdict was actually computed.
  let freshnessText = '';
  if (data.scannedAt) {
    const ageMs = Math.max(0, Date.now() - Number(data.scannedAt));
    if (ageMs < 60_000)          freshnessText = 'Just now';
    else if (ageMs < 3_600_000)  freshnessText = `${Math.floor(ageMs / 60_000)}m ago`;
    else if (ageMs < 86_400_000) freshnessText = `${Math.floor(ageMs / 3_600_000)}h ago`;
    else                         freshnessText = `${Math.floor(ageMs / 86_400_000)}d ago`;
    if (data.cached) freshnessText = `Cached Â· ${freshnessText}`;
  }
  const baseText = data.chunked ? `${data.chunkCount}-block analysis` : (isQuick ? 'Quick scan' : 'Deep scan');
  ratingMeta.textContent = freshnessText ? `${baseText} Â· ${freshnessText}` : baseText;

  // Violation count pill
  // Credibility fix: only count HIGH/MEDIUM-confidence violations as hazards.
  // LOW-confidence flags deduct 0 points on the server, so they are NOT hazards â€”
  // counting them here contradicts the 100/100 score.
  if (!isQuick && data.pillars) {
    // Classify each pillar: hazard (hard violation), confirmed safe (addressed + no violation),
    // not stated (policy silent), or N/A (category-scoping says this pillar can't apply).
    // Header must match the per-pillar badges â€” no "6/6 Safe" when pillars are NOT STATED or N/A.
    let vCount = 0, safeCount = 0, silentCount = 0, naCount = 0;
    for (const p of Object.values(data.pillars)) {
      const conf    = (p.confidence || 'MEDIUM').toString().toUpperCase();
      const pStatus = (p.status || '').toString().toUpperCase();
      const hardV   = p.violation && conf !== 'LOW';
      const isNA    = pStatus === 'NOT_APPLICABLE' || p.applicable === false;
      const silent  = !isNA && (pStatus === 'NOT_MENTIONED' || (!pStatus && !p.violation && !p.citation));
      if (hardV) vCount++;
      else if (isNA) naCount++;
      else if (silent) silentCount++;
      else safeCount++;
    }
    const applicableTotal = Object.keys(data.pillars).length - naCount;
    const vPill  = document.createElement('div');
    vPill.className = 'tldr-violation-count';
    if (vCount > 0) {
      vPill.textContent = `${vCount} Hazard${vCount > 1 ? 's' : ''} Detected`;
    } else if (silentCount === 0 && naCount === 0) {
      vPill.textContent = `${safeCount}/${applicableTotal} Safe Pillars`;
    } else if (silentCount === 0 && naCount > 0) {
      vPill.textContent = `${safeCount}/${applicableTotal} Safe Â· ${naCount} N/A`;
    } else {
      vPill.textContent = `${safeCount} Safe Â· ${silentCount} Not Stated${naCount > 0 ? ` Â· ${naCount} N/A` : ''}`;
    }
    labelsEl.appendChild(ratingLabel);
    labelsEl.appendChild(ratingMeta);
    labelsEl.appendChild(vPill);
  } else {
    labelsEl.appendChild(ratingLabel);
    labelsEl.appendChild(ratingMeta);
  }

  badge.appendChild(ringWrap);
  badge.appendChild(labelsEl);

  panel.appendChild(header);
  panel.appendChild(badge);

  // â”€â”€ Sampling note â€” long docs are sampled evenly, not truncated â”€â”€
  if (data.truncated) {
    const warn = document.createElement('div');
    warn.className = 'tldr-truncation-warning';
    warn.textContent = 'ðŸ“„ Long document â€” analyzed evenly across all sections for full coverage.';
    panel.appendChild(warn);
  }

  // â”€â”€ Audit Findings (Deductions) â€” FIX: Transparency for ambiguous/silent policies â”€â”€
  if (data.deductions && Array.isArray(data.deductions) && data.deductions.length > 0) {
    const deductContainer = document.createElement('div');
    deductContainer.className = 'tldr-deductions-container';
    
    const deductHeading = document.createElement('div');
    deductHeading.className = 'tldr-deductions-heading';
    deductHeading.textContent = 'Audit Findings';
    deductContainer.appendChild(deductHeading);

    data.deductions.forEach(d => {
      const item = document.createElement('div');
      item.className = 'tldr-deduction-item';
      
      const reason = document.createElement('span');
      reason.className = 'tldr-deduction-reason';
      reason.textContent = d.reason;
      
      const pts = document.createElement('span');
      pts.className = 'tldr-deduction-points';
      pts.textContent = `-${d.points}`;
      
      item.appendChild(reason);
      item.appendChild(pts);
      deductContainer.appendChild(item);
    });
    panel.appendChild(deductContainer);
  }

  // â”€â”€ TLDR Summary â”€â”€
  if (data.tldr) {
    const tldrEl = document.createElement('div');
    tldrEl.className = 'tldr-tldr';
    tldrEl.textContent = '"' + data.tldr + '"';
    panel.appendChild(tldrEl);
  }

  // â”€â”€ Run Deep Scan button (quick scan only) â”€â”€
  if (isQuick) {
    const deepBtn = document.createElement('button');
    deepBtn.className = 'tldr-deep-scan-btn';
    deepBtn.textContent = 'Run Deep Scan \u2192';
    deepBtn.addEventListener('click', async () => {
      if (deepBtn.disabled) return;
      deepBtn.disabled = true;
      deepBtn.textContent = 'Starting deep scan\u2026';
      const trigBtn = getUiElement('tldr-shield-trigger');
      if (trigBtn) setTriggerScanning(trigBtn);
      showSkeletonPanel();
      try {
        const isPdf = document.contentType === 'application/pdf' ||
                      /\.pdf(\?.*)?$/i.test(location.href) ||
                      document.querySelector('embed[type="application/pdf"]') !== null;
        if (isPdf) {
          chrome.runtime.sendMessage({ type: 'ANALYZE_PDF', url: location.href });
          return;
        }
        const text = lastScanText || await extractPageText();
        const url = lastScanUrl || location.href;
        // keepalive port ensures SW stays alive for the deep scan
        const _port = chrome.runtime.connect({ name: 'keepalive' });
        void _port;
        chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text, url, forceDeep: true, tier: 'deep' });
      } catch (err) {
        showErrorPanel('Failed to start deep scan. Please try again.', location.href);
      }
    });
    panel.appendChild(deepBtn);
  }

  // â”€â”€ Pillars (Deep scan only) â”€â”€
  if (data.pillars && Object.keys(data.pillars).length > 0) {
    // Expandable toggle row
    let deepExpanded = false;

    const expandToggle = document.createElement('div');
    expandToggle.className = 'tldr-expand-toggle';
    const expandLabel = document.createElement('span');
    expandLabel.textContent = 'Privacy Pillars';
    const chevron = document.createElement('span');
    chevron.className = 'tldr-expand-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    // Chevron SVG (down arrow)
    const chevSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevSvg.setAttribute('width', '14');
    chevSvg.setAttribute('height', '14');
    chevSvg.setAttribute('viewBox', '0 0 14 14');
    chevSvg.setAttribute('fill', 'none');
    const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    chevPath.setAttribute('d', 'M3 5l4 4 4-4');
    chevPath.setAttribute('stroke', 'currentColor');
    chevPath.setAttribute('stroke-width', '1.5');
    chevPath.setAttribute('stroke-linecap', 'round');
    chevPath.setAttribute('stroke-linejoin', 'round');
    chevSvg.appendChild(chevPath);
    chevron.appendChild(chevSvg);
    expandToggle.appendChild(expandLabel);
    expandToggle.appendChild(chevron);

    // Expandable wrapper
    const expandWrapper = document.createElement('div');
    expandWrapper.className = 'tldr-expandable-content';

    expandToggle.addEventListener('click', () => {
      deepExpanded = !deepExpanded;
      expandWrapper.classList.toggle('expanded', deepExpanded);
      chevron.classList.toggle('expanded', deepExpanded);
    });

    panel.appendChild(expandToggle);
    panel.appendChild(expandWrapper);

    const pillarsEl = document.createElement('div');
    pillarsEl.className = 'tldr-pillars';

    for (const [key, val] of Object.entries(data.pillars)) {
      const label = PILLAR_LABELS[key] ?? key.replace(/_/g, ' ');
      const row   = document.createElement('div');
      row.className = 'tldr-pillar-row';
      if (val.citation) {
        row.style.cursor = 'pointer';

        // Inline citation quote box (hidden by default, toggled on click)
        const quoteBox = document.createElement('div');
        quoteBox.className = 'tldr-citation-box';
        quoteBox.textContent = `"${val.citation}"`;

        row.addEventListener('click', async (e) => {
          e.stopPropagation();
          const isOpen = quoteBox.style.display === 'block';

          // Accordion: close every other open quote box first.
          // Must query the shadow root, not document â€” document.querySelectorAll
          // cannot pierce Shadow DOM and silently returns nothing.
          const shadowRoot = getUiRoot();
          shadowRoot.querySelectorAll('.tldr-citation-box').forEach(b => {
            if (b !== quoteBox) b.style.display = 'none';
          });

          if (isOpen) {
            // Closing â€” hide box and remove page highlight
            quoteBox.style.display = 'none';
            document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
              const p = el.parentNode;
              p.replaceChild(document.createTextNode(el.textContent), el);
              p.normalize();
            });
          } else {
            // Opening â€” show box, scroll it into view within the panel, then highlight
            quoteBox.style.display = 'block';
            requestAnimationFrame(() => {
              quoteBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
            // M-3: highlightCitation returns true/false; show a miss notice so the
            // user knows the clause text wasn't found verbatim on this page.
            try {
              const isSilence = val.citation === '[NOT_FOUND]' || val.citation === 'Not addressed in document.';
              const found = isSilence ? true : await highlightCitation(val.citation);
              
              if (isSilence) {
                if (!quoteBox.querySelector('.tldr-citation-silence')) {
                  const silenceNote = document.createElement('div');
                  silenceNote.className = 'tldr-citation-silence';
                  silenceNote.textContent = 'This practice is not explicitly mentioned in the document.';
                  silenceNote.style.cssText = 'font-size:10px; color:rgba(255,255,255,0.45); margin-top:6px; font-style:italic; border-top:1px solid rgba(255,255,255,0.05); padding-top:6px;';
                  quoteBox.appendChild(silenceNote);
                }
              } else if (!found) {
                // Only add once per quoteBox
                if (!quoteBox.querySelector('.tldr-citation-miss')) {
                  const missNote = document.createElement('div');
                  missNote.className = 'tldr-citation-miss';
                  missNote.textContent = 'âš  Exact text not found on page â€” may be paraphrased or on another section.';
                  missNote.style.cssText = [
                    'font-size:10px',
                    'color:rgba(255,200,100,0.85)',
                    'margin-top:6px',
                    'line-height:1.4',
                    'font-style:italic',
                  ].join(';');
                  quoteBox.appendChild(missNote);
                }
              }
            } catch (_) {}
          }
        });

        // Append quote box after the row's main content (appended below)
        _quoteBoxMap.set(row, quoteBox);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'tldr-pillar-name-wrap';

      const nameText = document.createElement('span');
      nameText.className = 'tldr-pillar-name';
      nameText.textContent = label;
      nameEl.appendChild(nameText);

      const descText = document.createElement('span');
      descText.className = 'tldr-pillar-desc';
      descText.textContent = PILLAR_DESCS[key] ?? '';
      nameEl.appendChild(descText);

      // Three-state rendering driven by server-provided `status` field:
      //   VIOLATES          â†’ RISKY (red) â€” real violation with verbatim quote
      //   EXPLICITLY_DENIES â†’ SAFE (green) â€” policy affirmatively denies, with quote
      //   NOT_MENTIONED     â†’ OKAY (amber) â€” pillar silent, genuine ambiguity
      // Falls back to legacy violation-only logic if server hasn't set status yet.
      const pConf = (val.confidence || 'MEDIUM').toString().toUpperCase();
      const status = (val.status || '').toString().toUpperCase();
      const isNA   = status === 'NOT_APPLICABLE' || val.applicable === false;
      const isSoftFlag = val.violation && pConf === 'LOW';
      const isRisky    = status === 'VIOLATES' || (val.violation && pConf !== 'LOW');
      const isDenial   = status === 'EXPLICITLY_DENIES';
      const isSilence  = !isNA && (status === 'NOT_MENTIONED' || (!status && !val.violation && !val.citation));
      let statusClass, statusText;
      if (isRisky)        { statusClass = 'risky'; statusText = 'RISKY'; }
      else if (isSoftFlag){ statusClass = 'okay';  statusText = 'OKAY';  }
      else if (isNA)      { statusClass = 'na';    statusText = 'N/A';   }
      else if (isDenial)  { statusClass = 'safe';  statusText = 'SAFE';  }
      else if (isSilence) { statusClass = 'okay';  statusText = 'NOT STATED'; }
      else                { statusClass = 'safe';  statusText = 'SAFE';  }
      const statusEl = document.createElement('span');
      statusEl.className = `tldr-pillar-status ${statusClass}`;
      statusEl.textContent = statusText;

      // Confidence badge â€” shows HIGH/MEDIUM/LOW + numeric score (0â€“100) when
      // server provides confidenceScore (fix #7). Numeric surface gives users
      // a granular trust signal instead of just three buckets.
      const conf = val.confidence; // 'HIGH' | 'MEDIUM' | 'LOW' | undefined
      if (conf && !isNA) {
        const confBadge = document.createElement('span');
        confBadge.className = `tldr-confidence tldr-confidence-${conf.toLowerCase()}`;
        const numeric = (typeof val.confidenceScore === 'number') ? val.confidenceScore : null;
        confBadge.textContent = numeric !== null ? `CONFIDENCE: ${conf} Â· ${numeric}%` : `CONFIDENCE: ${conf}`;
        confBadge.title = conf === 'HIGH' ? 'Explicit verbatim clause found' : conf === 'MEDIUM' ? 'Clause exists but partially ambiguous' : 'Inferred or delegated to external document';
        nameEl.appendChild(confBadge);
      }

      row.appendChild(nameEl);
      row.appendChild(statusEl);

      // Wrap row + quoteBox in a container so quoteBox sits below the row
      if (_quoteBoxMap.has(row)) {
        const wrapper = document.createElement('div');
        wrapper.appendChild(row);
        wrapper.appendChild(_quoteBoxMap.get(row));
        pillarsEl.appendChild(wrapper);
      } else {
        pillarsEl.appendChild(row);
      }
    }

    expandWrapper.appendChild(pillarsEl);

    // â”€â”€ Score deductions (inside expandable, deep scan only) â”€â”€
    if (Array.isArray(data.deductions) && data.deductions.length > 0) {
      const dedEl = document.createElement('div');
      dedEl.className = 'tldr-deductions';

      const dedTitle = document.createElement('div');
      dedTitle.className = 'tldr-deductions-title';
      dedTitle.textContent = 'Why not 100? (\u2212' + (100 - data.score) + ' pts)';
      dedEl.appendChild(dedTitle);

      data.deductions.forEach(d => {
        const row = document.createElement('div');
        row.className = 'tldr-deduction-row';
        const reason = document.createElement('span');
        reason.className = 'tldr-deduction-reason';
        reason.textContent = d.reason;
        const pts = document.createElement('span');
        pts.className = 'tldr-deduction-pts';
        pts.textContent = '\u2212' + d.points + ' pts';
        row.appendChild(reason);
        row.appendChild(pts);
        dedEl.appendChild(row);
      });

      expandWrapper.appendChild(dedEl);
    }
  }

  // â”€â”€ Score deductions outside expandable (quick scan only, when score < 100) â”€â”€
  if (isQuick && Array.isArray(data.deductions) && data.deductions.length > 0) {
    const dedEl = document.createElement('div');
    dedEl.className = 'tldr-deductions';

    const dedTitle = document.createElement('div');
    dedTitle.className = 'tldr-deductions-title';
    dedTitle.textContent = `Why not 100? (âˆ’${100 - data.score} pts)`;
    dedEl.appendChild(dedTitle);

    data.deductions.forEach(d => {
      const row = document.createElement('div');
      row.className = 'tldr-deduction-row';
      const reason = document.createElement('span');
      reason.className = 'tldr-deduction-reason';
      reason.textContent = d.reason;
      const pts = document.createElement('span');
      pts.className = 'tldr-deduction-pts';
      pts.textContent = `âˆ’${d.points} pts`;
      row.appendChild(reason);
      row.appendChild(pts);
      dedEl.appendChild(row);
    });

    panel.appendChild(dedEl);
  }

  // â”€â”€ Report incorrect result button â”€â”€
  const reportBtn = document.createElement('button');
  reportBtn.className = 'tldr-report-btn';
  reportBtn.setAttribute('aria-label', 'Report incorrect result');
  reportBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 1v4M5 8v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Report incorrect result`;
  reportBtn.addEventListener('click', () => {
    if (reportBtn.classList.contains('tldr-reported')) return;
    reportBtn.textContent = 'Sendingâ€¦';
    reportBtn.disabled = true;
    const payload = {
      url:    location.href,
      rating: data.rating,
      score:  data.score,
      pillars: data.pillars ? Object.fromEntries(
        Object.entries(data.pillars).map(([k, v]) => [k, { violation: v.violation, confidence: v.confidence }])
      ) : null,
      requestId: data.requestId ?? null,
      userAgent: navigator.userAgent.slice(0, 120),
    };
    // Use stored API URL base (same as analyze endpoint)
    getReportUrl((base) => {
      const sendReport = async (token) => {
        const response = await fetch(base + '/api/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          let message = `HTTP ${response.status}`;
          try {
            const err = await response.json();
            if (err && typeof err.error === 'string') message = err.error;
          } catch (_) {}
          throw new Error(message);
        }
      };

      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['authToken', 'authTokenExpiry'], ({ authToken, authTokenExpiry }) => {
          const validToken = authToken && authTokenExpiry > Date.now() ? authToken : null;
          if (!validToken) {
            reportBtn.textContent = 'Sign in to report';
            reportBtn.disabled = false;
            return;
          }
          sendReport(validToken)
            .then(() => {
              reportBtn.textContent = "\u2713 Thanks \u2014 we'll review it";
              reportBtn.classList.add('tldr-reported');
              reportBtn.disabled = false;
            })
            .catch(() => {
              reportBtn.textContent = 'Could not send report';
              reportBtn.disabled = false;
            });
        });
      } else {
        sendReport(null)
          .then(() => {
            reportBtn.textContent = "\u2713 Thanks \u2014 we'll review it";
            reportBtn.classList.add('tldr-reported');
            reportBtn.disabled = false;
          })
          .catch(() => {
            reportBtn.textContent = 'Could not send report';
            reportBtn.disabled = false;
          });
      }
    }); // getReportUrl callback
  });   // reportBtn click
  panel.appendChild(reportBtn);

  // â”€â”€ Footer â”€â”€
  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield Â· AI Privacy Analysis';
  panel.appendChild(footer);

  // â”€â”€ Close button â”€â”€
  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = getUiElement('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  // â”€â”€ Degraded banner â€” AI unavailable, this is a regex-based fallback â”€â”€
  if (isDegraded) {
    const banner = document.createElement('div');
    banner.style.cssText = 'margin:10px 12px 0; padding:10px 12px; background:rgba(197,157,60,0.12); border:1px solid rgba(197,157,60,0.45); border-radius:8px; color:#e6c679; font-size:11px; line-height:1.45; letter-spacing:0.02em;';
    const strong = document.createElement('strong');
    strong.style.color = '#f0d288';
    strong.textContent = 'Offline scan';
    banner.appendChild(strong);
    banner.appendChild(document.createTextNode(' \u00b7 AI quota temporarily exhausted. Results below are from pattern-based analysis. Re-scan in a few minutes for full AI verdict.'));
    // Insert banner right after the header (before body content)
    panel.insertBefore(banner, panel.children[1] || null);
  }

  getUiRoot().appendChild(panel);

  // H-2: Use shared drag utility instead of duplicated inline drag logic
  _attachPanelDrag(panel, header, closeBtn);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MESSAGE LISTENER â€” receives results from background.js AND popup requests
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') { sendResponse({ ok: true }); return; }
  if (message.type === 'GET_LEGAL_LINKS') {
    const LEGAL_KEYWORDS = /privacy|terms|cookie|cookies|legal|conditions|gdpr|data.protection|policy|policies|tos|eula|disclaimer/i;
    const links = [];
    const seen = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = (a.textContent || a.title || '').trim();
      if (!href || seen.has(href)) return;
      // Only absolute URLs on the same origin or starting with http
      if (!href.startsWith('http')) return;
      // Skip the current page itself
      if (href === location.href) return;
      if (LEGAL_KEYWORDS.test(href) || LEGAL_KEYWORDS.test(text)) {
        seen.add(href);
        links.push({ url: href, text: text.slice(0, 60) || 'Legal link' });
      }
    });
    sendResponse({ links: links.slice(0, 10) }); // max 10
    return true;
  }

  // FIX #9: Popup requests text extraction through the content script so it
  // benefits from Agent 2's smart extraction (modal, semantic, pagination)
  // instead of the popup doing a raw document.body.innerText grab.
  if (message.type === 'EXTRACT_FOR_POPUP') {
    extractPageText()
      .then(text => sendResponse({ text }))
      .catch(() => sendResponse({ text: document.body?.textContent?.trim() ?? '' }));
    return true; // keep message channel open for async response
  }

  if (message.type === 'FORCE_RESCAN') {
    extractPageText()
      .then(text => {
        if (text) {
          chrome.runtime.sendMessage({
            type: 'ANALYZE_TEXT',
            text,
            url: window.location.href,
            forceRefresh: true,
          });
        }
      })
      .catch(() => {});
    return false;
  }

  if (message.type === 'ANALYSIS_PROGRESS') {
    // Update the skeleton/progress panel that was shown at scan start
    updateProgressPanel(message.status);
    return;
  }

  if (message.type === 'OUT_OF_CREDITS') {
    const triggerBtn = getUiElement('tldr-shield-trigger');
    if (triggerBtn) setTriggerIdle(triggerBtn);
    showOutOfCreditsPanel(message.resetDate || 'the 1st of next month');
    return;
  }

  if (message.type !== 'ANALYSIS_RESULT') return;

  const btn = getUiElement('tldr-shield-trigger');

  if (message.error) {
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
    showErrorPanel(message.error || 'Analysis failed. Please try again.', location.href);
    return;
  }

  if (btn) btn.style.display = 'none';
  showResultPanel(message.data);
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BOOTSTRAP â€” run Agent 1 on page load + watch for SPA navigation
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let lastCheckedUrl = '';

function runDetection() {
  if (isBlockedHost()) return;

  const currentUrl = window.location.href;
  if (currentUrl === lastCheckedUrl) return;
  lastCheckedUrl = currentUrl;

  removeTriggerButton();
  removeResultPanel();

  // Safety check: ensure the extension context is still valid (not reloaded/uninstalled)
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage) return;

  chrome.storage.local.get({ disabledAll: false, disabledSites: [] }, ({ disabledAll, disabledSites }) => {
    if (chrome.runtime.lastError) return;
    if (disabledAll || disabledSites.includes(location.hostname)) return;

    const isPdf = document.contentType === 'application/pdf' ||
      /\.pdf(\?.*)?$/i.test(location.href) ||
      document.querySelector('embed[type="application/pdf"]') !== null;

    const { score, reasons } = computeConfidence();
    
    console.log(`[TLDR Shield] Detection check for ${location.hostname}${location.pathname} - Score: ${score}/100, Signals: ${reasons.join(', ')}`);

    // FIX: If it's a high-confidence legal URL path, show it immediately.
    // Otherwise, wait for the page to settle (especially for dynamic/SPA content).
    const isHighConfPath = reasons.includes('url');
    const delay = isPdf || isHighConfPath ? 100 : 1200;

    setTimeout(() => {
      // Re-verify after delay to ensure elements didn't change (especially for SPAs)
      const finalConf = computeConfidence();
      if (isPdf || finalConf.score >= CONFIDENCE_THRESHOLD) {
        createTriggerButton();
      }
    }, delay);
  });
}

// Initial page load: check quickly
if (document.readyState === 'complete') {
  runDetection();
} else {
  window.addEventListener('load', runDetection, { once: true });
}

// Smart Detection: re-run detection when SPA routes change or significant content shifts
let mutationTimer = null;
let lastDetectedUrl = '';

const observer = new MutationObserver((mutations) => {
  if (location.href === lastDetectedUrl && getUiElement('tldr-shield-trigger')) {
    return; // Already detected on this exact URL, don't thrash
  }
  
  // Check if any significant nodes were added
  let significant = false;
  for (const mod of mutations) {
    if (mod.addedNodes.length > 0) {
      significant = true;
      break;
    }
  }
  
  if (significant) {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      lastDetectedUrl = location.href;
      runDetection();
    }, 1200); // Relaxed debounce for production performance
  }
});

// Initial observer setup
// childList:true watches for added/removed children at document.body level only.
// subtree:true was removed â€” it fires synchronously on every DOM mutation across
// the entire page (including animations, carousels, counters), which creates a
// non-trivial perf tax on animation-heavy SPAs. SPA navigation always involves
// a body-level child change (route container swap), so childList is sufficient.
if (document.body) {
  observer.observe(document.body, { childList: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true });
  });
}

// Disconnect observer on page unload
window.addEventListener('pagehide', () => {
  observer.disconnect();
  clearTimeout(mutationTimer);
}, { once: true });

// Listen for SPA navigation events
window.addEventListener('popstate', () => {
  lastDetectedUrl = ''; // Force re-detection on URL change
  setTimeout(runDetection, 600);
});
window.addEventListener('hashchange', () => {
  lastDetectedUrl = '';
  setTimeout(runDetection, 600);
});


// Auth token bridge is now in bridge.js (loaded via manifest.json).

