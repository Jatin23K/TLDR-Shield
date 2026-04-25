// ── TLDR Shield – Detection Module ───────────────────────────────────────────
// Agent 1: T&C presence detection via multi-signal confidence scoring.
// Loaded BEFORE content.js via manifest.json content_scripts order.
//
// Exports via window.TLDRShield namespace:
//   - SIGNALS, CONFIDENCE_THRESHOLD
//   - LEGAL_URL_PATTERNS, LEGAL_KEYWORDS, BLOCKED_HOSTS
//   - COOKIE_BANNER_SELECTORS, TLDR_APP_HOST
//   - isBlockedHost, hasLegalKeyword, computeConfidence
//   - getReportUrl, TLDR_DEFAULT_API_BASE

// ── Shared Namespace ─────────────────────────────────────────────────────────
window.TLDRShield = window.TLDRShield || {};

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

const CONFIDENCE_THRESHOLD = 30;

const TLDR_DEFAULT_API_BASE = 'https://tldr-shield-292798741977.us-central1.run.app';

function getReportUrl(cb) {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get({ apiUrl: '' }, ({ apiUrl }) => {
      cb((apiUrl || TLDR_DEFAULT_API_BASE).replace(/\/api\/analyze$/, ''));
    });
  } else {
    cb(TLDR_DEFAULT_API_BASE);
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

// The TLDR Shield app itself — never scan our own pages
const TLDR_APP_HOST = 'tldr-shield-292798741977.us-central1.run.app';

function isBlockedHost() {
  const host = window.location.hostname.toLowerCase();
  if (host === TLDR_APP_HOST) return true;
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

// ── Export to namespace ──────────────────────────────────────────────────────
Object.assign(window.TLDRShield, {
  SIGNALS,
  CONFIDENCE_THRESHOLD,
  TLDR_DEFAULT_API_BASE,
  getReportUrl,
  LEGAL_URL_PATTERNS,
  LEGAL_KEYWORDS,
  BLOCKED_HOSTS,
  COOKIE_BANNER_SELECTORS,
  TLDR_APP_HOST,
  isBlockedHost,
  hasLegalKeyword,
  computeConfidence,
});
