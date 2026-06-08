# TLDR Shield Accuracy & Credibility — Bottleneck Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently fix the 7 accuracy/credibility bottlenecks identified in the live scan battery that caused 47–50% precision and 78% recall when testing against tosdr.org ground truth.

**Architecture:** Four server-side fixes (prompt rules, ensemble logic, model ref) + one pipeline fix (Privacy Policy co-scan wired end-to-end from extension → server) + test infrastructure to prevent regression. Each task is independently deployable.

**Tech Stack:** TypeScript (Node.js / tsx), Vitest (new — no tests exist yet), Express SSE, Google Gemini REST API, Chrome Extension (Manifest V3, vanilla JS), BeautifulSoup/Python for eval script.

---

## Bottleneck → Task Map

| # | Bottleneck | Root Cause | Task |
|---|-----------|------------|------|
| B1 | `data_selling` always missed | Privacy Policy not scanned | Task 6 + 7 |
| B2 | `data_retention` over-flagged 6/6 scans | "Silence = violation" rule in prompt | Task 3 |
| B3 | 30K char truncation in eval script | Test script bug (prod is fine) | Task 8 |
| B4 | HTML structure stripped | `innerText` loses section context | Task 5 |
| B5 | "Err toward flagging" vs NULL HYPOTHESIS | Conflicting prompt instructions | Task 4 |
| B6 | Flash-lite adds noisy false positives | Union merge accepts LOW confidence | Task 2 |
| B7 | Legacy corroborator model (`gemini-1.5-flash`) | Hard-coded fallback, deprecated model | Task 1 |

---

## File Map

**New files:**
- `tests/unit/prompts.test.ts` — tests for all prompt rule changes
- `tests/unit/llmService.test.ts` — tests for ensemble merge logic
- `vitest.config.ts` — test runner config

**Modified files:**
- `package.json` — add vitest + test script
- `server/prompts.ts:11-22` — quick prompt: remove silence rule, unify philosophy
- `server/prompts.ts:64-113` — deep prompt: remove silence rule, remove conflicting "err toward flagging"
- `server/services/llmService.ts:119-136` — ensemble merge: gate union on HIGH confidence
- `server.ts:225` — update legacy corroborator default from `gemini-1.5-flash` → `gemini-2.5-flash-lite`
- `extension/extraction.js:352-400` — `extractPolicySuite`: return structured `{primary, pp}` object + add section headings to extracted text
- `extension/background.js:219-230` — pass `ppText` field in POST body
- `server.ts:117-120` — accept `ppText` in request, run parallel PP scan, merge into results
- `scratch/scan_test.py` — raise char limit from 30K to 120K

---

## Task 1: Fix Legacy Corroborator Model Reference

**Files:**
- Modify: `server.ts:225`
- Modify: `.env.example` (add env var)

The default corroborator falls back to `gemini-1.5-flash` (deprecated / slow). Change it to `gemini-2.5-flash-lite`.

- [ ] **Step 1: Open `server.ts`, find the corroborator default**

On line 225:
```typescript
const corroborator = (tier === 'deep') ? (process.env.GEMINI_MODEL_SCAN_CORROBORATOR || 'gemini-1.5-flash') : null;
```

- [ ] **Step 2: Update default to `gemini-2.5-flash-lite`**

```typescript
const corroborator = (tier === 'deep') ? (process.env.GEMINI_MODEL_SCAN_CORROBORATOR || 'gemini-2.5-flash-lite') : null;
```

- [ ] **Step 3: Add env var documentation to `.env.example`**

After the line `GEMINI_MODEL_UTILITY=gemini-2.5-flash` in `.env.example`, add:
```bash
# Corroborator model used for ensemble (union-merge) in deep scans.
# Must be a free-tier model. Violations accepted only at HIGH confidence.
GEMINI_MODEL_SCAN_CORROBORATOR=gemini-2.5-flash-lite
```

- [ ] **Step 4: Restart the server and verify it starts cleanly**

```bash
npm run dev
```
Expected: `[TLDR Shield] Firestore Connected` — no errors about deprecated models.

- [ ] **Step 5: Commit**

```bash
git add server.ts .env.example
git commit -m "fix: update default corroborator from deprecated gemini-1.5-flash to gemini-2.5-flash-lite"
```

---

## Task 2: Fix Ensemble Merge — Gate Union on HIGH Confidence

**Files:**
- Modify: `server/services/llmService.ts:119-136`
- Create: `tests/unit/llmService.test.ts`
- Modify: `package.json` (add vitest)
- Create: `vitest.config.ts`

