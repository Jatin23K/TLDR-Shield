// ── TLDR Shield – Side Panel Script ──

const _browser = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;


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
const gdprSection        = document.getElementById('gdpr-section');
const confidenceWarning  = document.getElementById('confidence-warning');
const gdprToggleBtn    = document.getElementById('gdpr-toggle-btn');
const gdprFormExpanded = document.getElementById('gdpr-form-expanded');
const gdprEmailInput   = document.getElementById('gdpr-email-input');
const gdprGenerateBtn  = document.getElementById('gdpr-generate-btn');
const gdprResult       = document.getElementById('gdpr-result');
const gdprSubjectLabel = document.getElementById('gdpr-subject-label');
const gdprBodyArea     = document.getElementById('gdpr-body-area');
const gdprCopyBtn      = document.getElementById('gdpr-copy-btn');
const gdprError        = document.getElementById('gdpr-error');
const deductionsSection = document.getElementById('deductions-section');
const deductionsList    = document.getElementById('deductions-list');

// ── State ───────────────────────────────────────────────────────────────────
let lastResult = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function hideAll() {
  if (panelLoading) panelLoading.style.display = 'none';
  if (panelEmpty)   panelEmpty.style.display   = 'none';
  if (panelResult)  panelResult.style.display  = 'none';
  if (panelError)   panelError.style.display   = 'none';
  // Clear persistent UI states from previous results
  if (gdprSection)      gdprSection.style.display      = 'none';
  if (gdprFormExpanded) gdprFormExpanded.style.display = 'none';
  if (gdprResult)       gdprResult.style.display       = 'none';
  if (gdprError)        gdprError.style.display        = 'none';
  if (deductionsSection) deductionsSection.style.display = 'none';
  if (deductionsList)    deductionsList.innerHTML      = '';
}

// ── PROGRESS_STEPS ──────────────────────────────────────────────────────────
const PROGRESS_STEPS = [
  { key: 'reading', label: '\uD83D\uDCC1 Reading Legal Text', triggers: ['chunk', 'read', 'extract'] },
  { key: 'clauses', label: '\uD83E\uDDE0 Identifying Clauses', triggers: ['analyz', 'pillar', 'identifying', 'mapping'] },
  { key: 'auditing', label: '\uD83D\uDEE1\uFE0F Auditing Privacy Pillars', triggers: ['ground', 'citation', 'embed', 'audit', 'scanning', 'searching', 'reviewing'] },
  { key: 'scoring',  label: '\uD83D\uDCC8 Calculating Score',     triggers: ['scor', 'aggregat', 'complet', 'calculating'] },
];

let _progressCurrentStep = -1;

function _progressStepIndex(status) {
  if (!status) return -1;
  const s = status.toLowerCase();
  for (let i = PROGRESS_STEPS.length - 1; i >= 0; i--) {
    if (PROGRESS_STEPS[i].triggers.some(t => s.includes(t))) return i;
  }
  return -1;
}

