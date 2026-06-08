// ── TLDR Shield – Extraction Module ──────────────────────────────────────────
// Agent 2: Text extraction from T&C pages (4 forms + Readability + legal suite).
// Loaded AFTER detection.js and BEFORE content.js via manifest.json.
//
// Dependencies from detection.js (via window.TLDRShield):
//   - hasLegalKeyword, LEGAL_URL_PATTERNS
//
// Exports via window.TLDRShield namespace:
//   - extractPageText, extractPolicySuite, discoverLegalSuite

// ── Shared Namespace ─────────────────────────────────────────────────────────
window.TLDRShield = window.TLDRShield || {};

// ── Read dependencies from namespace ─────────────────────────────────────────
const _hasLegalKeyword   = () => window.TLDRShield.hasLegalKeyword;
const _LEGAL_URL_PATTERNS = () => window.TLDRShield.LEGAL_URL_PATTERNS;

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
    if (!initialText || !_hasLegalKeyword()(initialText)) continue;

    if (isScrollable(target)) {
      const totalHeight = target.scrollHeight;
      const step = Math.max(300, Math.floor(target.clientHeight * 0.8));
      const scrollDeadline = Date.now() + 5000;
      let pos = 0;
      while (pos < totalHeight && Date.now() < scrollDeadline) {
        target.scrollTop = pos;
        pos += step;
        await sleep(120);
      }
      target.scrollTop = 0;
    }

    const fullText = target.innerText?.trim() ?? '';
    if (fullText.length > 200) return fullText;
  }
  return null;
}

// ── Form 3: Virtual / lazy-scroll full page ──────────────────────────────────
async function scrollAndCollect() {
  const MAX_SCROLL_TIME_MS = 5000;
  const STEP_PX            = 600;
  const SETTLE_MS          = 150;
  const MAX_CHARS          = 120000;

  const savedScrollY = window.scrollY;
  const htmlEl = document.scrollingElement || document.documentElement;
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
    htmlEl.style.scrollBehavior = savedScrollBehavior;
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  }

  return document.body.textContent?.trim() ?? '';
}

// ── Form 2: Paginated T&C ───────────────────────────────────────────────────
const PAGINATION_PATTERNS = [
  /next\s*(page)?/i,
  /page\s*\d+/i,
  /continue\b/i,
  />\s*$/,
  /→|»/,
];

function findNextPageLink(baseUrl) {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const parser = new URL(baseUrl);

  for (const link of links) {
    const text = link.innerText?.trim() ?? '';
    const href = link.href;

    if (!href || href === baseUrl) continue;
    if (!href.startsWith(parser.origin)) continue;
    if (href.includes('#')) continue;

    const isNextLink = PAGINATION_PATTERNS.some(rx => rx.test(text));
    const isPageNum  = /[?&]page=\d+/i.test(href) || /\/\d+\/?$/.test(new URL(href).pathname);

    if (isNextLink || isPageNum) return href;
  }
  return null;
}

async function fetchPaginatedPages(firstPageText) {
  const MAX_PAGES   = 8;
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

      const tempDiv = doc.body;
      const nextLinks = Array.from(tempDiv.querySelectorAll('a[href]'));
      nextUrl = null;
      for (const link of nextLinks) {
        const text = link.textContent?.trim() ?? '';
        const href = link.href;
        if (!href || visited.has(href)) continue;
        if (PAGINATION_PATTERNS.some(rx => rx.test(text))) {
          nextUrl = href;
          break;
        }
      }
    } catch {
      break;
    }
  }

  if (pages.length > 1) {
    console.debug(`[TLDR Shield] Collected ${pages.length} pages of T&C`);
  }

  return pages.join('\n\n--- [Page Break] ---\n\n');
}

// ── Form 1: Semantic container ───────────────────────────────────────────────
function extractSemanticText() {
  for (const sel of SEMANTIC_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && (el.innerText?.trim().length ?? 0) > 500) {
      return el.innerText.trim();
    }
  }
  return null;
}

// ── Readability extraction ───────────────────────────────────────────────────
function extractWithReadability() {
  try {
    if (typeof Readability === 'undefined') return null;
    const docClone = document.cloneNode(true);
    const article  = new Readability(docClone, {
      charThreshold: 300,
      keepClasses:   false,
      nbTopCandidates: 10,
    }).parse();
    if (!article?.textContent) return null;
    const text = article.textContent.trim();
    if (text.length < 800) return null;
    // Guard: if readability grabbed a tiny slice of a large page,
    // it likely picked the wrong section (e.g. Apple App Store clause
    // at the bottom of Discord ToS). Fall back so body.innerText is used.
    const bodyLen = document.body.innerText?.length ?? 0;
    if (bodyLen > 8000 && text.length < bodyLen * 0.25) return null;
    return text;
  } catch (_) {
    return null;
  }
}

// ── Legal Suite Discovery ────────────────────────────────────────────────────
const LEGAL_LINK_KEYWORDS = [
  'privacy', 'privacy-policy', 'privacy_policy', 'privacy-notice',
  'terms', 'terms-of-service', 'terms-of-use', 'tos', 'eula',
  'cookie', 'cookies', 'cookie-policy',
  'dmca', 'copyright', 'acceptable-use', 'aup',
  'data-processing', 'dpa', 'data-protection',
  'legal', 'license', 'licenses',
  'community-guidelines', 'content-policy',
];

const LEGAL_LINK_BLOCKLIST = [
  'login', 'signin', 'sign-in', 'signup', 'register', 'pricing',
  'blog', 'support', 'help', 'careers', 'jobs', 'contact', 'about',
  'download', 'app-store', 'google-play',
];

