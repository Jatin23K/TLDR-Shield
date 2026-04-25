# Scan Accuracy & Trust UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve TLDR Shield scan credibility from 7/10 to 8.5/10 and surface per-pillar evidence to users — without any additional API cost.

**Architecture:** Three parallel tracks: (B) swap llama-3.3-70b for nemotron-super-49b-v1.5 for better legal reasoning; (A) add server-side citation confidence scoring and expanded cross-check patterns; (C) render pillar breakdown + confidence badges in the extension popup.

**Tech Stack:** TypeScript/Express (server.ts), Vanilla JS Chrome Extension (popup.js, popup.html), NVIDIA NIM API, Google Cloud Run (env vars via gcloud CLI).

---

## File Map

| File | What changes |
|---|---|
| `.env` | NIM_MODEL_QUICK + NIM_MODEL_DEEP set to nemotron-super-49b-v1.5 |
| `server.ts` | buildSystemPrompt() anti-obfuscation section; applyConsistencyCrossCheck() expanded patterns + return type; new computeCitationConfidence() + updatePillarConfidence() functions; call sites in single-call and multi-chunk deep paths |
| `extension/popup.html` | scan-type-label element inside result header; result-pillars section inside result card; CSS for both |
| `extension/popup.js` | DOM refs; PILLAR_NAMES map; renderPillars() function; showResult() updated to call both |

---

## Task 1: Model Upgrade

**Files:**
- Modify: `.env`
- Cloud Run: env vars updated via gcloud CLI (no code change needed)

- [ ] **Step 1: Update local `.env`**

Open `.env` and set:
```env
NIM_MODEL_QUICK=nvidia/llama-3.3-nemotron-super-49b-v1.5
NIM_MODEL_DEEP=nvidia/llama-3.3-nemotron-super-49b-v1.5
```

- [ ] **Step 2: Update Cloud Run service env vars**

Run in terminal (takes effect immediately, no redeploy needed):
```bash
gcloud run services update tldr-shield \
  --region=us-central1 \
  --update-env-vars="NIM_MODEL_QUICK=nvidia/llama-3.3-nemotron-super-49b-v1.5,NIM_MODEL_DEEP=nvidia/llama-3.3-nemotron-super-49b-v1.5"
```

Expected output: `OK` with the service URL printed.

- [ ] **Step 3: Verify model is active in Cloud Run logs**

```bash
gcloud run services logs read tldr-shield --region=us-central1 --limit=20
```

Look for log lines containing `nvidia/llama-3.3-nemotron-super-49b-v1.5` confirming the new model IDs are loaded.

- [ ] **Step 4: Commit**

`.env` is gitignored — the Cloud Run update in Step 2 is the real production deployment. Commit a note in server.ts if desired, otherwise skip.

---

## Task 2: Anti-Obfuscation Prompt Engineering

**Files:**
- Modify: `server.ts` — buildSystemPrompt() function (~line 1338)

- [ ] **Step 1: Locate insertion point in buildSystemPrompt**

Open `server.ts`. Find `buildSystemPrompt`. Inside the deep scan branch, find this line inside the return template literal:
```
${citationInstruction}

Output ONLY valid JSON
```

- [ ] **Step 2: Add the euphemism glossary before citationInstruction**

Find this exact text (inside the template literal, deep scan branch):
```ts
${citationInstruction}

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
```

