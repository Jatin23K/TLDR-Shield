// ── TLDR Shield – Content Script ──────────────────────────────────────────────
// Multi-agent pipeline (browser side):
//   Agent 1 → detect T&C presence (this file)
//   Agent 2 → extract + clean text (this file)
//   Agent 3 → send to server for analysis (background.js)
//   Agent 4 → aggregate + display result (this file)

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1 — T&C DETECTION ENGINE
// Uses multi-signal confidence scoring instead of naive body-text scan.
// Only fires the trigger button when confidence is HIGH enough.
// ─────────────────────────────────────────────────────────────────────────────

// Signal weights (summed → confidence score 0-100)
const SIGNALS = {
  URL_PATH:       40,  // /terms, /privacy, /tos, /eula in URL path
  PAGE_TITLE:     25,  // legal keyword in <title>
  H1_HEADING:     20,  // h1 contains legal keyword
  H2_HEADING:     15,  // h2 contains legal keyword
  MODAL_PRESENT:  30,  // visible modal/dialog with legal keyword
  COOKIE_BANNER:  20,  // cookie consent overlay detected
  META_TAG:       10,  // og:type or meta description mentions legal
};

const CONFIDENCE_THRESHOLD = 30; // minimum score to show the trigger button

// Resolves the backend base URL from chrome.storage (key: apiUrl).
// Falls back to empty string — callers must handle the empty case.
function getReportUrl(cb) {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get({ apiUrl: '' }, ({ apiUrl }) => {
      cb((apiUrl || '').replace(/\/api\/analyze$/, ''));
    });
  } else {
    cb('');
  }
}

const LEGAL_URL_PATTERNS = [
  /\/terms[-_]?(of[-_]?(service|use))?/i,
  /\/privacy[-_]?(policy)?/i,
  /\/tos\b/i,
  /\/eula\b/i,
  /\/legal\b/i,
  /\/user[-_]?agreement/i,
  /\/cookie[-_]?(policy)?/i,
  /\/data[-_]?(protection|processing)/i,
  /\/acceptable[-_]?use/i,
];

const LEGAL_KEYWORDS = [
  'terms of service', 'terms and conditions', 'privacy policy',
  'user agreement', 'end user license', 'eula', 'cookie policy',
  'data processing', 'acceptable use', 'legal notice',
  'by using this service', 'by accepting these terms',
];

// Hosts where we never trigger (financial — false positive risk too high)
const BLOCKED_HOSTS = [
  'paypal', 'stripe', 'bank', 'trading', 'invest', 'crypto',
  'gambling', 'casino', 'betting', 'forex', 'brokerage',
];

// Common cookie consent SDK selectors (OneTrust, Cookiebot, Osano, etc.)
const COOKIE_BANNER_SELECTORS = [
  '#onetrust-banner-sdk', '#cookiebanner', '#cookie-banner',
  '#cookie-consent', '.cookie-consent', '.cookie-notice',
  '[id*="cookie"][id*="consent"]', '[class*="cookie"][class*="consent"]',
  '[aria-label*="cookie"]', '[aria-label*="Cookie"]',
  '#CybotCookiebotDialog', '.cc-window', '#osano-cm-dom-info-dialog-open',
];

function isBlockedHost() {
  const host = window.location.hostname.toLowerCase();
  return BLOCKED_HOSTS.some(b => host.includes(b));
}

function hasLegalKeyword(text) {
  const lower = text.toLowerCase();
  return LEGAL_KEYWORDS.some(kw => lower.includes(kw));
}