// ── showLoading ─────────────────────────────────────────────────────────────
function showLoading(status) {
  hideAll();
  panelLoading.style.display = 'block';
  if (loadingStatusTxt) {
    loadingStatusTxt.textContent = status || 'Analyzing...';
  }

  let stepsContainer = document.getElementById('loading-steps-container');
  if (!stepsContainer) {
    stepsContainer = document.createElement('div');
    stepsContainer.id = 'loading-steps-container';
    stepsContainer.className = 'tldr-loading-steps';
    PROGRESS_STEPS.forEach((step) => {
      const row = document.createElement('div');
      row.className = 'tldr-loading-step';
      row.id = 'sp-step-' + step.key;
      const dot = document.createElement('div');
      dot.className = 'tldr-step-dot';
      const text = document.createElement('span');
      text.style.marginLeft = '8px';
      text.textContent = step.label;
      row.appendChild(dot);
      row.appendChild(text);
      stepsContainer.appendChild(row);
    });
    panelLoading.appendChild(stepsContainer);
    _progressCurrentStep = -1;
  }

  const stepIdx = _progressStepIndex(status);

  // Restart logic: if status contains "extracting" or "reading" and we were far ahead, reset.
  if (stepIdx === 0 && _progressCurrentStep > 1) {
    PROGRESS_STEPS.forEach((step) => {
      const row = document.getElementById('sp-step-' + step.key);
      if (row) row.classList.remove('done', 'active');
    });
    _progressCurrentStep = -1;
  }

  if (stepIdx < 0) return;
  if (stepIdx <= _progressCurrentStep) return;

  PROGRESS_STEPS.forEach((step, i) => {
    const row = document.getElementById('sp-step-' + step.key);
    if (!row) return;
    row.classList.remove('done', 'active');
    if (i < stepIdx) row.classList.add('done');
    else if (i === stepIdx) row.classList.add('active');
  });
  _progressCurrentStep = stepIdx;
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

  // Degraded fallback — AI was unavailable (quota hit). Server returned a
  // regex-based scan; show it with a banner rather than hiding the data.
  const isDegraded = !!data.degraded;

  lastResult = data;
  hideAll();

  // Inject / clear the degraded banner inside the result panel
  const oldBanner = panelResult.querySelector('.tldr-degraded-banner');
  if (oldBanner) oldBanner.remove();
  if (isDegraded) {
    const banner = document.createElement('div');
    banner.className = 'tldr-degraded-banner';
    banner.style.cssText = 'margin:10px 14px 0; padding:10px 12px; background:rgba(197,157,60,0.12); border:1px solid rgba(197,157,60,0.45); border-radius:8px; color:#e6c679; font-size:12px; line-height:1.45;';
    const strong = document.createElement('strong');
    strong.style.color = '#f0d288';
    strong.textContent = 'Offline scan';
    banner.appendChild(strong);
    banner.appendChild(document.createTextNode(' \u00b7 AI quota temporarily exhausted. Results below are pattern-based; re-scan in a few minutes for full AI verdict.'));
    panelResult.insertBefore(banner, panelResult.firstChild);
  }

  // Rating banner
  const rating = (data.rating || 'OKAY').toUpperCase();
  const score  = typeof data.score === 'number' ? data.score : '–';

  ratingBanner.className = 'rating-banner';
  if (rating === 'SAFE')  ratingBanner.classList.add('safe');
  else if (rating === 'RISKY') ratingBanner.classList.add('risky');
  else ratingBanner.classList.add('okay');

  ratingLabel.textContent = rating;
  // CAUTIOUS sub-label: OKAY + score 50–59 is borderline — show without breaking 3-tier system
  const oldChip = ratingLabel.querySelector('.cautious-chip');
  if (oldChip) oldChip.remove();
  if (rating === 'OKAY' && typeof score === 'number' && score < 60) {
    const chip = document.createElement('span');
    chip.className = 'cautious-chip';
    chip.textContent = 'CAUTIOUS';
    ratingLabel.appendChild(chip);
  }
  ratingScore.textContent = String(score);

  // Confidence warning — show when all violations are LOW confidence
  if (confidenceWarning) {
    const pillars = data.pillars || {};
    const violations = Object.values(pillars).filter(p => p?.violation);
    const allLow = violations.length > 0 &&
        violations.every(p => (p?.confidence || 'MEDIUM').toUpperCase() === 'LOW');
    confidenceWarning.style.display = allLow ? 'block' : 'none';
  }

  // Deductions (Audit Findings)
  if (data.deductions && Array.isArray(data.deductions) && data.deductions.length > 0) {
    deductionsList.innerHTML = '';
    data.deductions.forEach(d => {
      const item = document.createElement('div');
      item.className = 'deduction-item';
      
      const reason = document.createElement('span');
      reason.className = 'deduction-reason';
      reason.textContent = d.reason;
      
      const points = document.createElement('span');
      points.className = 'deduction-points';
      points.textContent = `-${d.points}`;
      
      item.appendChild(reason);
      item.appendChild(points);
      deductionsList.appendChild(item);
    });
    deductionsSection.style.display = 'block';
  } else {
    deductionsSection.style.display = 'none';
  }

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
      // Pillar values are objects: { violation: bool, citation: string, confidence: string }
      const pillar  = data.pillars[key];
      // Three-state via server-provided `status`: VIOLATES / EXPLICITLY_DENIES / NOT_MENTIONED.
      // Legacy fallback: use violation + confidence when status is missing.
      const pConfUp = (pillar?.confidence || 'MEDIUM').toString().toUpperCase();
      const pStatus = (pillar?.status || '').toString().toUpperCase();
      const hardViolation = pStatus === 'VIOLATES' || (pillar?.violation === true && pConfUp !== 'LOW');
      const softFlag      = pillar?.violation === true && pConfUp === 'LOW';
      const isNA          = pStatus === 'NOT_APPLICABLE' || pillar?.applicable === false;
      const silence       = !isNA && pStatus === 'NOT_MENTIONED' && !pillar?.violation;
      const row = document.createElement('div');
      row.className = 'pillar-row';

      const top = document.createElement('div');
      top.className = 'pillar-top';

      const dotClass = hardViolation ? 'risky' : (isNA ? 'na' : (softFlag || silence ? 'okay' : 'safe'));
      const lblText  = hardViolation ? 'RISKY' : (isNA ? 'N/A' : (softFlag ? 'OKAY' : (silence ? 'NOT STATED' : 'SAFE')));

      const dot = document.createElement('span');
      dot.className = `pillar-dot ${dotClass}`;

      const name = document.createElement('span');
      name.className = 'pillar-name';
      name.textContent = PILLAR_LABELS[key] || key;

      // Fix #7: transparency is informational-only — not scored
      if (key === 'transparency') {
        const infoTag = document.createElement('span');
        infoTag.className = 'pillar-info-tag';
        infoTag.textContent = 'info only';
        infoTag.title = 'Transparency is shown for context but does not affect the score';
        infoTag.style.cssText = 'font-size:8px; color:#8b95a5; background:rgba(139,149,165,0.12); padding:1px 5px; border-radius:3px; margin-left:6px; font-weight:500; text-transform:uppercase; letter-spacing:0.3px;';
        name.appendChild(infoTag);
      }

      const status = document.createElement('span');
      status.className = `pillar-status-label ${dotClass}`;
      status.textContent = lblText;
      status.style.marginLeft = 'auto';
      status.style.fontSize = '9px';
      status.style.fontWeight = '700';

      top.appendChild(dot);
      top.appendChild(name);
      top.appendChild(status);

      if (pillar?.confidence) {
        const rawConf = pillar.confidence.toLowerCase();
        let confLevel = ['high', 'medium', 'low'].includes(rawConf) ? rawConf : 'medium';
        // Non-violated pillars are safe — LOW confidence is misleading (absence of
        // violation doesn't need a verbatim citation). Clamp to minimum MEDIUM for
        // cached results that may have been stored before the server-side fix.
        if (!pillar.violation && confLevel === 'low') confLevel = 'medium';
        const conf = document.createElement('span');
        conf.className = 'pillar-confidence ' + confLevel;
        conf.title = confLevel.charAt(0).toUpperCase() + confLevel.slice(1) + ' confidence';
        top.appendChild(conf);
      }

      row.appendChild(top);

      // Show citation text when present and not the sentinel value
      const citationText = pillar?.citation;
      if (citationText && citationText !== 'Not addressed in document.' && citationText !== '[NOT_FOUND]') {
        const citation = document.createElement('p');
        citation.className = 'pillar-citation';
        citation.textContent = citationText;
        row.appendChild(citation);
      }

      pillarsList.appendChild(row);
    });
    pillarsSection.style.display = 'block';
  } else {
    pillarsSection.style.display = 'none';
  }

  panelResult.style.display = 'flex';

  // Show GDPR section for RISKY/OKAY deep scans only
  const showGdpr = data.pillars && (data.rating === 'RISKY' || data.rating === 'OKAY');
  if (gdprSection) gdprSection.style.display = showGdpr ? 'block' : 'none';
  // Reset form state
  if (gdprFormExpanded) gdprFormExpanded.style.display = 'none';
  if (gdprResult) gdprResult.style.display = 'none';
  if (gdprError) gdprError.style.display = 'none';
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
_browser.runtime.onMessage.addListener((message) => {
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
    const resetDate = message.resetDate ? new Date(message.resetDate).toLocaleDateString() : 'the 1st of next month';
    showError(`No credits remaining. Resets on ${resetDate}.`);
  }
});

