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

    // Scroll the container to the bottom in steps to trigger lazy rendering
    if (isScrollable(target)) {
      const totalHeight = target.scrollHeight;
      const step = Math.max(300, Math.floor(target.clientHeight * 0.8));
      let pos = 0;
      while (pos < totalHeight) {
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
      const res  = await fetch(nextUrl, { credentials: 'omit' });
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

// ── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
// Priority order:
//   1. Modal scroll content (Form 4) — most specific
//   2. Semantic container → check for pagination (Form 1 + 2)
//   3. Virtual scroll detection (Form 3) — only if body seems short
//   4. Raw body fallback

async function extractPageText() {
  // Form 4: visible modal with scrollable T&C
  const modalText = await extractModalScrollContent();
  if (modalText) return cleanText(modalText);

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
    try {
      const text = await extractPageText();
      chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text });
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
      console.error('[TLDR Shield] Extraction error:', err);
      setTriggerIdle(btn);
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
// Quick result shows an "Upgrade to Deep Scan" prompt.
// ─────────────────────────────────────────────────────────────────────────────

function removeResultPanel() {
  document.getElementById('tldr-shield-result')?.remove();
  // Clean up any citation highlights
  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

// Finds citation text in the page DOM, scrolls to it, and highlights it
function highlightCitation(citation) {
  if (!citation || citation === 'Not addressed in document.') return false;

  // Remove previous highlights
  document.querySelectorAll('.tldr-citation-highlight').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });

  // Clean surrounding quotes the LLM sometimes adds
  const clean = citation.replace(/^["'"'\u201c\u2018]|["'"'\u201d\u2019]$/g, '').trim();

  // Build candidate search strings — most specific first
  const candidates = [];

  // 1. Quoted fragments inside the citation — most verbatim, highest priority
  const quotedRe = /['"'"\u201c\u2018]([^'"'"\u201d\u2019]{12,}?)['"'"\u201d\u2019]/g;
  let qm;
  while ((qm = quotedRe.exec(clean)) !== null) candidates.push(qm[1].trim());

  // 2. Exact prefix slices
  for (const len of [80, 60, 40]) {
    const s = clean.slice(0, len).trim();
    if (s.length >= 20) candidates.push(s);
  }

  // 3. Sliding windows: 7 → 6 → 5 → 4 words (wider net for paraphrased citations)
  const words = clean.split(/\s+/).filter(w => w.length > 1);
  for (const size of [7, 6, 5, 4]) {
    for (let i = 0; i <= words.length - size; i++) {
      candidates.push(words.slice(i, i + size).join(' '));
    }
  }

  // 4. Key legal noun-phrases: consecutive pairs of "meaningful" words (length > 4, not stopwords)
  // Helps when the citation is a paraphrase but still contains domain-specific terms.
  const STOPWORDS = new Set(['that','this','with','from','your','their','have','will','shall','which','when','where','they','them','been','were','into','upon','under','over','such','only','also','each','both','more','than','about','other','these','those','some','what','would','could','should','there','after','before','without','within','between','through','whether','during','include','including','including,','using','used','uses','provide','provides','provided','make','makes','made','right','rights','terms','policy','service','services']);
  const meaningful = words.filter(w => w.length > 4 && !STOPWORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  for (let i = 0; i < meaningful.length - 1; i++) {
    candidates.push(`${meaningful[i]} ${meaningful[i + 1]}`);
  }

  // ── Strategy A: window.find() — searches across DOM element boundaries ────
  // This is Chrome's native Ctrl+F engine, handles text split across <p>/<em>/<strong>
  const tryWindowFind = (needle) => {
    window.getSelection()?.removeAllRanges();
    const found = window.find(needle, false /*case*/, false /*back*/, true /*wrap*/, false, false, false);
    if (!found) return false;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);

    // Make sure match isn't inside our own panel
    if (range.commonAncestorContainer?.parentElement?.closest(
      '#tldr-shield-result, #tldr-shield-trigger, #tldr-context-menu, #tldr-progress-panel'
    )) {
      window.getSelection()?.removeAllRanges();
      return false;
    }

    const span = document.createElement('mark');
    span.className = 'tldr-citation-highlight';
    span.style.cssText = 'background:#fef08a;color:#1e1b4b;border-radius:3px;padding:0 2px;box-shadow:0 0 0 2px #fde047;scroll-margin-top:80px;';

    try {
      range.surroundContents(span);
    } catch {
      // Range spans multiple elements — scroll to anchor node without wrapping
      const anchor = range.startContainer?.parentElement;
      if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.getSelection()?.removeAllRanges();
      // Still counts as "found" so quote box doesn't open
      setTimeout(() => {}, 4000);
      return true;
    }

    window.getSelection()?.removeAllRanges();
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      span.style.transition = 'background 0.8s, box-shadow 0.8s';
      span.style.background = 'transparent';
      span.style.boxShadow  = 'none';
    }, 4000);
    return true;
  };

  // ── Strategy B: TreeWalker — single text-node exact match ─────────────────
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(
        '#tldr-shield-result, #tldr-shield-trigger, #tldr-context-menu, #tldr-progress-panel'
      )) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const tryTreeWalker = (needle) => {
    const lowerNeedle = needle.toLowerCase();
    for (const node of textNodes) {
      const idx = node.textContent.toLowerCase().indexOf(lowerNeedle);
      if (idx === -1) continue;

      const origText = node.textContent;
      const span = document.createElement('mark');
      span.className = 'tldr-citation-highlight';
      span.textContent = origText.slice(idx, idx + needle.length);
      span.style.cssText = 'background:#fef08a;color:#1e1b4b;border-radius:3px;padding:0 2px;box-shadow:0 0 0 2px #fde047;scroll-margin-top:80px;';

      const frag = document.createDocumentFragment();
      if (idx > 0) frag.appendChild(document.createTextNode(origText.slice(0, idx)));
      frag.appendChild(span);
      if (idx + needle.length < origText.length) frag.appendChild(document.createTextNode(origText.slice(idx + needle.length)));
      node.parentNode.replaceChild(frag, node);

      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        span.style.transition = 'background 0.8s, box-shadow 0.8s';
        span.style.background = 'transparent';
        span.style.boxShadow  = 'none';
      }, 4000);
      return true;
    }
    return false;
  };

  // Try all candidates with window.find first, then TreeWalker fallback
  const seen = new Set();
  for (const search of candidates) {
    const key = search.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (tryWindowFind(search) || tryTreeWalker(search)) return true;
  }
  return false;
}