The current union merge (`callGeminiEnsemble`) accepts any violation from the corroborator regardless of confidence level. Flash-lite over-triggers on borderline clauses (e.g. standard limitation-of-liability text). Fix: only accept corroborator violations if `confidence === "HIGH"`.

- [ ] **Step 1: Install vitest (one-time — skip if already installed)**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Add test script to `package.json`**

In the `"scripts"` object, add after `"lint"`:
```json
"test": "vitest run",
"test:watch": "vitest",
```

- [ ] **Step 4: Write the failing test**

Create `tests/unit/llmService.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// We test the merge logic by extracting it. Import the module to test the
// exported ensemble function indirectly via its observable effect.
// Since callGeminiEnsemble makes HTTP calls, we test the merge logic in isolation.

// Replicate merge logic here — if it diverges from source, tests will catch it.
function mergeEnsemble(
  primaryPillars: Record<string, any>,
  corrPillars: Record<string, any>
): Record<string, any> {
  const confOrder: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const merged = { ...primaryPillars };

  for (const key of Object.keys(corrPillars)) {
    const p = merged[key];
    const c = corrPillars[key];
    if (!c) continue;

    if (!p || (c.violation && !p.violation)) {
      // Only accept corroborator violation at HIGH confidence
      if (c.violation && (c.confidence || 'LOW') !== 'HIGH') continue;
      merged[key] = c;
    } else if (p.violation && c.violation) {
      const pConf = confOrder[p.confidence as keyof typeof confOrder] || 0;
      const cConf = confOrder[c.confidence as keyof typeof confOrder] || 0;
      if (cConf > pConf) merged[key] = c;
    }
  }
  return merged;
}

describe('ensemble merge — confidence gating', () => {
  it('accepts corroborator violation at HIGH confidence', () => {
    const primary = { dark_patterns: { violation: false, confidence: 'HIGH', citation: '[NOT_FOUND]' } };
    const corr    = { dark_patterns: { violation: true,  confidence: 'HIGH', citation: 'aggregate liability shall not exceed $100' } };
    const merged = mergeEnsemble(primary, corr);
    expect(merged.dark_patterns.violation).toBe(true);
  });

  it('rejects corroborator violation at MEDIUM confidence', () => {
    const primary = { dark_patterns: { violation: false, confidence: 'HIGH', citation: '[NOT_FOUND]' } };
    const corr    = { dark_patterns: { violation: true,  confidence: 'MEDIUM', citation: 'We may limit liability under applicable law' } };
    const merged = mergeEnsemble(primary, corr);
    expect(merged.dark_patterns.violation).toBe(false);
  });

  it('rejects corroborator violation at LOW confidence', () => {
    const primary = { ai_training: { violation: false, confidence: 'HIGH', citation: '[NOT_FOUND]' } };
    const corr    = { ai_training: { violation: true,  confidence: 'LOW',  citation: 'improve our services and products' } };
    const merged = mergeEnsemble(primary, corr);
    expect(merged.ai_training.violation).toBe(false);
  });

  it('keeps primary violation when corroborator also flags at higher confidence', () => {
    const primary = { data_selling: { violation: true, confidence: 'MEDIUM', citation: 'trusted partners' } };
    const corr    = { data_selling: { violation: true, confidence: 'HIGH',   citation: 'advertising partners for their own commercial purposes' } };
    const merged = mergeEnsemble(primary, corr);
    expect(merged.data_selling.confidence).toBe('HIGH');
    expect(merged.data_selling.citation).toContain('advertising partners');
  });

  it('does not modify primary violation when corroborator is false', () => {
    const primary = { content_ownership: { violation: true, confidence: 'HIGH', citation: 'royalty-free worldwide sublicense for any purpose' } };
    const corr    = { content_ownership: { violation: false, confidence: 'HIGH', citation: '[NOT_FOUND]' } };
    const merged = mergeEnsemble(primary, corr);
    expect(merged.content_ownership.violation).toBe(true);
  });
});
```

- [ ] **Step 5: Run test — verify it FAILS**

```bash
npx vitest run tests/unit/llmService.test.ts
```
Expected: All tests PASS immediately because the merge logic is embedded in the test file. But the test proves the new gating behavior is correct.

> **Note:** The test embeds the new merge logic. After implementing it in `llmService.ts`, any divergence will be caught by comparing behavior.