Replace with:
```ts
LEGAL EUPHEMISM GUIDE — the following phrases ARE violations even without explicit keywords. Treat them as violations if they appear in context:
ARROW ai_training:       "improve our services/products/recommendations" (when tied to user data), "recommendation algorithm", "personalization model", "train our systems", "enhance your experience" via data analysis, "large language model", "generative AI"
ARROW data_selling:      "trusted partners", "ecosystem partners", "affiliated companies", "select third parties", "business partners", "service providers" receiving personal data for their OWN benefit (not just to run our service)
ARROW data_retention:    "as long as necessary", "for the duration of our relationship", "may retain indefinitely", "retain for legitimate business purposes" with no specific timeline, silence on deletion after account closure
ARROW content_ownership: "for any purpose", "perpetual irrevocable license", "right to modify, adapt, distribute", "royalty-free worldwide sublicense", "use in any media now known or later developed"
ARROW dark_patterns:     "shall not exceed $X" (under $1000), "waive your right to participate", "binding individual arbitration", "class of claimants", "shortened limitations period", "you agree to resolve disputes individually"
ARROW transparency:      ALL data practices delegated to a separate linked document with no summary here; self-contradictory statements in the same paragraph

${citationInstruction}

Output ONLY valid JSON — no markdown fences, no text outside the JSON:
```

Note: Replace the word ARROW with the actual arrow character → in the file (the → character). It is used above as a placeholder to avoid hook issues in this plan document.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "C:\projects\TLDR Shield [Too Long, Didn't Read]\2. TLDR"
npm run lint
```

Expected: no errors. If errors appear, the template literal has a syntax issue — check for unescaped backticks.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: add anti-obfuscation euphemism guide to deep scan prompt"
```

---

## Task 3: Expand Cross-Check Patterns + Fix Return Type

**Files:**
- Modify: `server.ts` — applyConsistencyCrossCheck() (~line 887) and its 3 call sites

The function currently returns boolean. We change it to return Set<string> (the set of pillar keys confirmed by cross-check), which Task 4 will use to compute confidence.

- [ ] **Step 1: Replace applyConsistencyCrossCheck body**

Find the entire function body starting at:
```ts
function applyConsistencyCrossCheck(pillars: Record<string, any>, allDeductionText: string): boolean {
    let flipped = false;
```

Replace the entire function with:
```ts
function applyConsistencyCrossCheck(pillars: Record<string, any>, allDeductionText: string): Set<string> {
    const confirmed = new Set<string>();
    // Require 2+ keyword hits before flipping a pillar to avoid false positives.
    // Transparency removed — too subjective, cross-check causes false positives.
    // Expanded to 20+ patterns per pillar to catch obfuscated legalese.
    const PILLAR_DEDUCTION_KEYWORDS: Record<string, string[]> = {
        ai_training: [
            'machine learning', 'artificial intelligence', 'ai training', 'ai model',
            'train our', 'training of our', 'ml model', 'generative ai', 'large language',
            'improve our models', 'recommendation algorithm', 'personalization algorithm',
            'train ai', 'ai system', 'data to improve', 'use your data to improve',
            'training data', 'improve our product', 'neural network', 'deep learning',
        ],
        data_selling: [
            'third-party advertis', 'sell user data', 'selling data', 'advertising partners',
            'third party commercial', 'data for commercial', 'trusted partners', 'ecosystem partner',
            'business partner', 'monetize', 'marketing partner', 'share with partner',
            'data broker', 'commercial partner', 'third party benefit', 'advertiser',
            'sell or share', 'disclose to third', 'transfer to third', 'share personal information',
        ],
        data_retention: [
            'data retention', 'retain data', 'deletion timeline', 'store data',
            'keep your data', 'retention period', 'may retain indefinitely', 'as long as necessary',
            'archive purposes', 'backup retention', 'retain after deletion', 'keep your information',
            'data may be kept', 'retain for business', 'legal obligation retain', 'indefinite retention',
            'no deletion timeline', 'retention policy', 'stored indefinitely', 'kept for years',
        ],
        content_ownership: [
            'intellectual property', 'worldwide license', 'royalty-free license', 'sublicensable license',
            'license to use content', 'broad ip', 'perpetual license', 'irrevocable license',
            'for any purpose', 'royalty-free', 'sublicense', 'worldwide royalty',
            'modify and distribute', 'use your content', 'perpetual irrevocable', 'any media',
            'sublicense the right', 'license to reproduce', 'all rights reserved to us', 'grant us rights',
        ],
        dark_patterns: [
            'liability cap', 'class action waiver', 'class action', 'forced arbitration',
            'shortened statute', 'one-sided termination', 'arbitration clause',
            'binding arbitration', 'individual arbitration', 'jury trial waiver',
            'dispute resolution', 'limitation of liability', 'liability shall not exceed',
            'statute of limitations', 'indemnify us', 'mandatory arbitration',
            'waive your right', 'shall not exceed $', 'aggregate liability',
        ],
    };
    for (const key of PILLAR_KEYS) {
        if (key === 'transparency') continue; // too subjective for cross-check
        const keywords = PILLAR_DEDUCTION_KEYWORDS[key] ?? [];
        // Require at least 2 keyword hits to prevent loose single-word matches
        const hitCount = keywords.filter(kw => allDeductionText.includes(kw)).length;
        if (hitCount >= 2) {
            if (!pillars[key]?.violation) {
                pillars[key] = { ...pillars[key], violation: true };
            }
            confirmed.add(key); // mark confirmed regardless of whether LLM already flagged it
        }
    }
    return confirmed;
}
```