function showOutOfCreditsPanel(resetDate) {
  removeResultPanel();
  const panel = document.createElement('div');
  panel.id = 'tldr-shield-result';
  panel.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:2147483647;
    width:320px; background:#0f1117; border:1px solid rgba(239,68,68,0.4);
    border-radius:16px; box-shadow:0 8px 32px rgba(0,0,0,0.6); font-family:system-ui,sans-serif;
    padding:20px; color:#f1f5f9; animation: tldrSlideIn 0.3s ease;
  `;
  panel.innerHTML = `
    <style>
      @keyframes tldrSlideIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
      #tldr-oc-buy a { text-decoration:none; }
      #tldr-oc-buy a:hover { opacity:0.9; }
    </style>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:20px;">⚡</span>
        <span style="font-weight:700;font-size:14px;color:#f87171;">Out of credits</span>
      </div>
      <button id="tldr-oc-close" style="background:none;border:none;color:#64748b;font-size:18px;cursor:pointer;padding:0;line-height:1;">×</button>
    </div>
    <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;line-height:1.5;">
      You've used all your credits for this month.
    </p>
    <p style="margin:0 0 16px;font-size:13px;color:#64748b;">
      🔄 Free credits reset on <strong style="color:#94a3b8;">${resetDate}</strong>
    </p>
    <div id="tldr-oc-buy" style="display:flex;flex-direction:column;gap:8px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">Top up now</p>
      <a href="http://localhost:3000" target="_blank" style="
        display:flex;align-items:center;justify-content:space-between;
        background:rgba(79,70,229,0.12);border:1px solid rgba(79,70,229,0.3);
        border-radius:10px;padding:10px 14px;cursor:pointer;color:#a5b4fc;font-size:13px;font-weight:600;
      ">
        <span>1,000 credits</span>
        <span style="color:#818cf8;font-weight:700;">$7</span>
      </a>
      <a href="http://localhost:3000" target="_blank" style="
        display:flex;align-items:center;justify-content:space-between;
        background:rgba(79,70,229,0.18);border:1px solid rgba(99,102,241,0.5);
        border-radius:10px;padding:10px 14px;cursor:pointer;color:#a5b4fc;font-size:13px;font-weight:600;
      ">
        <span>2,000 credits <span style="font-size:10px;background:rgba(16,185,129,0.15);color:#34d399;border-radius:4px;padding:1px 5px;margin-left:4px;">BEST VALUE</span></span>
        <span style="color:#818cf8;font-weight:700;">$12</span>
      </a>
    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#tldr-oc-close').addEventListener('click', () => panel.remove());
}