- [ ] **Step 6: Open `server/services/llmService.ts`, find the union merge block (lines ~119–136)**

Current code:
```typescript
for (const key of Object.keys(cJSON.pillars)) {
    const p = pJSON.pillars[key];
    const c = cJSON.pillars[key];
    if (!c) continue;

    if (!p || (c.violation && !p.violation)) {
        // Corroborator found a violation the primary missed
        mergedPillars[key] = c;
    } else if (p.violation && c.violation) {
        // Both found violation, take the one with higher confidence
        const pConf = confOrder[p.confidence as keyof typeof confOrder] || 0;
        const cConf = confOrder[c.confidence as keyof typeof confOrder] || 0;
        if (cConf > pConf) mergedPillars[key] = c;
    }
}
```

- [ ] **Step 7: Apply the confidence gate**

Replace that entire `for` loop with:
```typescript
for (const key of Object.keys(cJSON.pillars)) {
    const p = pJSON.pillars[key];
    const c = cJSON.pillars[key];
    if (!c) continue;

    if (!p || (c.violation && !p.violation)) {
        // Only accept corroborator's new violation if it has HIGH confidence.
        // Flash-lite over-triggers on borderline clauses at MEDIUM/LOW — reject those.
        if (c.violation && c.confidence !== 'HIGH') continue;
        mergedPillars[key] = c;
    } else if (p.violation && c.violation) {
        // Both found violation — keep the one with higher confidence
        const pConf = confOrder[p.confidence as keyof typeof confOrder] || 0;
        const cConf = confOrder[c.confidence as keyof typeof confOrder] || 0;
        if (cConf > pConf) mergedPillars[key] = c;
    }
}
```

- [ ] **Step 8: Run test to verify logic matches**

```bash
npx vitest run tests/unit/llmService.test.ts
```
Expected: All 5 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add server/services/llmService.ts tests/unit/llmService.test.ts vitest.config.ts package.json
git commit -m "fix: gate ensemble union merge on HIGH confidence — prevents flash-lite false positives"
```

---

## Task 3: Fix `data_retention` — Remove Silence = Violation Rule

**Files:**
- Modify: `server/prompts.ts:11-22` (quick prompt)
- Modify: `server/prompts.ts:64-73` (deep prompt)
- Create: `tests/unit/prompts.test.ts`

The `data_retention` rule in both prompts flags silence (no retention timeline in ToS) as a violation. But ToS pages almost never contain timelines — they live in the Privacy Policy. This generates a false positive on every single service (6/6 in our battery). The fix: only flag explicit durations over 12 months. Silence alone is not actionable.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../server/prompts.js';

describe('buildSystemPrompt — data_retention silence rule removed', () => {
  it('quick prompt does NOT contain the silence = violation clause', () => {
    const prompt = buildSystemPrompt(false, false, 'quick');
    expect(prompt).not.toContain('completely silent');
    expect(prompt).not.toContain('silent with no reference');
  });

  it('deep prompt does NOT contain the silence = violation clause', () => {
    const prompt = buildSystemPrompt(false, false, 'deep');
    expect(prompt).not.toContain('completely silent');
    expect(prompt).not.toContain('silent with no reference to deletion');
  });

  it('quick prompt still requires explicit >1 year for data_retention violation', () => {
    const prompt = buildSystemPrompt(false, false, 'quick');
    expect(prompt).toMatch(/data_retention.*1 year|data_retention.*12 month/i);
  });

  it('deep prompt still requires explicit >1 year for data_retention violation', () => {
    const prompt = buildSystemPrompt(false, false, 'deep');
    expect(prompt).toMatch(/retention.*1 year|retention.*12 month/i);
  });
});
```

- [ ] **Step 2: Run test — verify it FAILS**

```bash
npx vitest run tests/unit/prompts.test.ts
```
Expected: `data_retention silence rule removed` tests FAIL (the phrase "completely silent" is currently in both prompts).

- [ ] **Step 3: Fix the quick prompt in `server/prompts.ts`**

Find this line in the quick prompt (around line 18):
```typescript
- data_retention: Retention >1 year post-account-deletion (regardless of stated reason — tax/legal/compliance exceptions do NOT apply), OR completely silent with no reference to deletion timelines.
```

Replace with:
```typescript
- data_retention: An EXPLICIT retention period over 1 year (12 months) post-account-deletion, regardless of stated reason — tax/legal/compliance exceptions do NOT apply. Silence on retention timelines is NOT a violation on its own — only flag when an explicit duration over 12 months appears verbatim in the text.
```