function computeConfidence() {
  let score = 0;
  const reasons = [];

  // Signal 1: URL path
  const path = window.location.pathname + window.location.search;
  if (LEGAL_URL_PATTERNS.some(rx => rx.test(path))) {
    score += SIGNALS.URL_PATH;
    reasons.push('url');
  }

  // Signal 2: Page title
  if (hasLegalKeyword(document.title)) {
    score += SIGNALS.PAGE_TITLE;
    reasons.push('title');
  }

  // Signal 3: H1 heading
  const h1s = Array.from(document.querySelectorAll('h1'));
  if (h1s.some(h => hasLegalKeyword(h.innerText || ''))) {
    score += SIGNALS.H1_HEADING;
    reasons.push('h1');
  }

  // Signal 4: H2 heading (only if not already maxed)
  if (score < 60) {
    const h2s = Array.from(document.querySelectorAll('h2'));
    if (h2s.some(h => hasLegalKeyword(h.innerText || ''))) {
      score += SIGNALS.H2_HEADING;
      reasons.push('h2');
    }
  }

  // Signal 5: Visible modal / dialog with legal text
  const modals = document.querySelectorAll(
    'dialog[open], [role="dialog"], [role="alertdialog"], .modal, .overlay, [class*="modal"], [class*="dialog"]'
  );
  for (const m of modals) {
    const style = window.getComputedStyle(m);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    if (visible && hasLegalKeyword(m.innerText || '')) {
      score += SIGNALS.MODAL_PRESENT;
      reasons.push('modal');
      break;
    }
  }

  // Signal 6: Cookie consent banner
  const hasBanner = COOKIE_BANNER_SELECTORS.some(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (hasBanner) {
    score += SIGNALS.COOKIE_BANNER;
    reasons.push('cookie-banner');
  }

  // Signal 7: Meta description / og:description
  const metas = document.querySelectorAll('meta[name="description"], meta[property="og:description"]');
  for (const m of metas) {
    if (hasLegalKeyword(m.getAttribute('content') || '')) {
      score += SIGNALS.META_TAG;
      reasons.push('meta');
      break;
    }
  }

  return { score, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2 — TEXT EXTRACTION
// Handles 4 real-world T&C formats:
//   Form 1 → Full page (all in DOM)           — extractSemanticText()
//   Form 2 → Paginated ("Next Page" links)    — fetchPaginatedPages()
//   Form 3 → Virtual / lazy scroll            — scrollAndCollect()
//   Form 4 → Modal with inner scroll container — extractModalScrollContent()
// Entry point: extractPageText() — async, returns clean combined text.
// ─────────────────────────────────────────────────────────────────────────────

// Selectors for semantic content containers (Form 1)
const SEMANTIC_SELECTORS = [
  'main', 'article', '[role="main"]',
  '.terms', '.privacy', '.legal', '.policy',
  '.content', '#content', '.main-content', '#main-content',
  '.page-content', '.post-content', '.entry-content',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanText(raw) {
  return raw
    .replace(/\n{3,}/g, '\n\n')           // collapse 3+ blank lines → 2
    .replace(/[ \t]{4,}/g, '   ')         // collapse long whitespace runs
    .replace(/^(Home|About|Contact|Sign in|Log in|Sign up|Menu|Search)\s*$/gim, '')
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns true if element is visually scrollable vertically
function isScrollable(el) {
  const style = window.getComputedStyle(el);
  const overflow = style.overflowY;
  const hasScroll = overflow === 'scroll' || overflow === 'auto';
  return hasScroll && el.scrollHeight > el.clientHeight + 40;
}

// ── Form 4: Modal with inner scrollable div ──────────────────────────────────
// Problem: T&C inside a signup modal is in a <div style="overflow-y:scroll">
//          innerText only gives visible text; we need scrollHeight content.
// Fix:     Find the scrollable child container, read its full innerHTML,
//          then programmatically scroll it so any lazy-rendered chunks appear.

async function extractModalScrollContent() {
  const modalSelectors = [
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[class*="modal"]',
    '[class*="overlay"]',
    '[class*="popup"]',
  ];

  for (const sel of modalSelectors) {
    const modal = document.querySelector(sel);
    if (!modal) continue;

    const style = window.getComputedStyle(modal);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    // Find the scrollable container inside the modal
    const allChildren = modal.querySelectorAll('*');
    let scrollContainer = null;
    for (const child of allChildren) {
      if (isScrollable(child)) {
        scrollContainer = child;
        break;
      }
    }

    const target = scrollContainer || modal;
    const initialText = target.innerText?.trim() ?? '';
    if (!initialText || !hasLegalKeyword(initialText)) continue;

    // Scroll the container to the bottom in steps to trigger lazy rendering.
    // Hard cap of 5 seconds total to avoid stalling extraction on misbehaving modals.
    if (isScrollable(target)) {
      const totalHeight = target.scrollHeight;
      const step = Math.max(300, Math.floor(target.clientHeight * 0.8));
      const scrollDeadline = Date.now() + 5000;
      let pos = 0;
      while (pos < totalHeight && Date.now() < scrollDeadline) {
        target.scrollTop = pos;
        pos += step;
        await sleep(120); // allow lazy content to render
      }
      // Scroll back to top so user sees the page normally
      target.scrollTop = 0;
    }

    const fullText = target.innerText?.trim() ?? '';
    if (fullText.length > 200) return fullText;
  }
  return null;
}

// ── Form 3: Virtual / lazy-scroll full page ──────────────────────────────────
// Problem: Some T&C pages use JS-driven rendering (React-window, Intersection
//          Observer reveals). Text isn't in DOM until you scroll to it.
// Fix:     Auto-scroll window in steps, collect new text after each step,
//          stop when no new content appears (convergence) or cap is reached.

async function scrollAndCollect() {
  const MAX_SCROLL_TIME_MS = 5000;
  const STEP_PX            = 600;
  const SETTLE_MS          = 150;
  const MAX_CHARS          = 120000;

  // FIX #11: Save user's current scroll position and restore it after — no disruption.
  // Also disable smooth-scroll temporarily so jumps are instant and invisible.
  const savedScrollY = window.scrollY;
  const htmlEl = document.documentElement;
  const savedScrollBehavior = htmlEl.style.scrollBehavior;
  htmlEl.style.scrollBehavior = 'auto';

  const start       = Date.now();
  let   lastLen     = 0;
  let   stableRounds = 0;

  try {
    while (Date.now() - start < MAX_SCROLL_TIME_MS) {
      htmlEl.scrollTop += STEP_PX;
      await sleep(SETTLE_MS);

      const currentLen = document.body.textContent?.length ?? 0;

      if (currentLen === lastLen) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      lastLen = currentLen;

      const atBottom = (htmlEl.scrollTop + window.innerHeight) >= htmlEl.scrollHeight - 50;
      if (atBottom) break;
      if (currentLen > MAX_CHARS) break;
    }
  } finally {
    // Always restore position and scroll style — even if an error occurs
    htmlEl.style.scrollBehavior = savedScrollBehavior;
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }

  return document.body.textContent?.trim() ?? '';
}

// ── Form 2: Paginated T&C ("Next Page" / "Page 2" links) ─────────────────────
// Problem: T&C split across /terms/1, /terms/2 … only Page 1 is in DOM.
// Fix:     Detect pagination links, fetch each page via fetch(), parse HTML
//          with DOMParser, extract text, concatenate all pages.

const PAGINATION_PATTERNS = [
  /next\s*(page)?/i,
  /page\s*\d+/i,
  /continue\b/i,
  />\s*$/,           // bare ">" arrow links
  /→|»/,
];

function findNextPageLink(baseUrl) {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const parser = new URL(baseUrl);

  for (const link of links) {
    const text = link.innerText?.trim() ?? '';
    const href = link.href;

    if (!href || href === baseUrl) continue;
    if (!href.startsWith(parser.origin)) continue; // same-origin only
    if (href.includes('#')) continue;              // skip anchors

    const isNextLink = PAGINATION_PATTERNS.some(rx => rx.test(text));
    const isPageNum  = /[?&]page=\d+/i.test(href) || /\/\d+\/?$/.test(new URL(href).pathname);

    if (isNextLink || isPageNum) return href;
  }
  return null;
}

async function fetchPaginatedPages(firstPageText) {
  const MAX_PAGES   = 8;   // never follow more than 8 pagination links
  const visited     = new Set([window.location.href]);
  const pages       = [firstPageText];
  const parser      = new DOMParser();

  let nextUrl = findNextPageLink(window.location.href);

  while (nextUrl && pages.length < MAX_PAGES && !visited.has(nextUrl)) {
    visited.add(nextUrl);

    try {
      const pageController = new AbortController();
      const pageTimeout = setTimeout(() => pageController.abort(), 8000);
      let res;
      try {
        res = await fetch(nextUrl, { credentials: 'omit', signal: pageController.signal });
      } finally {
        clearTimeout(pageTimeout);
      }
      if (!res.ok) break;

      const html = await res.text();
      const doc  = parser.parseFromString(html, 'text/html');

      // FIX #5: Use textContent, not innerText, on DOMParser nodes.
      // innerText requires a live layout engine — detached DOM nodes have no layout,
      // so innerText returns empty string. textContent always works on any DOM node.
      let pageText = '';
      for (const sel of SEMANTIC_SELECTORS) {
        const el = doc.querySelector(sel);
        const t = el?.textContent?.trim() ?? '';
        if (t.length > 300) { pageText = t; break; }
      }
      if (!pageText) pageText = doc.body?.textContent?.trim() ?? '';

      if (pageText.length > 100) {
        pages.push(pageText);
        console.debug(`[TLDR Shield] Fetched page ${pages.length}: ${nextUrl}`);
      }

      // Look for next link inside fetched document
      const tempDiv = doc.body;
      const nextLinks = Array.from(tempDiv.querySelectorAll('a[href]'));
      nextUrl = null;
      for (const link of nextLinks) {
        const text = link.textContent?.trim() ?? '';  // textContent on parsed DOM
        const href = link.href;
        if (!href || visited.has(href)) continue;
        if (PAGINATION_PATTERNS.some(rx => rx.test(text))) {
          nextUrl = href;
          break;
        }
      }
    } catch {
      break; // network error → stop paginating
    }
  }

  if (pages.length > 1) {
    console.debug(`[TLDR Shield] Collected ${pages.length} pages of T&C`);
  }

  return pages.join('\n\n--- [Page Break] ---\n\n');
}

// ── Form 1: Semantic container (standard full-page T&C) ─────────────────────

function extractSemanticText() {
  for (const sel of SEMANTIC_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && (el.innerText?.trim().length ?? 0) > 500) {
      return el.innerText.trim();
    }
  }
  return null;
}

// ── Readability extraction — strips nav/ads/banners, returns clean legal text ─
// @mozilla/readability is loaded before this file in manifest.json (lib/Readability.js)
function extractWithReadability() {
  try {
    if (typeof Readability === 'undefined') return null;
    // Clone the document so Readability's DOM surgery doesn't affect the live page
    const docClone = document.cloneNode(true);
    const article  = new Readability(docClone, {
      charThreshold: 300,         // minimum text chars to accept as content
      keepClasses:   false,       // strip class noise
      nbTopCandidates: 10,
    }).parse();
    if (!article?.textContent) return null;
    const text = article.textContent.trim();
    // Sanity check: must be substantial (>800 chars) to trust over fallbacks
    return text.length >= 800 ? text : null;
  } catch (_) {
    return null;
  }
}

// ── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
// Priority order:
//   0. Readability — best signal/noise ratio for standard web pages
//   1. Modal scroll content (Form 4) — visible T&C modals
//   2. Semantic container → check for pagination (Form 1 + 2)
//   3. Virtual scroll detection (Form 3) — only if body seems short
//   4. Raw body fallback

async function extractPageText() {
  // Form 4: visible modal with scrollable T&C (checked before Readability —
  // Readability ignores hidden/overflow elements that modals render)
  const modalText = await extractModalScrollContent();
  if (modalText) return cleanText(modalText);

  // Form 0: Readability — strips nav, ads, cookie banners, sidebars
  const readabilityText = extractWithReadability();
  if (readabilityText) return cleanText(readabilityText);

  // Form 1: standard semantic container
  const semanticText = extractSemanticText();
  if (semanticText) {
    // Form 2: check if this page is paginated
    const nextLink = findNextPageLink(window.location.href);
    if (nextLink) {
      const paginated = await fetchPaginatedPages(semanticText);
      return cleanText(paginated);
    }
    return cleanText(semanticText);
  }

  // Form 3: body text suspiciously short → might be virtual-scroll
  const bodyText = document.body.innerText?.trim() ?? '';
  const bodyIsShort = bodyText.length < 3000;
  const looksLikeScrollPage = LEGAL_URL_PATTERNS.some(rx => rx.test(window.location.pathname));

  if (bodyIsShort && looksLikeScrollPage) {
    const scrolled = await scrollAndCollect();
    if (scrolled.length > bodyText.length + 500) return cleanText(scrolled);
  }

  // Fallback: full body (server will chunk if needed)
  const fallback = bodyText || (document.body.innerText ? document.body.innerText.trim() : '');
  return cleanText(fallback);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER BUTTON — shown when confidence ≥ threshold
// ─────────────────────────────────────────────────────────────────────────────

// Shield icon SVG
const SHIELD_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L4 6V12C4 16.4 7.4 20.5 12 22C16.6 20.5 20 16.4 20 12V6L12 2Z" fill="#38bdf8"/>
  <path d="M9 12L11 14L15 10" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function setTriggerIdle(btn) {
  btn.dataset.scanning = 'false';
  btn.innerHTML = SHIELD_SVG;
  btn.title = 'Analyze with TLDR Shield';
}

function setTriggerScanning(btn) {
  btn.dataset.scanning = 'true';
  btn.innerHTML = '<div class="tldr-spinner"></div>';
  btn.title = 'Analyzing…';
}

function removeContextMenu() {
  document.getElementById('tldr-context-menu')?.remove();
}

function showContextMenu(x, y) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'tldr-context-menu';
  // Render off-screen first to measure real size
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
  document.body.appendChild(menu);

  // Measure then reposition so it never clips off screen
  const mw = menu.offsetWidth  || 210;
  const mh = menu.offsetHeight || 90;
  const left = (x + mw > window.innerWidth)  ? x - mw : x;
  const top  = (y + mh > window.innerHeight) ? y - mh : y;
  menu.style.left       = Math.max(4, left) + 'px';
  menu.style.top        = Math.max(4, top)  + 'px';
  menu.style.visibility = 'visible';

  // Close on outside click
  setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 0);
}

function snapBtn(btn, side, top) {
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
  if (document.getElementById('tldr-shield-trigger')) return;

  const btn = document.createElement('div');
  btn.id = 'tldr-shield-trigger';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Analyze with TLDR Shield');
  setTriggerIdle(btn);
  // Hide until position is known — prevents flash at wrong location
  btn.style.visibility = 'hidden';
  btn.style.cursor = 'pointer';
  document.body.appendChild(btn);

  // ── Restore saved position then reveal ───────────────────────────────────
  chrome.storage.local.get({ fabSide: 'right', fabTop: 180 }, ({ fabSide, fabTop }) => {
    snapBtn(btn, fabSide, fabTop);
    btn.style.visibility = 'visible';
  });

  // ── Drag logic (pointer capture — works across all browsers/pages) ──────
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
    // Only enter drag mode after moving ≥6px — avoids grab cursor on plain click
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
    if (!btn.hasPointerCapture(e.pointerId)) return;
    btn.releasePointerCapture(e.pointerId);
    btn.classList.remove('tldr-dragging');
    btn.style.cursor = 'pointer';
    if (dragging) {
      const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      const top  = parseInt(btn.style.top);
      snapBtn(btn, side, top);
      chrome.storage.local.set({ fabSide: side, fabTop: top });
    }
    dragging = false;
  });

  // ── Click to scan (only if not dragged) ──────────────────────────────────
  btn.addEventListener('click', async () => {
    if (moved) { moved = false; return; }
    if (btn.dataset.scanning === 'true') return;
    setTriggerScanning(btn);
    // Show skeleton immediately so user sees feedback right away
    showSkeletonPanel();
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
      const text = await extractPageText();
      lastScanText = text;
      lastScanUrl  = location.href;
      // keepalive port ensures the service worker stays alive for the full scan
      const _port = chrome.runtime.connect({ name: 'keepalive' });
      void _port;
      chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text, url: location.href });
    } catch (err) {
      // "Extension context invalidated" = extension was reloaded but this tab still
      // has the old content script. Show a friendly reload prompt instead of silent fail.
      if (err?.message?.includes('Extension context invalidated') ||
          err?.message?.includes('context invalidated')) {
        setTriggerIdle(btn);
        btn.title = 'Extension updated — please refresh this page (F5)';
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
        toast.textContent = '⟳ Extension updated — refresh this page to scan';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
        return;
      }
      setTriggerIdle(btn);
      showErrorPanel('Failed to extract page text. Please try refreshing the page.', location.href);
    }
  });

  // ── Right-click context menu ──────────────────────────────────────────────
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });
}

