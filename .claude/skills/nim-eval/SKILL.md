---
name: nim-eval
description: Run the TLDR Shield eval suite, parse JSON output, produce accuracy report, and detect regressions vs baseline.
user-invocable: true
---

# NIM Eval Skill

Run the eval suite, parse results, and surface regressions. Use this whenever accuracy needs to be verified — before a deploy, after changing pillar logic, or after editing `server.ts` pipeline code.

## When to use

- Before any deploy that touches `server.ts`, `buildSystemPrompt()`, `applyConsistencyCrossCheck()`, `aggregateResults()`, or `buildDeterministicDeepFallback()`
- After adding a new eval case to `eval/dataset.jsonl`
- When the user asks "did accuracy change?" or "run eval"

## Steps

### 1. Run the eval

```bash
npm run eval          # full suite (quick + deep)
# OR
npm run eval:quick    # quick-tier only (faster)
# OR
npm run eval:deep     # deep-tier only
```

Eval output is raw JSON printed to stdout. Capture it.

### 2. Parse key metrics

From the JSON output, extract:

| Field | Description | Regression threshold |
|-------|-------------|---------------------|
| `accuracy.pillarsPct` | % of pillar predictions correct | Drop of ≥ 5pp vs baseline = REGRESSION |
| `accuracy.ratingPct` | % of overall ratings correct (SAFE/OKAY/RISKY) | Drop of ≥ 5pp vs baseline = REGRESSION |
| `latencyMs.p50` | Median latency | Flag if > 8,000ms |
| `latencyMs.p90` | 90th percentile latency | Flag if > 20,000ms |
| `parseFails` | JSON parse failures from LLM | Must be 0 — any failure = BLOCK |

### 3. Report format

Output a table like this:

```
Metric            Value     Status
─────────────────────────────────────
pillarsPct        87.5%     ✅ (was 85%)
ratingPct         75.0%     ✅ (was 75%)
latencyMs p50     3,200ms   ✅
latencyMs p90     9,800ms   ✅
parseFails        0         ✅
```

### 4. Regression check

Compare against the **baseline** (last known-good values). If no baseline exists, note that this run establishes the baseline.

**REGRESSION** = any of:
- `pillarsPct` dropped ≥ 5 percentage points
- `ratingPct` dropped ≥ 5 percentage points
- `parseFails` > 0

On regression: **do not proceed with deploy**. Diagnose which test cases changed by looking at per-case results in the eval JSON.

### 5. Interpreting failures

Per-case fields to check:
- `predicted.rating` vs `expected.rating` — overall verdict mismatch
- `predicted.pillars.{key}` vs `expected.pillars.{key}` — which pillar is wrong
- `error` field — if set, LLM or parse error occurred

Common causes:
- Prompt change → re-run `buildSystemPrompt()` logic
- New keyword added to `applyConsistencyCrossCheck()` → false positive surge
- Model changed → recalibrate expectations

## Notes

- Eval hits real NIM API — costs credits from whatever key is in `.env`
- Dataset is `eval/dataset.jsonl` — 8 cases as of initial build (small, so regressions are high-signal)
- `eval/golden.test.ts` has 5 hand-crafted verbatim citation checks — run with `npx jest eval/golden.test.ts` separately if citation grounding is in question
- Pillar keys in dataset must be **snake_case** (`ai_training`, not `aiTraining`) — wrong casing silently skips the check