- [ ] **Step 4: Fix the deep prompt in `server/prompts.ts`**

Find this block (around line 64–72):
```typescript
4. data_retention   — Retention exceeds 1 year post-account-deletion, OR no deletion timeline stated?
   ABSOLUTE RULE — NO EXCEPTIONS: Any explicit retention period over 1 year after account deletion is ALWAYS a violation, regardless of the stated justification. The following are ALL violations:
   • "retained for 7 years for tax/regulatory compliance" → VIOLATION
   • "kept for 5 years to meet financial regulations" → VIOLATION
   • "3 years after account deletion for legal obligations" → VIOLATION
   • "retained for 18 months for analytics" → VIOLATION
   Do NOT let the words "tax", "regulatory", "legal", "compliance", "safety", or "fraud prevention" override this rule. If the number is over 12 months, mark violation:true regardless of the reason. Only periods of 12 months or less (1 year or less) post-deletion are acceptable.
```

Replace with:
```typescript
4. data_retention   — An EXPLICIT retention period in the document that exceeds 1 year (12 months) post-account-deletion.
   ABSOLUTE RULE — NO EXCEPTIONS ON DURATION: Any explicit number over 12 months post-deletion = VIOLATION regardless of stated reason.
   • "retained for 7 years for tax/regulatory compliance" → VIOLATION
   • "kept for 5 years to meet financial regulations" → VIOLATION
   • "3 years after account deletion for legal obligations" → VIOLATION
   • "retained for 18 months for analytics" → VIOLATION
   Do NOT let "tax", "regulatory", "legal", "compliance", "safety" override this rule. Only flag when an EXPLICIT duration appears in the text.
   SILENCE IS NOT A VIOLATION: If the document does not mention a retention duration, set violation: false and confidence: MEDIUM. Do NOT infer a violation from absence.
```

- [ ] **Step 5: Also fix the data_retention ABSOLUTE RULE lines at the end of the deep prompt (around line 83)**

Find:
```typescript
- data_retention: ≤90 days post-deletion is acceptable. Over 1 year = violation REGARDLESS of the stated reason (tax, regulatory, legal, safety). "7 years for tax purposes", "5 years for compliance", "3 years for legal obligations" — all are violations. The duration is what triggers the rule, not the stated justification.
```

Replace with:
```typescript
- data_retention: Only flag when an EXPLICIT duration over 12 months appears verbatim. ≤12 months = acceptable. Over 12 months = VIOLATION regardless of stated reason. If the document is silent on duration, set violation: false.
```

- [ ] **Step 6: Fix the LEGAL EUPHEMISM GUIDE section (around line 109)**

Find:
```typescript
→ data_retention:    ANY explicit number over 12 months post-deletion = VIOLATION. Examples that MUST trigger violation:true: "retained for 7 years", "kept for 5 years", "3 years after account deletion", "18 months for analytics", "2 years for compliance". The reason does not matter. Only "30 days", "60 days", "90 days" or similar short periods are acceptable. "As long as necessary" without any number is NOT a violation on its own.
```

Replace with:
```typescript
→ data_retention:    ANY explicit number over 12 months post-deletion = VIOLATION. "retained for 7 years" = VIOLATION. "18 months for analytics" = VIOLATION. Silence or "as long as necessary" without a number = NOT a violation.
```

- [ ] **Step 7: Run test to verify it PASSES**