function showResultPanel(data) {
  removeResultPanel();

  const ratingClass = data.rating?.toLowerCase() ?? 'risky';
  const score       = data.score ?? '?';
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

  // ── Rating badge ──
  const badge = document.createElement('div');
  badge.className = `tldr-rating-badge ${ratingClass}`;

  // Big score number
  const scoreEl = document.createElement('div');
  scoreEl.className = 'tldr-score-number';
  scoreEl.innerHTML = `${score}<span class="tldr-score-denom">/100</span>`;

  // Rating word (SAFE / OKAY / RISKY)
  const ratingLabel = document.createElement('div');
  ratingLabel.className = 'tldr-rating-label';
  ratingLabel.textContent = data.rating ?? 'UNKNOWN';

  // Meta line (cached / scan type)
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

  badge.appendChild(scoreEl);
  badge.appendChild(ratingLabel);
  badge.appendChild(ratingMeta);

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
    tldrEl.textContent = `"${data.tldr}"`;
    panel.appendChild(tldrEl);
  }

  // ── Pillars (Deep scan only) ──
  if (data.pillars && Object.keys(data.pillars).length > 0) {
    const pillarsLabel = document.createElement('div');
    pillarsLabel.className = 'tldr-pillars-label';
    pillarsLabel.textContent = 'Privacy Pillars';
    panel.appendChild(pillarsLabel);

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

    panel.appendChild(pillarsEl);

  }

  // ── Score deductions (deep scan only, when score < 100) ──
  if (Array.isArray(data.deductions) && data.deductions.length > 0) {
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

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TLDR Shield · Privacy Analysis';
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
    let prog = document.getElementById('tldr-progress-panel');
    if (!prog) {
      prog = document.createElement('div');
      prog.id = 'tldr-progress-panel';
      prog.style.cssText = `
        position:fixed; bottom:24px; right:24px; z-index:2147483647;
        background:#0f172a; border:1px solid rgba(255,255,255,0.08);
        border-radius:12px; padding:12px 16px; font-family:system-ui,sans-serif;
        color:#94a3b8; font-size:12px; display:flex; align-items:center; gap:10px;
        box-shadow:0 4px 20px rgba(0,0,0,0.4); max-width:280px;
      `;
      document.body.appendChild(prog);
    }
    prog.innerHTML = `
      <div style="width:14px;height:14px;border:2px solid rgba(99,102,241,0.3);border-top-color:#6366f1;border-radius:50%;animation:tldr-spin 0.75s linear infinite;flex-shrink:0;"></div>
      <span>${message.status}</span>
    `;
    return;
  }

  if (message.type === 'OUT_OF_CREDITS') {
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) setTriggerIdle(btn);
    showOutOfCreditsPanel(message.resetDate || 'the 1st of next month');
    return;
  }

  if (message.type !== 'ANALYSIS_RESULT') return;

  const btn = document.getElementById('tldr-shield-trigger');

  if (message.error) {
    if (btn) {
      btn.style.display = 'flex';
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
      btn.title = message.error;
      setTimeout(() => setTriggerIdle(btn), 4000);
    }
    return;
  }

  // Remove progress panel when result arrives
  document.getElementById('tldr-progress-panel')?.remove();
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

  // Always show FAB on every page (user can disable per-site or globally via right-click)
  chrome.storage.local.get({ disabledAll: false, disabledSites: [] }, ({ disabledAll, disabledSites }) => {
    if (disabledAll || disabledSites.includes(location.hostname)) return;
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

// Popstate / hashchange for SPA navigation (pushState is caught by MutationObserver)
window.addEventListener('popstate', () => setTimeout(runDetection, 500));

// ── Auth Token Bridge ─────────────────────────────────────────────────────────
// The TLDR Shield web app calls window.postMessage after sign-in/sign-out.
// We relay the token to background.js which stores it in chrome.storage.local.
// background.js then passes it as Authorization: Bearer <token> on every scan.
window.addEventListener('message', (e) => {
  if (e.source !== window) return; // only trust messages from this page
  if (e.data?.type === 'TLDR_AUTH_TOKEN') {
    chrome.runtime.sendMessage({
      type: 'STORE_AUTH',
      token: e.data.token,
      uid:   e.data.uid,
      email: e.data.email,
    });
  }
  if (e.data?.type === 'TLDR_AUTH_SIGNOUT') {
    chrome.runtime.sendMessage({ type: 'CLEAR_AUTH' });
  }
});
window.addEventListener('hashchange', () => setTimeout(runDetection, 500));