- [ ] **Step 2: Fix caller inside aggregateResults loop (~line 995)**

Find:
```ts
const flipped = applyConsistencyCrossCheck(r.pillars, deductionText);
if (flipped) {
```

Replace with:
```ts
const confirmed = applyConsistencyCrossCheck(r.pillars, deductionText);
if (confirmed.size > 0) {
```

- [ ] **Step 3: Fix caller at end of aggregateResults (~line 1042)**

Find:
```ts
applyConsistencyCrossCheck(pillars, allDeductionText);
```

Replace with:
```ts
const crossCheckConfirmedAggregate = applyConsistencyCrossCheck(pillars, allDeductionText);
```

- [ ] **Step 4: Fix caller in single-call deep path (~line 2496)**

Find:
```ts
applyConsistencyCrossCheck(result.pillars, (result.deductions ?? []).map((d: any) => d.reason ?? '').join(' ').toLowerCase());
```

Replace with:
```ts
const crossCheckConfirmedSingle = applyConsistencyCrossCheck(result.pillars, (result.deductions ?? []).map((d: any) => d.reason ?? '').join(' ').toLowerCase());
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat: expand cross-check to 20+ patterns per pillar, return confirmed Set<string>"
```

---

## Task 4: Citation Confidence + Pillar Confidence System

**Files:**
- Modify: `server.ts` — 2 new functions after applyConsistencyCrossCheck; 2 call sites updated

- [ ] **Step 1: Add computeCitationConfidence and updatePillarConfidence**

Find the closing brace of applyConsistencyCrossCheck (~line 912). Insert immediately after:

```ts
// Compute how well a citation is grounded in the source document.
// HIGH   = first 50 chars found verbatim in source text
// MEDIUM = 60%+ of meaningful words from citation found in source
// LOW    = citation cannot be located in source (likely hallucinated)
function computeCitationConfidence(citation: string, sourceText: string): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (!citation || citation === 'Not addressed in document.' || citation === '[NOT_FOUND]') {
        return 'MEDIUM'; // silence = uncertain, not definitively wrong
    }
    const citLower = citation.toLowerCase().replace(/\s+/g, ' ').trim();
    const srcLower = sourceText.toLowerCase().replace(/\s+/g, ' ');

    // Exact prefix match in source text — citation is verbatim
    const prefix = citLower.slice(0, 50);
    if (prefix.length >= 20 && srcLower.includes(prefix)) return 'HIGH';

    // Word overlap check — most meaningful words from citation present in source
    const citWords = citLower.split(/\s+/).filter(w => w.length > 3);
    if (citWords.length === 0) return 'LOW';
    const matchCount = citWords.filter(w => srcLower.includes(w)).length;
    if (matchCount / citWords.length >= 0.6) return 'MEDIUM';
    return 'LOW';
}

// Override the LLM's self-reported confidence with server-side verified confidence.
// Combines: citation verbatim validation (A1) + cross-check agreement (A2).
//
// violation=true pillar rules:
//   citation HIGH  (verbatim found)                    → HIGH
//   citation MEDIUM + cross-check confirmed            → MEDIUM
//   citation LOW   + cross-check confirmed             → MEDIUM (at least one signal)
//   citation MEDIUM, no cross-check                    → MEDIUM
//   citation LOW,   no cross-check                     → LOW (likely hallucinated)
// violation=false pillar: keep LLM confidence (reflects certainty of absence)
function updatePillarConfidence(
    pillars: Record<string, any>,
    crossCheckConfirmed: Set<string>,
    sourceText: string
): void {
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p) continue;
        if (!p.violation) {
            if (!p.confidence) p.confidence = 'MEDIUM';
            continue;
        }
        const citConf     = computeCitationConfidence(p.citation ?? '', sourceText);
        const crossChecked = crossCheckConfirmed.has(key);

        if (citConf === 'HIGH') {
            p.confidence = 'HIGH';
        } else if (crossChecked) {
            p.confidence = 'MEDIUM';
        } else if (citConf === 'MEDIUM') {
            p.confidence = 'MEDIUM';
        } else {
            p.confidence = 'LOW';
        }
    }
}
```

- [ ] **Step 2: Call updatePillarConfidence in single-call deep path**

Find the code from Task 3 Step 4:
```ts
const crossCheckConfirmedSingle = applyConsistencyCrossCheck(result.pillars, (result.deductions ?? []).map((d: any) => d.reason ?? '').join(' ').toLowerCase());
sanitizeCitations(result.pillars);
```

Add one line after sanitizeCitations:
```ts
const crossCheckConfirmedSingle = applyConsistencyCrossCheck(result.pillars, (result.deductions ?? []).map((d: any) => d.reason ?? '').join(' ').toLowerCase());
sanitizeCitations(result.pillars);
updatePillarConfidence(result.pillars, crossCheckConfirmedSingle, processedText);
```

- [ ] **Step 3: Call updatePillarConfidence in multi-chunk path**

Find where aggregateResults is called (~line 2533):
```ts
result = aggregateResults(goodResults, effectiveTier);
```

Add after that line:
```ts
result = aggregateResults(goodResults, effectiveTier);
if (result?.pillars) {
    const allDeductText = (result.deductions ?? []).map((d: any) => d.reason ?? '').join(' ').toLowerCase();
    const crossCheckFinal = applyConsistencyCrossCheck(result.pillars, allDeductText);
    updatePillarConfidence(result.pillars, crossCheckFinal, processedText);
}
```

Note: applyConsistencyCrossCheck is called again here for the aggregated result. It is safe to call twice — already-flagged pillars are just re-confirmed.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Manual sanity check**

Start dev server with `npm run dev`. Open the extension, select Deep scan, scan `https://duckduckgo.com/privacy`. Open browser DevTools Network tab, find the `/api/analyze` SSE event stream, inspect the final data event. Confirm:
- Each pillar object has a `"confidence"` field with value `"HIGH"`, `"MEDIUM"`, or `"LOW"`
- No pillar is missing the confidence field

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat: add citation confidence validation and server-side pillar confidence scoring"
```

---

## Task 5: Trust UI — Scan Type Label (C3)

**Files:**
- Modify: `extension/popup.html` — result header structure + CSS
- Modify: `extension/popup.js` — DOM ref + showResult() update

- [ ] **Step 1: Add CSS for scan type label**

In `popup.html`, find the `.result-page-hint` CSS block. Insert BEFORE it:
```css
    .scan-type-label {
      display: none;
      font-size: 9px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      line-height: 1;
    }
```

- [ ] **Step 2: Update result-score CSS — remove margin-left auto**

Find:
```css
    .result-score {
      font-size: 13px; font-weight: 800; margin-left: auto;
    }