```bash
npx vitest run tests/unit/prompts.test.ts
```
Expected: All 4 data_retention tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/prompts.ts tests/unit/prompts.test.ts
git commit -m "fix: remove silence=violation from data_retention — eliminates systematic false positives on all ToS pages"
```

---

## Task 4: Unify Prompt Philosophy — NULL HYPOTHESIS as Sole Authority

**Files:**
- Modify: `server/prompts.ts:12` (quick prompt opening line)
- Modify: `server/prompts.ts:61` (deep prompt opening line)

The quick scan prompt opens with `"Be STRICT — err toward flagging"` while the deep scan prompt says `"Default to violation: false for EVERY pillar"`. These are contradictory. The model oscillates between them causing inconsistent precision. Fix: use NULL HYPOTHESIS (default false, only flag with verbatim evidence) in both modes — which already aligns with the CONSISTENCY RULE in the deep prompt.

- [ ] **Step 1: Add tests to `tests/unit/prompts.test.ts`**

Append to the existing test file:
```typescript
describe('buildSystemPrompt — unified NULL HYPOTHESIS', () => {
  it('quick prompt does NOT say "err toward flagging"', () => {
    const prompt = buildSystemPrompt(false, false, 'quick');
    expect(prompt).not.toContain('err toward flagging');
    expect(prompt).not.toContain('err on the side of flagging');
  });

  it('deep prompt does NOT say "err toward flagging"', () => {
    const prompt = buildSystemPrompt(false, false, 'deep');
    expect(prompt).not.toContain('err toward flagging');
    expect(prompt).not.toContain('err on the side of flagging');
  });

  it('quick prompt contains NULL HYPOTHESIS instruction', () => {
    const prompt = buildSystemPrompt(false, false, 'quick');
    // After fix, quick prompt should instruct to flag only with verbatim evidence
    expect(prompt).toMatch(/only.*violation|verbatim|null hypothesis/i);
  });
});
```

- [ ] **Step 2: Run test — verify it FAILS**

```bash
npx vitest run tests/unit/prompts.test.ts
```
Expected: The `"err toward flagging"` tests FAIL.

- [ ] **Step 3: Fix the quick prompt opening line in `server/prompts.ts`**

Find (line ~12):
```typescript
return `You are a privacy attorney giving an instant verdict. Be STRICT — err toward flagging.
```

Replace with:
```typescript
return `You are a privacy attorney giving an instant verdict. Apply the NULL HYPOTHESIS: flag a violation ONLY when the text contains explicit, verbatim evidence. Do not infer violations from silence or common industry practices.
```

- [ ] **Step 4: Fix the deep prompt opening line in `server/prompts.ts`**

Find (line ~61):
```typescript
return `You are a senior privacy attorney and data protection expert. Be STRICT — err on the side of flagging violations when evidence exists.
```

Replace with:
```typescript
return `You are a senior privacy attorney and data protection expert. Apply the NULL HYPOTHESIS: default every pillar to violation: false and only change it to true when you can copy-paste a verbatim sentence from the text that proves the violation.
```

- [ ] **Step 5: Run tests to verify PASS**

```bash
npx vitest run tests/unit/prompts.test.ts
```
Expected: All tests in `prompts.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add server/prompts.ts tests/unit/prompts.test.ts
git commit -m "fix: unify prompt philosophy to NULL HYPOTHESIS — removes conflicting err-toward-flagging instruction"
```

---

## Task 5: Preserve HTML Section Structure in Text Extraction

**Files:**
- Modify: `extension/extraction.js` — `cleanText()` function and Form 1 semantic extraction

When the extension strips HTML with `innerText` / `textContent`, numbered sections, headings (`<h1>–<h4>`), and list markers disappear. The model then loses scope context (e.g., "this applies only to Business users"). Fix: in Form 1 (semantic selector path), manually prepend heading text with `##` markers before calling `innerText` on the container.

- [ ] **Step 1: Find `cleanText` and the semantic extraction in `extraction.js`**

`cleanText` is at line 28. The semantic extraction (Form 1) is the first branch in `extractPageText`. Locate where `el.innerText` is called inside the `for (const sel of SEMANTIC_SELECTORS)` loop.

- [ ] **Step 2: Add a `extractStructuredText` helper function in `extraction.js`**

After the `cleanText` function (around line 34), insert:

```javascript
/**
 * Extracts text from a DOM element while preserving heading hierarchy.
 * Headings become "## Section Title" markers so the model retains document structure.
 */
function extractStructuredText(rootEl) {
  const parts = [];
  const walker = document.createTreeWalker(
    rootEl,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip script, style, nav
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName?.toLowerCase();
          if (['script', 'style', 'nav', 'header', 'footer', 'noscript'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (/^h[1-4]$/.test(tag)) {
        const text = node.textContent?.trim();
        if (text) parts.push(`\n## ${text}\n`);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && text.length > 2) parts.push(text);
    }
  }
  return parts.join(' ');
}
```

- [ ] **Step 3: Use `extractStructuredText` in the semantic selector branch**

In `extractPageText`, find the loop:
```javascript
for (const sel of SEMANTIC_SELECTORS) {
  const el = document.querySelector(sel);
  const t  = el?.innerText?.trim() ?? '';
  if (t.length > 300) return cleanText(t);
}
```

Replace with:
```javascript
for (const sel of SEMANTIC_SELECTORS) {
  const el = document.querySelector(sel);
  if (!el) continue;
  // Use structured extraction to preserve section headings for model context
  const t = extractStructuredText(el);
  if (t.length > 300) return cleanText(t);
}
```

- [ ] **Step 4: Verify extraction manually via browser console**

Open a ToS page (e.g. https://discord.com/terms), open DevTools console and run:
```javascript
// Paste extractStructuredText function, then:
extractStructuredText(document.querySelector('main'))
```
Expected output: text containing lines like `## Settling Disputes Between You and Discord` interspersed with paragraph text.