// ── Go to Tab button ────────────────────────────────────────────────────────
// window.close() has no effect in a Chrome side panel (panels can only be closed
// by the user or via _browser.sidePanel.close which requires Chrome 126+).
// We just focus the active tab so the user can trigger a new scan from the page.
scanAgainBtn.addEventListener('click', () => {
  _browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      _browser.tabs.sendMessage(tabs[0].id, { type: 'FORCE_RESCAN' });
      _browser.tabs.update(tabs[0].id, { active: true });
    }
  });
});

// ── Retry button ─────────────────────────────────────────────────────────────
retryBtn.addEventListener('click', () => {
  showEmpty();
});

// ── Sign-in button ───────────────────────────────────────────────────────────
signinBtn.addEventListener('click', () => {
  _browser.storage.local.get({ apiUrl: 'https://tldr-shield-292798741977.us-central1.run.app/api/analyze' }, ({ apiUrl }) => {
    const dashUrl = (apiUrl || '').replace(/\/api\/analyze$/, '');
    if (dashUrl) _browser.tabs.create({ url: dashUrl });
  });
});

// ── GDPR toggle ─────────────────────────────────────────────────────────────
if (gdprToggleBtn) {
  gdprToggleBtn.addEventListener('click', () => {
    const expanded = gdprFormExpanded.style.display !== 'none';
    gdprFormExpanded.style.display = expanded ? 'none' : 'block';
  });
}