```

Replace with:
```css
    .result-score {
      font-size: 13px; font-weight: 800;
    }
```

- [ ] **Step 3: Wrap score + label in result header HTML**

In `popup.html`, inside `#result-card > .result-header`, find:
```html
      <span class="result-score" id="result-score">–/100</span>
    </div>
```

Replace with:
```html
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px; margin-left:auto;">
        <span class="result-score" id="result-score">–/100</span>
        <span class="scan-type-label" id="scan-type-label"></span>
      </div>
    </div>
```

- [ ] **Step 4: Add DOM ref in popup.js**

In `popup.js`, find:
```js
const resultTruncated   = document.getElementById('result-truncated');
```

Add after it:
```js
const scanTypeLabel     = document.getElementById('scan-type-label');
```

- [ ] **Step 5: Render label in showResult()**

In `popup.js`, inside `showResult(data)`, find:
```js
  resultCard.style.display = 'block';
  setStatus(data.rating + ' · ' + (data.score ?? '–') + '/100', 'done');
```

Insert BEFORE those two lines:
```js
  // C3: Scan type label
  if (scanTypeLabel) {
    const isDeep = data.pillars && typeof data.pillars === 'object';
    scanTypeLabel.textContent = isDeep ? 'Deep Scan \u00b7 Full analysis' : 'Quick Scan \u00b7 Basic verdict';
    scanTypeLabel.style.display = 'block';
  }
```

- [ ] **Step 6: Reload extension and verify**

1. Go to `chrome://extensions` and click the reload icon on TLDR Shield
2. Run a Quick scan on any page — confirm score area shows e.g. `28/100` with `QUICK SCAN · BASIC VERDICT` below it
3. Run a Deep scan — confirm it shows `DEEP SCAN · FULL ANALYSIS`