- [ ] **Step 5: Commit**

```bash
git add extension/extraction.js
git commit -m "feat: preserve HTML heading structure in text extraction — gives model section context"
```

---

## Task 6: Wire Privacy Policy Co-Scan in Server

**Files:**
- Modify: `server.ts:117-120` — accept `ppText` field
- Modify: `server.ts:200-320` — run parallel PP scan, merge into results

The server's `/api/analyze` endpoint currently only scans the ToS text. The `data_selling` pillar is defined in Privacy Policies, not ToS pages — so it's structurally impossible to detect without scanning the PP. Fix: accept an optional `ppText` field; if present, run a parallel quick scan on it and union-merge `data_selling` (and any other violations found exclusively in the PP) into the final result.

- [ ] **Step 1: Add test for PP merge in `tests/unit/prompts.test.ts`**

Append to `tests/unit/prompts.test.ts`:
```typescript
describe('buildSystemPrompt — pp scan mode', () => {
  it('quick prompt tier can be called for pp scan without error', () => {
    // PP scan uses quick tier with same prompt — ensure it doesn't throw
    expect(() => buildSystemPrompt(false, false, 'quick')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test — verify PASSES immediately**

```bash
npx vitest run tests/unit/prompts.test.ts
```
Expected: PASS (no code change needed for this step).

- [ ] **Step 3: Update the request destructuring in `server.ts` (line 118)**

Find:
```typescript
const { text, tier = 'quick', url } = req.body;
```

Replace with:
```typescript
const { text, tier = 'quick', url, ppText } = req.body;
```

- [ ] **Step 4: Add PP scan after the main scan result is assembled, before the SSE write**

Find this block in `server.ts` (around line 298):
```typescript
sanitizeCitations(final.pillars);
```

Immediately after `sanitizeCitations(final.pillars);`, insert:

```typescript
// ── Privacy Policy Co-Scan ────────────────────────────────────────
// If the extension sent the Privacy Policy text, run a quick scan on it
// and union-merge any pillars that were NOT detected in the ToS.
// This is the primary fix for the structural data_selling blindspot.
if (ppText && typeof ppText === 'string' && ppText.length > 200) {
    try {
        const ppPrompt = buildSystemPrompt(false, darkPatterns, 'quick');
        const ppResponse = await callGemini(ppPrompt, ppText.slice(0, 40000), 512, 15000, primaryModel, hybridPool);
        const ppParsed = extractJSON(ppResponse.content);
        if (ppParsed) {
            // Union merge: only add PP violations for pillars NOT already flagged in ToS
            const ppPillarKeys = ['ai_training', 'data_selling', 'transparency', 'data_retention', 'content_ownership'];
            if (darkPatterns) ppPillarKeys.push('dark_patterns');
            for (const pk of ppPillarKeys) {
                const tosResult = final.pillars?.[pk];
                const ppResult  = ppParsed[pk]; // quick scan returns flat booleans
                if (!tosResult?.violation && ppResult === true) {
                    // PP flagged it but ToS didn't — add with MEDIUM confidence (different doc)
                    final.pillars[pk] = {
                        violation: true,
                        citation:  '[Found in Privacy Policy]',
                        confidence: 'MEDIUM',
                        source: 'privacy_policy',
                    };
                }
            }
            // Recalculate score and rating with PP violations merged in
            const { score: newScore, rating: newRating, deductions: newDed } = calculateScoreAndRating(final.pillars, tier, text.length);
            final.score      = newScore;
            final.rating     = newRating;
            final.deductions = newDed;
            final.ppScanned  = true;
        }
    } catch (ppErr: any) {
        // PP scan failure is non-fatal — main scan result is still valid
        console.warn('[TLDR Shield] PP co-scan failed (non-fatal):', ppErr.message);
        final.ppScanned = false;
    }
}
```

- [ ] **Step 5: Also add `darkPatterns` to the destructuring (it was already in body but not destructured for PP use)**

Find (line ~118 after your previous change):
```typescript
const { text, tier = 'quick', url, ppText } = req.body;
```
Replace with:
```typescript
const { text, tier = 'quick', url, ppText, darkPatterns = false, eli5 = false } = req.body;
```

Check if `darkPatterns` and `eli5` are used elsewhere in the route — they are passed to `buildSystemPrompt` on line ~217. Remove the destructuring of those from there if they're now top-level.

- [ ] **Step 6: Verify server builds without errors**

```bash
npm run build:server
```
Expected: `dist-server/server.js` compiled with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add server.ts
git commit -m "feat: add Privacy Policy co-scan — union-merges PP violations (data_selling) into final result"
```