// ── GDPR generate ────────────────────────────────────────────────────────────
if (gdprGenerateBtn) {
  gdprGenerateBtn.addEventListener('click', async () => {
    const userEmail = gdprEmailInput?.value?.trim();
    if (!userEmail || !userEmail.includes('@')) {
      if (gdprError) { gdprError.textContent = 'Please enter a valid email address.'; gdprError.style.display = 'block'; }
      return;
    }
    if (gdprError) gdprError.style.display = 'none';
    gdprGenerateBtn.textContent = 'Generating\u2026';
    gdprGenerateBtn.disabled = true;

    _browser.storage.session.get(['authToken', 'authTokenExpiry'], async ({ authToken, authTokenExpiry }) => {
      const apiUrl = await new Promise(r => _browser.storage.local.get({ apiUrl: 'https://tldr-shield-292798741977.us-central1.run.app/api/analyze' }, d => r(d.apiUrl)));
      const validToken = authToken && authTokenExpiry > Date.now() ? authToken : null;
      if (!validToken) {
        if (gdprError) { gdprError.textContent = 'Sign in to generate emails.'; gdprError.style.display = 'block'; }
        gdprGenerateBtn.textContent = 'Generate Email (5 credits)';
        gdprGenerateBtn.disabled = false;
        return;
      }

      const base = (apiUrl || 'https://tldr-shield-292798741977.us-central1.run.app').replace(/\/api\/analyze$/, '');
      const violations = Object.entries(lastResult?.pillars ?? {})
        .filter(([, v]) => v?.violation)
        .map(([k]) => k);
      const companyName = lastResult?.url
        ? new URL(lastResult.url).hostname.replace(/^www\./, '')
        : 'this company';

      try {
        const resp = await fetch(`${base}/api/gdpr-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
          body: JSON.stringify({ companyName, userEmail, siteUrl: lastResult?.url, violations }),
        });
        const json = await resp.json();
        if (!resp.ok) {
          if (gdprError) { gdprError.textContent = json.error ?? 'Generation failed.'; gdprError.style.display = 'block'; }
        } else {
          if (gdprSubjectLabel) gdprSubjectLabel.textContent = `Subject: ${json.subject}`;
          if (gdprBodyArea) gdprBodyArea.value = json.body;
          if (gdprResult) gdprResult.style.display = 'block';
        }
      } catch {
        if (gdprError) { gdprError.textContent = 'Network error. Please try again.'; gdprError.style.display = 'block'; }
      } finally {
        gdprGenerateBtn.textContent = 'Generate Email (5 credits)';
        gdprGenerateBtn.disabled = false;
      }
    });
  });
}

// ── GDPR copy ────────────────────────────────────────────────────────────────
if (gdprCopyBtn) {
  gdprCopyBtn.addEventListener('click', () => {
    const subject = gdprSubjectLabel?.textContent ?? '';
    const body = gdprBodyArea?.value ?? '';
    navigator.clipboard.writeText(`${subject}\n\n${body}`).then(() => {
      gdprCopyBtn.textContent = 'Copied! \u2713';
      setTimeout(() => { gdprCopyBtn.textContent = 'Copy to Clipboard'; }, 2000);
    });
  });
}

// ── On load: check auth, then request last result ───────────────────────────
function init() {
  showEmpty();

  // Check auth state
  _browser.runtime.sendMessage({ type: 'GET_AUTH' }, (response) => {
    if (_browser.runtime.lastError) return;
    if (signinPrompt) {
      signinPrompt.style.display = (response && response.valid === false) ? 'block' : 'none';
    }
  });

  // Request the last cached scan result from background.js
  _browser.runtime.sendMessage({ type: 'GET_LAST_RESULT' }, (response) => {
    if (_browser.runtime.lastError) return;
    if (response && response.data && response.data.data) {
      const { tabId, timestamp, data } = response.data;
      showResult(data);
      
      // H-1: Check if stale
      _browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTabId = tabs[0]?.id;
        const isStale = (Date.now() - timestamp > 2 * 60 * 60 * 1000) || (tabId !== currentTabId);
        const staleBanner = document.getElementById('stale-banner');
        if (staleBanner) {
          staleBanner.style.display = isStale ? 'flex' : 'none';
        }
      });
    } else if (response && response.data) {
      showResult(response.data);
    }
  });
}

init();