function removeTriggerButton() {
  document.getElementById('tldr-shield-trigger')?.remove();
  removeContextMenu();
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 4 — RESULT PANEL
// Handles both Quick (badge-only) and Deep (full pillars) results.
// Quick result shows a "Run Deep Scan →" button.
// Loading states: skeleton → step-by-step progress → result
// ─────────────────────────────────────────────────────────────────────────────

// ── Module-level scan state ───────────────────────────────────────────────────
// Captured before each scan so the "Run Deep Scan →" button can re-use them.
let lastScanText = '';
let lastScanUrl  = '';

// ── Progress step mapping ─────────────────────────────────────────────────────
const PROGRESS_STEPS = [
  { key: 'step1', label: 'Reading document...',          triggers: ['chunk', 'read', 'extract'] },
  { key: 'step2', label: 'Analyzing privacy pillars...', triggers: ['analyz', 'pillar', 'llm'] },
  { key: 'step3', label: 'Grounding citations...',       triggers: ['ground', 'citation', 'embed'] },
  { key: 'step4', label: 'Computing final score...',     triggers: ['scor', 'aggregat', 'complet'] },
];

// Tracks which progress steps have been reached
let _progressState = { currentStep: -1 };

function _progressStepIndex(status) {
  if (!status) return -1;
  const s = status.toLowerCase();
  return PROGRESS_STEPS.findIndex(step => step.triggers.some(t => s.includes(t)));
}

function removeResultPanel() {
  document.getElementById('tldr-shield-result')?.remove();
  // Clean up any citation highlights
  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

// ── Skeleton panel — shown immediately when scan starts ──────────────────────
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
  closeBtn.textContent = '\u2715';
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
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  document.body.appendChild(panel);
  _attachPanelDrag(panel, header, closeBtn);
}

// ── Progress update — transitions skeleton → step list ───────────────────────
function updateProgressPanel(status) {
  const panel = document.getElementById('tldr-shield-result');
  if (!panel) return;

  let stepsContainer = panel.querySelector('#tldr-progress-steps');
  if (!stepsContainer) {
    // Remove skeleton body, replace with real step list
    panel.querySelector('#tldr-skeleton-body')?.remove();
    stepsContainer = document.createElement('div');
    stepsContainer.id = 'tldr-progress-steps';
    stepsContainer.className = 'tldr-progress-steps';
    PROGRESS_STEPS.forEach((step) => {
      const row = document.createElement('div');
      row.className = 'tldr-progress-step';
      row.id = 'tldr-step-' + step.key;
      const icon = document.createElement('div');
      icon.className = 'tldr-step-icon';
      icon.id = 'tldr-step-icon-' + step.key;
      const text = document.createElement('span');
      text.className = 'tldr-step-text';
      text.textContent = step.label;
      row.appendChild(icon);
      row.appendChild(text);
      stepsContainer.appendChild(row);
    });
    panel.appendChild(stepsContainer);
  }

  const stepIdx = _progressStepIndex(status);
  if (stepIdx < 0) return;
  if (stepIdx <= _progressState.currentStep) return; // monotonic — skip if already at or past this step

  PROGRESS_STEPS.forEach((step, i) => {
    const row  = stepsContainer.querySelector('#tldr-step-' + step.key);
    const icon = stepsContainer.querySelector('#tldr-step-icon-' + step.key);
    if (!row || !icon) return;
    while (icon.firstChild) icon.removeChild(icon.firstChild);
    if (i < stepIdx) {
      row.className = 'tldr-progress-step tldr-step-done';
      icon.textContent = '\u2713';
    } else if (i === stepIdx) {
      row.className = 'tldr-progress-step tldr-step-active';
      const sp = document.createElement('div');
      sp.className = 'tldr-step-spinner';
      icon.appendChild(sp);
    } else {
      row.className = 'tldr-progress-step';
    }
  });

  _progressState.currentStep = stepIdx;
}

// ── Shared panel drag setup ───────────────────────────────────────────────────
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
// ── Citation highlighting using mark.js ──────────────────────────────────────
// mark.js (lib/mark.min.js loaded before this file) handles:
//   - Text split across inline DOM elements (<strong>, <em>, <span>, <a>)
//   - React/Vue rendered content (reconciles text node fragments)
//   - Case-insensitive, diacritic-insensitive matching
//   - Shadow DOM traversal via iframes option
//
// Strategy:
//   1. Try full citation verbatim (most accurate)
//   2. Try longest prefix slices (60, 40 chars)
//   3. Try longest 8→5 word windows (handles partial paraphrase survival)
//   Each attempt is case-insensitive, partial accuracy mode.

// The scope for mark.js — everything except our own injected UI
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

  // Build ordered candidates — most specific first
  const candidates = [];

  // 1. Full citation
  candidates.push(clean);

  // 2. Prefix slices (longest → shortest)
  for (const len of [80, 60, 40, 25]) {
    const s = clean.slice(0, len).trim();
    if (s.length >= 20 && s !== clean) candidates.push(s);
  }

  // 3. Sliding word windows (8→5 words)
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

// ── Error panel ───────────────────────────────────────────────────────────────
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
    const trigBtn = document.getElementById('tldr-shield-trigger');
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

  body.appendChild(iconEl);
  body.appendChild(msgEl);
  body.appendChild(retryBtn);

  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield \u00b7 AI Privacy Analysis';

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  document.body.appendChild(panel);
  _attachPanelDrag(panel, header, closeBtn);
}