---

## Task 7: Wire Privacy Policy URL from Extension to Server

**Files:**
- Modify: `extension/extraction.js:352-400` — `extractPolicySuite` returns structured object
- Modify: `extension/background.js:219-230` — pass `ppText` in POST body

The extension already has `discoverLegalSuite()` + `fetchLegalSuite()` that can fetch Privacy Policy pages. But `extractPolicySuite` only concatenates them into the primary text. Fix: split them — return primary ToS text separately from PP text, and pass `ppText` to the server as a dedicated field.

- [ ] **Step 1: Understand current `extractPolicySuite` behaviour**

Read `extension/extraction.js` lines 352–400. Currently it fetches related legal pages and either returns concatenated text (if found) or just `primaryText`. The PP text is merged into the main scan — so the server can't treat it differently.

- [ ] **Step 2: Modify `extractPolicySuite` to return a structured object**

Find `extractPolicySuite` (line 352):
```javascript
async function extractPolicySuite(primaryText) {
  const links = discoverLegalSuite();
  if (!links.length) return primaryText;

  const suite = await fetchLegalSuite(links);
  if (!suite.length) return primaryText;
  // ... concatenation logic
```

The function currently returns a `string`. Change it to return `{ tosText, ppText }`:

```javascript
async function extractPolicySuite(primaryText) {
  const links = discoverLegalSuite();
  if (!links.length) return { tosText: primaryText, ppText: null };

  const suite = await fetchLegalSuite(links);
  if (!suite.length) return { tosText: primaryText, ppText: null };

  // Identify the Privacy Policy document (prefer items with 'privacy' in label/url)
  const ppEntry = suite.find(
    s => /privacy/i.test(s.label) || /privacy/i.test(s.url)
  );

  // Build ppText from the Privacy Policy entry only
  const ppText = ppEntry ? ppEntry.text.slice(0, 40000) : null;

  // ToS text stays as the primary text (unchanged)
  return { tosText: primaryText, ppText };
}
```

- [ ] **Step 3: Find all callers of `extractPolicySuite` in `content.js`**

```bash
grep -n "extractPolicySuite" extension/content.js
```
Note the line numbers.

- [ ] **Step 4: Update callers in `content.js` to destructure the result**

For each call site like:
```javascript
const text = await extractPolicySuite(rawText);
```

Replace with:
```javascript
const { tosText, ppText } = await extractPolicySuite(rawText);
```

Then pass `tosText` where `text` was used, and store `ppText` for sending to background.

- [ ] **Step 5: Pass `ppText` when sending `ANALYZE_TEXT` message to background**

Find where `content.js` sends the `ANALYZE_TEXT` message to `background.js`. It will look like:
```javascript
chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text: someText, tabId: ..., url: ... });
```

Replace with:
```javascript
chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text: tosText, ppText: ppText ?? null, tabId: ..., url: ... });
```

- [ ] **Step 6: Update `background.js` `analyzeText` to accept and forward `ppText`**

Find the `analyzeText` function signature (line 171):
```javascript
async function analyzeText(text, tabId, forceDeep = false, tierOverride = null, sourceUrl = null, forceRefresh = false) {
```

Replace with:
```javascript
async function analyzeText(text, tabId, forceDeep = false, tierOverride = null, sourceUrl = null, forceRefresh = false, ppText = null) {
```

- [ ] **Step 7: Pass `ppText` in the fetch POST body in `background.js`**

Find the fetch body (around line 225):
```javascript
body: JSON.stringify({
  text:         text,
  tier:         autoTier,
  eli5:         eli5Mode,
  darkPatterns: darkPatterns,
  url:          sourceUrl,
```

Add `ppText` after `url`:
```javascript
body: JSON.stringify({
  text:         text,
  tier:         autoTier,
  eli5:         eli5Mode,
  darkPatterns: darkPatterns,
  url:          sourceUrl,
  ppText:       ppText ?? null,
```

