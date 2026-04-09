---
name: extension-testing
description: Use when content.js, background.js, or content.css has been modified — runs the TLDR Shield Chrome extension in a real browser via Playwright MCP and verifies the floating badge appears with a valid rating and score.
---

# Extension Testing

## Overview

Smoke-test the TLDR Shield Chrome extension end-to-end using Playwright MCP. Loads the unpacked extension into a real Chrome instance, navigates to a live ToS page, and verifies the floating badge renders with a valid rating and score.

## When to Use

After any edit to:
- `extension/content.js`
- `extension/background.js`
- `extension/content.css`

## Steps

### 1. Launch Chrome with Extension

```js
// Playwright MCP — launch chromium with unpacked extension
await browser_navigate({
  url: "about:blank",
  launchOptions: {
    channel: "chrome",
    args: [
      "--load-extension=./extension",
      "--disable-extensions-except=./extension"
    ]
  }
});
```

> The extension path `./extension` is relative to the project root. Use an absolute path if the working directory differs.

### 2. Navigate to Test URL

Default test URLs (use in order; fall back if first is slow):
1. `https://tosdr.org/en/service/190` (GitHub ToS — reliably flagged)
2. `https://www.airbnb.com/terms`

```js
await browser_navigate({ url: "https://tosdr.org/en/service/190" });
```

### 3. Wait for the Badge

The badge is injected by `content.js` as a fixed-position element. Wait up to 30s — deep scans take 25–45s.

```js
await browser_wait_for({
  selector: "#tldr-shield-badge",   // or closest stable selector
  timeout: 30000
});
```

If no selector is stable, poll with `browser_snapshot` every 3s and look for the badge container in the accessibility tree.

### 4. Read Rating and Score

```js
const snapshot = await browser_snapshot();
// Find the badge node and extract:
//   rating  → one of: SAFE | OKAY | RISKY
//   score   → integer 0–100
```

Alternatively use `browser_evaluate` to read DOM directly:
```js
const result = await browser_evaluate({
  expression: `(() => {
    const badge = document.getElementById('tldr-shield-badge');
    if (!badge) return null;
    return {
      rating: badge.querySelector('[data-rating]')?.dataset.rating,
      score:  badge.querySelector('[data-score]')?.textContent?.trim()
    };
  })()`
});
```

### 5. Check Console for Errors

```js
const logs = await browser_console_messages();
const errors = logs.filter(m => m.type === 'error');
```

---

## Checks & Pass/Fail Criteria

| Check | Pass | Fail |
|-------|------|------|
| Badge appeared | Element found within 30s | Timeout — badge never rendered |
| Rating valid | `SAFE`, `OKAY`, or `RISKY` | Missing, empty, or unexpected value |
| Score visible | Integer 0–100 present in badge | Score absent or non-numeric |
| No console errors | `errors.length === 0` | Any `console.error` from extension scripts |

---

## Output Format

Report one line per check:

```
URL tested : https://tosdr.org/en/service/190
Badge appeared : PASS
Rating returned : OKAY
Score visible : PASS (score: 62)
Console errors : PASS (none)

Overall: PASS
```

If any check fails:

```
Badge appeared : FAIL — element #tldr-shield-badge not found after 30s
Console errors : FAIL — "Uncaught TypeError: Cannot read properties of null" (content.js:142)

Overall: FAIL
```

---

## Common Failures

| Symptom | Likely cause |
|---------|-------------|
| Badge never appears | Extension not loaded — verify `--load-extension` path is correct and absolute |
| Badge appears but no rating | SSE stream failed; check backend is running (`npm run dev`) |
| `chrome.runtime` errors | Service worker crashed — check `background.js` for syntax errors |
| Score is NaN | Score parsing broke in `content.js` — check `renderBadge()` |
| Extension not detected | `manifest.json` permissions missing for the test URL's origin |

---

## Notes

- The backend (`npm run dev`) must be running for the extension to receive scan results.
- Quick scans return no `pillars` — `pillars: null` is expected and is **not** a failure.
- The keepalive port (`chrome.runtime.connect`) in `content.js` must remain open for deep scans; do not close it before `ANALYSIS_RESULT` is received.
- Do **not** test on hosts blocked by `content.js` detection logic (paypal, stripe, bank, etc.) — the badge will never trigger on those.