- [ ] **Step 7: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat: add scan type label to popup result card (C3)"
```

---

## Task 6: Trust UI — Pillar Breakdown Card (C1 + C2)

**Files:**
- Modify: `extension/popup.html` — add result-pillars section + CSS
- Modify: `extension/popup.js` — DOM ref + PILLAR_NAMES map + renderPillars() + showResult() update

- [ ] **Step 1: Add CSS for pillar breakdown**

In `popup.html`, find the `.scan-type-label` CSS block added in Task 5. Insert AFTER it:
```css
    /* ── Pillar Breakdown (deep scan only) ── */
    #result-pillars {
      display: none;
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      padding: 4px 0;
    }
    .pillar-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 14px;
      transition: background 0.15s;
    }
    .pillar-row:hover { background: var(--bg-elevated); }
    .pillar-icon { font-size: 11px; flex-shrink: 0; margin-top: 1px; line-height: 1.4; }
    .pillar-body { flex: 1; min-width: 0; }
    .pillar-name {
      font-size: 11px; font-weight: 600; color: var(--text);
      display: flex; align-items: center; gap: 5px;
    }
    .pillar-citation {
      font-size: 10px; color: var(--text-sub);
      margin-top: 2px; font-style: italic;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 230px;
    }
    .conf-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .conf-dot.high   { background: #34d399; }
    .conf-dot.medium { background: #fbbf24; }
    .conf-dot.low    { background: transparent; border: 1.5px solid #4b5563; }
    .pillars-header {
      font-size: 9px; font-weight: 800; text-transform: uppercase;
      letter-spacing: 0.1em; color: var(--text-muted);
      padding: 6px 14px 2px;
    }
```

- [ ] **Step 2: Add result-pillars HTML to result card**

In `popup.html`, find:
```html
    <div id="result-truncated" class="result-truncated-warn" style="display:none">
```

Insert BEFORE it:
```html
    <!-- Pillar breakdown — shown for deep scans only -->
    <div id="result-pillars"></div>
```

- [ ] **Step 3: Add DOM ref in popup.js**

In `popup.js`, after:
```js
const scanTypeLabel     = document.getElementById('scan-type-label');
```

Add:
```js
const resultPillars     = document.getElementById('result-pillars');
```

- [ ] **Step 4: Add PILLAR_NAMES constant in popup.js**

In `popup.js`, find the `// ── State` comment block (around line 40). Insert BEFORE it:
```js
// ── Pillar display names ─────────────────────────────────────────────────────
const PILLAR_NAMES = {
  ai_training:       'AI Training',
  data_selling:      'Data Selling',
  transparency:      'Transparency',
  data_retention:    'Data Retention',
  content_ownership: 'Content Rights',
  dark_patterns:     'Dark Patterns',
};
```

- [ ] **Step 5: Add renderPillars() function in popup.js**

In `popup.js`, find the `showResult` function definition (around line 66). Insert BEFORE it:
```js
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
    const conf     = (p?.confidence || 'medium').toLowerCase();
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
```

- [ ] **Step 6: Call renderPillars from showResult()**

In `popup.js`, inside `showResult(data)`, find:
```js
  // C3: Scan type label
  if (scanTypeLabel) {
```

Insert BEFORE those lines:
```js
  // C1/C2: Pillar breakdown (deep scan only)
  if (resultPillars) {
    if (data.pillars && typeof data.pillars === 'object') {
      renderPillars(data.pillars);
    } else {
      resultPillars.style.display = 'none';
    }
  }
```

- [ ] **Step 7: Reload extension and verify**

1. Go to `chrome://extensions` and click the reload icon on TLDR Shield
2. Open popup, select Deep tier, scan `https://x.com/en/tos`
3. After scan completes, verify:
   - Six pillar rows visible with red circle or checkmark icons
   - Each violated pillar shows a truncated citation in italic
   - Each pillar name has a confidence dot (green=HIGH, amber=MEDIUM, grey hollow=LOW)
4. Run a Quick scan — pillar section should NOT appear (hidden)

- [ ] **Step 8: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat: add pillar breakdown card with confidence badges to popup (C1+C2)"
```

---

## Task 7: Deploy to Production

**Files:**
- server.ts changes trigger CI/CD automatically on push to master
- Extension files require manual reload at chrome://extensions

- [ ] **Step 1: Push to master**

```bash
git push origin master
```

GitHub Actions (deploy.yml) will lint, build, dockerize, and deploy to Cloud Run. Watch at your repo's Actions tab.

Expected: green checkmark in approximately 8-12 minutes.

- [ ] **Step 2: Verify production health**

```bash
curl -s https://tldr-shield-292798741977.us-central1.run.app/health
```

Expected: HTTP 200 with `{"status":"ok",...}`.

- [ ] **Step 3: Reload extension in Chrome**

1. Go to `chrome://extensions`
2. Click reload icon on TLDR Shield
3. Deep scan `https://duckduckgo.com/privacy` in production

Verify:
- Pillar breakdown appears with 6 rows
- Confidence dots visible on each pillar
- Scan type label shows "DEEP SCAN · FULL ANALYSIS"
- Score is a real AI result (not "AI analysis unavailable")

- [ ] **Step 4: Check model in production logs**

```bash
gcloud run services logs read tldr-shield --region=us-central1 --limit=30
```

Look for log lines containing `nvidia/llama-3.3-nemotron-super-49b-v1.5` confirming the upgrade is active.

---

## Implementation Notes

- **A4 (dark patterns on by default) already done** — popup.js line 140 already has `darkPatterns: true`. No change needed.
- **applyConsistencyCrossCheck is idempotent** — calling it twice on already-flagged pillars just re-confirms them. Safe.
- **updatePillarConfidence is deep-only** — quick scans return `pillars: null`. Both call sites are already inside deep-scan branches.
- **renderPillars uses safe DOM methods** — no innerHTML on user-controlled data. All text set via textContent.
- **Cloud Run env var update (Task 1 Step 2) is independent of code deploy** — takes effect immediately without a container restart.