// ── Out-of-credits panel ──────────────────────────────────────────────────────
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
  iconEl.textContent = '\u26a1'; // ⚡

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
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  document.body.appendChild(panel);
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

function showResultPanel(data) {
  removeResultPanel();
  injectFonts();

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

  // ── Header ──
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
  closeBtn.textContent = '✕';

  header.appendChild(brand);
  header.appendChild(closeBtn);

  // ── Rating badge with score ring ──
  const badge = document.createElement('div');
  const isExtremeRisk = data.rating === 'RISKY' && score !== null && score <= 15;
  badge.className = `tldr-rating-badge ${ratingClass}${isExtremeRisk ? ' tldr-extreme' : ''}`;

  // Left: animated SVG ring showing score percentage
  const ringWrap = document.createElement('div');
  ringWrap.className = 'tldr-score-ring-wrap';
  const ringEl = document.createElement('div');
  ringEl.className = 'tldr-score-ring';
  const CIRCUMFERENCE = 201.06; // 2π × 32
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
  ratingLabel.textContent = isExtremeRisk ? 'EXTREME RISK' : (data.rating ?? 'UNKNOWN');

  const ratingMeta = document.createElement('div');
  ratingMeta.className = 'tldr-rating-score';
  if (data.cached) {
    ratingMeta.textContent = 'Cached result';
  } else if (data.chunked) {
    ratingMeta.textContent = `${data.chunkCount}-block analysis`;
  } else if (isQuick) {
    ratingMeta.textContent = 'Quick scan';
  } else {
    ratingMeta.textContent = 'Deep scan';
  }

  // Violation count pill
  if (!isQuick && data.pillars) {
    const vCount = Object.values(data.pillars).filter(p => p.violation).length;
    const totalP = Object.keys(data.pillars).length;
    const vPill  = document.createElement('div');
    vPill.className = 'tldr-violation-count';
    vPill.textContent = vCount === 0 ? `${totalP}/${totalP} clear` : `${vCount} violation${vCount > 1 ? 's' : ''}`;
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

  // ── Truncation warning — FIX #19: show exactly how much was skipped ──
  if (data.truncated) {
    const warn = document.createElement('div');
    warn.className = 'tldr-truncation-warning';
    const pct = data.truncatedPercent ? ` (${data.truncatedPercent}% skipped)` : '';
    warn.textContent = `⚠️ Document too large — first 80,000 characters analyzed${pct}.`;
    panel.appendChild(warn);
  }

  // ── TLDR Summary ──
  if (data.tldr) {
    const tldrEl = document.createElement('div');
    tldrEl.className = 'tldr-tldr';
    tldrEl.textContent = '"' + data.tldr + '"';
    panel.appendChild(tldrEl);
  }

  // ── Run Deep Scan button (quick scan only) ──
  if (isQuick) {
    const deepBtn = document.createElement('button');
    deepBtn.className = 'tldr-deep-scan-btn';
    deepBtn.textContent = 'Run Deep Scan \u2192';
    deepBtn.addEventListener('click', async () => {
      if (deepBtn.disabled) return;
      deepBtn.disabled = true;
      deepBtn.textContent = 'Starting deep scan\u2026';
      const trigBtn = document.getElementById('tldr-shield-trigger');
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
        chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text, url, forceDeep: true });
      } catch (err) {
        showErrorPanel('Failed to start deep scan. Please try again.', location.href);
      }
    });
    panel.appendChild(deepBtn);
  }

  // ── Pillars (Deep scan only) ──
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

    // Pillars label
    const pillarsLabel = document.createElement('div');
    pillarsLabel.className = 'tldr-pillars-label';
    pillarsLabel.textContent = 'Privacy Pillars';
    expandWrapper.appendChild(pillarsLabel);

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

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = quoteBox.style.display === 'block';

          // Accordion: close every other open quote box first
          document.querySelectorAll('.tldr-citation-box').forEach(b => {
            if (b !== quoteBox) b.style.display = 'none';
          });

          if (isOpen) {
            // Closing — hide box and remove page highlight
            quoteBox.style.display = 'none';
            document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
              const p = el.parentNode;
              p.replaceChild(document.createTextNode(el.textContent), el);
              p.normalize();
            });
          } else {
            // Opening — show box, scroll it into view within the panel, then highlight
            quoteBox.style.display = 'block';
            requestAnimationFrame(() => {
              quoteBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
            highlightCitation(val.citation);
          }
        });

        // Append quote box after the row's main content (appended below)
        row._quoteBox = quoteBox;
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

      const statusEl = document.createElement('span');
      statusEl.className = `tldr-pillar-status ${val.violation ? 'violation' : 'clear'}`;
      statusEl.textContent = val.violation ? 'VIOLATION' : 'CLEAR';

      // Confidence badge (only show if server provided it)
      const conf = val.confidence; // 'HIGH' | 'MEDIUM' | 'LOW' | undefined
      if (conf) {
        const confBadge = document.createElement('span');
        confBadge.className = `tldr-confidence tldr-confidence-${conf.toLowerCase()}`;
        confBadge.textContent = conf;
        confBadge.title = conf === 'HIGH' ? 'Explicit verbatim clause found' : conf === 'MEDIUM' ? 'Clause exists but partially ambiguous' : 'Inferred or delegated to external document';
        nameEl.appendChild(confBadge);
      }

      row.appendChild(nameEl);
      row.appendChild(statusEl);

      // Wrap row + quoteBox in a container so quoteBox sits below the row
      if (row._quoteBox) {
        const wrapper = document.createElement('div');
        wrapper.appendChild(row);
        wrapper.appendChild(row._quoteBox);
        pillarsEl.appendChild(wrapper);
      } else {
        pillarsEl.appendChild(row);
      }
    }

    expandWrapper.appendChild(pillarsEl);

    // ── Score deductions (inside expandable, deep scan only) ──
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

  // ── Score deductions outside expandable (quick scan only, when score < 100) ──
  if (isQuick && Array.isArray(data.deductions) && data.deductions.length > 0) {
    const dedEl = document.createElement('div');
    dedEl.className = 'tldr-deductions';

    const dedTitle = document.createElement('div');
    dedTitle.className = 'tldr-deductions-title';
    dedTitle.textContent = `Why not 100? (−${100 - data.score} pts)`;
    dedEl.appendChild(dedTitle);

    data.deductions.forEach(d => {
      const row = document.createElement('div');
      row.className = 'tldr-deduction-row';
      const reason = document.createElement('span');
      reason.className = 'tldr-deduction-reason';
      reason.textContent = d.reason;
      const pts = document.createElement('span');
      pts.className = 'tldr-deduction-pts';
      pts.textContent = `−${d.points} pts`;
      row.appendChild(reason);
      row.appendChild(pts);
      dedEl.appendChild(row);
    });

    panel.appendChild(dedEl);
  }

  // ── Report incorrect result button ──
  const reportBtn = document.createElement('button');
  reportBtn.className = 'tldr-report-btn';
  reportBtn.setAttribute('aria-label', 'Report incorrect result');
  reportBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 1v4M5 8v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Report incorrect result`;
  reportBtn.addEventListener('click', () => {
    if (reportBtn.classList.contains('tldr-reported')) return;
    reportBtn.textContent = 'Sending…';
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
            'X-API-Key': 'd49ba338a35c5305470a006c3708104597dcba71bf1a6032',
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

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield · AI Privacy Analysis';
  panel.appendChild(footer);

  // ── Close button ──
  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
  };

  document.body.appendChild(panel);

  // ── Make panel draggable by its header ───────────────────────────────────
  let pdragging = false, pOffX = 0, pOffY = 0;

  header.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn || closeBtn.contains(e.target)) return;
    if (e.button !== 0) return;
    pdragging = false;
    const rect = panel.getBoundingClientRect();
    pOffX = e.clientX - rect.left;
    pOffY = e.clientY - rect.top;
    header.setPointerCapture(e.pointerId);
    header.classList.add('tldr-panel-dragging');
    // Switch from bottom/right anchoring to top/left for free positioning
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
    panel.style.left   = rect.left + 'px';
    panel.style.top    = rect.top  + 'px';
    e.preventDefault();
  });

  header.addEventListener('pointermove', (e) => {
    if (!header.hasPointerCapture(e.pointerId)) return;
    pdragging = true;
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

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE LISTENER — receives results from background.js AND popup requests
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // FIX #9: Popup requests text extraction through the content script so it
  // benefits from Agent 2's smart extraction (modal, semantic, pagination)
  // instead of the popup doing a raw document.body.innerText grab.
  if (message.type === 'EXTRACT_FOR_POPUP') {
    extractPageText()
      .then(text => sendResponse({ text }))
      .catch(() => sendResponse({ text: document.body?.textContent?.trim() ?? '' }));
    return true; // keep message channel open for async response
  }

  if (message.type === 'ANALYSIS_PROGRESS') {
    // Update the skeleton/progress panel that was shown at scan start
    updateProgressPanel(message.status);
    return;
  }

  if (message.type === 'OUT_OF_CREDITS') {
    const triggerBtn = document.getElementById('tldr-shield-trigger');
    if (triggerBtn) setTriggerIdle(triggerBtn);
    showOutOfCreditsPanel(message.resetDate || 'the 1st of next month');
    return;
  }

  if (message.type !== 'ANALYSIS_RESULT') return;

  const btn = document.getElementById('tldr-shield-trigger');

  if (message.error) {
    if (btn) { btn.style.display = 'flex'; setTriggerIdle(btn); }
    showErrorPanel(message.error || 'Analysis failed. Please try again.', location.href);
    return;
  }

  if (btn) btn.style.display = 'none';
  showResultPanel(message.data);
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP — run Agent 1 on page load + watch for SPA navigation
// ─────────────────────────────────────────────────────────────────────────────

let lastCheckedUrl = '';

function runDetection() {
  if (isBlockedHost()) return;

  // Debounce: skip if URL hasn't changed since last check
  const currentUrl = window.location.href;
  if (currentUrl === lastCheckedUrl) return;
  lastCheckedUrl = currentUrl;

  // Remove any stale button from previous page
  removeTriggerButton();
  removeResultPanel();

  // Show FAB only on likely legal pages (or PDFs), based on confidence scoring.
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.get({ disabledAll: false, disabledSites: [] }, ({ disabledAll, disabledSites }) => {
    if (chrome.runtime.lastError) return; // context invalidated mid-callback
    if (disabledAll || disabledSites.includes(location.hostname)) return;
    const isPdf = document.contentType === 'application/pdf' ||
      /\.pdf(\?.*)?$/i.test(location.href) ||
      document.querySelector('embed[type="application/pdf"]') !== null;
    const { score } = computeConfidence();
    if (!isPdf && score < CONFIDENCE_THRESHOLD) return;
    createTriggerButton();
  });
}

// Run on initial page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(runDetection, 1200));
} else {
  setTimeout(runDetection, 1200);
}

// MutationObserver: re-run detection when SPA routes change or modals appear
let mutationTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(mutationTimer);
  mutationTimer = setTimeout(runDetection, 800);
});

observer.observe(document.body, {
  childList: true,
  subtree: false,   // only direct children — avoids noise from deep DOM churn
});

// Disconnect observer on page unload to prevent memory leaks on long-lived pages
window.addEventListener('pagehide', () => {
  observer.disconnect();
  clearTimeout(mutationTimer);
}, { once: true });

// Popstate / hashchange for SPA navigation (pushState is caught by MutationObserver)
window.addEventListener('popstate', () => setTimeout(runDetection, 500));

// ── Auth Token Bridge ─────────────────────────────────────────────────────────
// The TLDR Shield web app calls window.postMessage after sign-in/sign-out.
// We relay the token to background.js which stores it in chrome.storage.local.
// background.js then passes it as Authorization: Bearer <token> on every scan.
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const type = e.data?.type;
  if (type !== 'TLDR_AUTH_TOKEN' && type !== 'TLDR_AUTH_SIGNOUT') return;
  if (typeof chrome === 'undefined' || !chrome.storage) return;

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
      'http://localhost:3000',
      'http://localhost:5173',
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
window.addEventListener('hashchange', () => setTimeout(runDetection, 500));