function discoverLegalSuite() {
  const currentPathname = (() => {
    try { return new URL(location.href).pathname.toLowerCase().replace(/\/$/, ''); }
    catch (_) { return ''; }
  })();
  const currentOrigin = location.origin;
  const found = new Map();

  const anchors = document.querySelectorAll('a[href]');
  for (const a of anchors) {
    let href;
    try { href = new URL(a.getAttribute('href'), location.href); }
    catch (_) { continue; }
    if (href.origin !== currentOrigin) continue;
    const path = (href.pathname || '').toLowerCase().replace(/\/$/, '');
    if (!path || path === currentPathname) continue;
    if (found.has(path)) continue;

    const text = (a.innerText || a.textContent || '').trim().toLowerCase();
    const haystack = `${path} ${text}`;

    if (LEGAL_LINK_BLOCKLIST.some(k => haystack.includes(k) && !LEGAL_LINK_KEYWORDS.some(lk => haystack.includes(lk)))) continue;

    const matchedKw = LEGAL_LINK_KEYWORDS.find(k => path.includes(k) || text.includes(k));
    if (!matchedKw) continue;

    found.set(path, { url: href.href, label: text || matchedKw });
    if (found.size >= 8) break;
  }
  return Array.from(found.values()).slice(0, 5);
}

async function fetchLegalPage(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok) return null;
    const html = await resp.text();
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (typeof Readability !== 'undefined') {
        const article = new Readability(doc, { charThreshold: 300, keepClasses: false }).parse();
        if (article?.textContent && article.textContent.length > 500) {
          return article.textContent.trim().slice(0, 40000);
        }
      }
      const body = doc.body?.textContent?.trim();
      return body && body.length > 500 ? body.slice(0, 40000) : null;
    } catch (_) { return null; }
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLegalSuite(links, totalBudgetMs = 25000) {
  if (!links?.length) return [];
  const deadline = Date.now() + totalBudgetMs;
  const results = [];
  const promises = links.map(async (link) => {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) return null;
    const text = await fetchLegalPage(link.url, Math.min(10000, remaining));
    return text ? { url: link.url, label: link.label, text } : null;
  });
  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) results.push(s.value);
  }
  return results;
}

async function extractPolicySuite(primaryText) {
  const links = discoverLegalSuite();
  if (!links.length) return primaryText;

  const suite = await fetchLegalSuite(links);
  if (!suite.length) return primaryText;

  const parts = [
    `=== PAGE: ${location.href} ===`,
    primaryText,
    ...suite.flatMap(p => [`\n\n=== PAGE: ${p.url} (${p.label}) ===`, p.text]),
  ];
  return parts.join('\n');
}

// ── Form 5: Shadow DOM Piercer (For Modern SPAs like Reddit) ───────────────
function extractShadowDOMText(root) {
  let text = '';
  
  if (root.nodeType === Node.ELEMENT_NODE) {
    const tag = root.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'svg', 'img', 'video', 'audio', 'canvas'].includes(tag)) {
      return '';
    }
  }

  if (root.nodeType === Node.TEXT_NODE) {
    const val = root.textContent.trim();
    if (val) return val + ' ';
    return '';
  }

  if (root.shadowRoot) {
    text += extractShadowDOMText(root.shadowRoot);
  }

  if (root.childNodes) {
    for (const child of root.childNodes) {
      text += extractShadowDOMText(child);
    }
  }

  if (root.nodeType === Node.ELEMENT_NODE) {
    const tag = root.tagName.toLowerCase();
    if (['p', 'div', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'br', 'header', 'footer'].includes(tag)) {
      text += '\n';
    }
  }

  return text;
}

// ── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
async function extractPageText() {
  const modalText = await extractModalScrollContent();
  if (modalText) return cleanText(modalText);

  const readabilityText = extractWithReadability();
  if (readabilityText) return cleanText(readabilityText);

  const semanticText = extractSemanticText();
  if (semanticText) {
    const nextLink = findNextPageLink(window.location.href);
    if (nextLink) {
      const paginated = await fetchPaginatedPages(semanticText);
      return cleanText(paginated);
    }
    return cleanText(semanticText);
  }

  const bodyText = document.body.innerText?.trim() ?? '';
  const bodyIsShort = bodyText.length < 3000;
  const looksLikeScrollPage = _LEGAL_URL_PATTERNS().some(rx => rx.test(window.location.pathname));

  if (bodyIsShort && looksLikeScrollPage) {
    const scrolled = await scrollAndCollect();
    if (scrolled.length > bodyText.length + 500) return cleanText(scrolled);
  }

  const fallback = bodyText || (document.body.innerText ? document.body.innerText.trim() : '');
  
  // Brutal Fallback: If text is impossibly short, it's heavily Web Component/Shadow DOM based (e.g. Reddit)
  if (fallback.length < 1500) {
    console.debug('[TLDR Shield] Standard extraction failed/short. Firing Shadow DOM Piercer...');
    const shadowText = extractShadowDOMText(document.body);
    if (shadowText && shadowText.length > fallback.length) {
      return cleanText(shadowText);
    }
  }

  return cleanText(fallback);
}

// ── Export to namespace ──────────────────────────────────────────────────────
Object.assign(window.TLDRShield, {
  SEMANTIC_SELECTORS,
  cleanText,
  sleep,
  extractPageText,
  extractPolicySuite,
  discoverLegalSuite,
});