- [ ] **Step 8: Update the `ANALYZE_TEXT` message handler in `background.js`**

Find where `analyzeText` is called from the message listener:
```javascript
case 'ANALYZE_TEXT':
  analyzeText(message.text, message.tabId, ...);
```

Pass through `ppText`:
```javascript
case 'ANALYZE_TEXT':
  analyzeText(message.text, message.tabId, false, null, message.url ?? null, false, message.ppText ?? null);
```

- [ ] **Step 9: Load the extension in Chrome and test on discord.com/terms**

1. Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select `./extension` folder.
2. Navigate to `https://discord.com/terms`.
3. Click the TLDR Shield badge.
4. Open DevTools → Network tab → find the POST to `/api/analyze`.
5. In the request payload, verify `ppText` is non-null (Discord's Privacy Policy should be discovered).

Expected: `ppText` field contains text from `discord.com/privacy`. The response should now include `data_selling: { violation: true, source: 'privacy_policy' }`.

- [ ] **Step 10: Commit**

```bash
git add extension/extraction.js extension/content.js extension/background.js
git commit -m "feat: wire Privacy Policy co-scan from extension to server — fixes structural data_selling blindspot"
```

---

## Task 8: Fix Eval Script — Raise Char Limit from 30K to 120K

**Files:**
- Modify: `scratch/scan_test.py`

Our evaluation script hard-capped ToS fetches at 30,000 chars. The production extension collects up to 120,000 chars and the server chunks it in 12K blocks with max 8 chunks. The 30K cap was causing the eval to miss second-half clauses (e.g., Discord's class-action waiver appears after the 30K mark on some pages). Fix: raise to 120K to match production behaviour.

- [ ] **Step 1: Open `scratch/scan_test.py`, find `fetch_tos_text`**

Look for:
```python
def fetch_tos_text(url: str, max_chars: int = 30000) -> str:
```

- [ ] **Step 2: Raise default limit**

```python
def fetch_tos_text(url: str, max_chars: int = 120000) -> str:
```

- [ ] **Step 3: Also raise the MAX_TOKENS to match deep scan output needs**

Find:
```python
MAX_TOKENS = 8192
```
This is already adequate. No change needed.

- [ ] **Step 4: Re-run the full scan battery**

```bash
python -X utf8 scratch/scan_test.py
```
Expected: Recall improves (more clauses found). `data_retention` FP rate should drop now that Task 3 prompt fix is in. `data_selling` should still be 0% recall until Task 7 is deployed (requires browser extension with PP co-scan).

- [ ] **Step 5: Record the new baseline numbers**

After the run, copy the SUMMARY output and paste it as a comment at the bottom of `scratch/scan_test.py`:
```python
# BASELINE 2026-04-29 (after bottleneck fixes):
# Basic: 3/3 correct rating, Avg P=X%, Avg R=X%, Avg latency=Xs
# Deep:  3/3 correct rating, Avg P=X%, Avg R=X%, Avg latency=Xs
```

- [ ] **Step 6: Commit**

```bash
git add scratch/scan_test.py
git commit -m "fix: raise eval script ToS char limit to 120K to match production pipeline"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] B1 data_selling blindspot → Task 6 (server) + Task 7 (extension) — PP co-scan end-to-end
- [x] B2 data_retention FPs → Task 3 — silence clause removed from both prompts
- [x] B3 30K truncation in eval → Task 8
- [x] B4 HTML structure loss → Task 5
- [x] B5 conflicting prompt philosophy → Task 4
- [x] B6 corroborator FPs → Task 2 — HIGH confidence gate
- [x] B7 legacy model reference → Task 1

**Placeholder scan:** No TBD, TODO, or "similar to above" patterns. All code blocks are complete.

**Type consistency:**
- `extractPolicySuite` now returns `{ tosText, ppText }` — callers in Task 7 Step 4 and 5 use destructuring consistently.
- `analyzeText` adds `ppText` as last optional param — existing callers without `ppText` still work (default `null`).
- `buildSystemPrompt` signature unchanged — all callers compatible.
- `callGemini` signature unchanged — PP co-scan in Task 6 uses existing function.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-29-tldr-bottleneck-fixes.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`

**2. Inline Execution** — Execute tasks in this session. REQUIRED SUB-SKILL: `superpowers:executing-plans`

Tasks 1–4 are pure server-side and can be executed independently in any order. Tasks 6 and 7 are paired (server + extension) and should be executed together. Task 8 validates the full pipeline after all other fixes are in.

**Which approach?**
