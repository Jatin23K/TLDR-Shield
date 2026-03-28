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

function setTriggerIdle(btn) {
  btn.dataset.scanning = 'false';
  btn.replaceChildren();
  const icon = document.createElement('div');
  icon.className = 'tldr-icon';
  icon.textContent = '🛡️';
  const label = document.createElement('div');
  label.className = 'tldr-text';
  label.textContent = 'Analyze with TLDR Shield';
  btn.appendChild(icon);
  btn.appendChild(label);
}

function setTriggerScanning(btn) {
  btn.dataset.scanning = 'true';
  btn.replaceChildren();
  const spinner = document.createElement('div');
  spinner.className = 'tldr-spinner';
  const label = document.createElement('div');
  label.className = 'tldr-text';
  label.textContent = 'Analyzing…';
  btn.appendChild(spinner);
  btn.appendChild(label);
}

function createTriggerButton() {
  if (document.getElementById('tldr-shield-trigger')) return;

  const btn = document.createElement('div');
  btn.id = 'tldr-shield-trigger';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Analyze with TLDR Shield');
  setTriggerIdle(btn);

  btn.onclick = async () => {
    if (btn.dataset.scanning === 'true') return;
    setTriggerScanning(btn);
    try {
      const text = await extractPageText();
      chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text });
    } catch (err) {
      console.error('[TLDR Shield] Extraction error:', err);
      setTriggerIdle(btn);
    }
  };

  document.body.appendChild(btn);
}

function removeTriggerButton() {
  document.getElementById('tldr-shield-trigger')?.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 4 — RESULT PANEL
// Handles both Quick (badge-only) and Deep (full pillars) results.
// Quick result shows an "Upgrade to Deep Scan" prompt.
// ─────────────────────────────────────────────────────────────────────────────

function removeResultPanel() {
  document.getElementById('tldr-shield-result')?.remove();
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
  brand.textContent = '🛡️ TLDR Shield';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tldr-panel-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';

  header.appendChild(brand);
  header.appendChild(closeBtn);

  // ── Rating badge ──
  const badge = document.createElement('div');
  badge.className = `tldr-rating-badge ${ratingClass}`;

  const ratingLabel = document.createElement('div');
  ratingLabel.className = 'tldr-rating-label';
  ratingLabel.textContent = `${data.rating ?? 'UNKNOWN'}   ${score}/100`;

  const ratingMeta = document.createElement('div');
  ratingMeta.className = 'tldr-rating-score';
  if (data.cached) {
    ratingMeta.textContent = '⚡ Cached Result';
  } else if (data.chunked) {
    ratingMeta.textContent = `🧩 ${data.chunkCount}-block Analysis`;
  } else if (isQuick) {
    ratingMeta.textContent = '⚡ Quick Scan';
  } else {
    ratingMeta.textContent = '🔬 Deep Scan';
  }

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

  // ── TL;DR ──
  if (data.tldr) {
    const tldrEl = document.createElement('div');
    tldrEl.className = 'tldr-tldr';
    tldrEl.textContent = `"${data.tldr}"`;
    panel.appendChild(tldrEl);
  }

  // ── Pillars (Deep scan only) ──
  if (data.pillars && Object.keys(data.pillars).length > 0) {
    const pillarsEl = document.createElement('div');
    pillarsEl.className = 'tldr-pillars';

    for (const [key, val] of Object.entries(data.pillars)) {
      const label = PILLAR_LABELS[key] ?? key.replace(/_/g, ' ');
      const row   = document.createElement('div');
      row.className = 'tldr-pillar-row';
      if (val.citation) row.title = val.citation;

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
      pillarsEl.appendChild(row);
    }

    panel.appendChild(pillarsEl);

  }

  // ── Footer ──
  const footer = document.createElement('div');
  footer.className = 'tldr-panel-footer';
  footer.textContent = 'TL;DR Shield · Privacy Analysis';
  panel.appendChild(footer);

  closeBtn.onclick = () => {
    removeResultPanel();
    const btn = document.getElementById('tldr-shield-trigger');
    if (btn) {
      btn.style.display = 'flex';
      setTriggerIdle(btn);
    }
  };

  document.body.appendChild(panel);
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
      btn.replaceChildren();
      const icon  = document.createElement('div');
      icon.className = 'tldr-icon';
      icon.textContent = '⚠️';
      const label = document.createElement('div');
      label.className = 'tldr-text';
      label.textContent = message.error;
      btn.appendChild(icon);
      btn.appendChild(label);
      // Allow retry after 3s
      setTimeout(() => setTriggerIdle(btn), 3000);
    }
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

  const { score, reasons } = computeConfidence();

  if (score >= CONFIDENCE_THRESHOLD) {
    createTriggerButton();
    console.debug(`[TLDR Shield] Detected T&C (score=${score}, signals=${reasons.join(',')})`);
  }
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
