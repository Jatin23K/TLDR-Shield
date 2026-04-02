# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Component: Chrome Extension

Manifest V3, plain vanilla JavaScript — **no build step**. Load via `chrome://extensions` → "Load unpacked" pointing at this `extension/` directory. Any file save is live after clicking the reload icon on the extensions page.

## Files

| File | Role |
|------|------|
| `manifest.json` | Declares permissions, content scripts, background SW, web-accessible resources |
| `content.js` | Agents 1+2+4: T&C detection, text extraction, badge injection, result rendering |
| `background.js` | Agent 3: service worker; SSE streaming, auth token management, PDF routing |
| `popup.js` + `popup.html` | Tier picker (Quick/Deep), ELI5/dark-patterns toggles, sign-in UI, credits display |
| `offscreen.js` + `offscreen.html` | PDF text extraction via pdf.js (MV3 requires offscreen doc for ESM + DOM) |
| `lib/` | Bundled vendored libs — Readability.js, mark.min.js, pdf.min.mjs, pdf.worker.min.mjs |

## Message Protocol (internal)

All cross-context communication is `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`:

| Message type | Direction | Purpose |
|---|---|---|
| `ANALYZE_TEXT` | content → background | Kick off text analysis |
| `ANALYZE_PDF` | content → background | Route PDF URL through offscreen |
| `EXTRACT_PDF` | background → offscreen | Start pdf.js extraction |
| `PDF_TEXT` | offscreen → background | Extracted PDF text |
| `PDF_ERROR` | offscreen → background | Extraction failure |
| `EXTRACT_FOR_POPUP` | popup → content | Fetch page text for popup-initiated scan |
| `ANALYSIS_PROGRESS` | background → content | Forward SSE progress steps to badge |
| `ANALYSIS_RESULT` | background → content | Final result (or error) |
| `OUT_OF_CREDITS` | background → content | 402 — show out-of-credits UI |
| `STORE_AUTH` / `CLEAR_AUTH` | content → background | Persist/clear Firebase ID token |
| `GET_AUTH` | popup/content → background | Read auth state from storage |

## Key Architectural Constraints

**Service Worker Keepalive**: MV3 SWs die after ~30s idle. Before sending `ANALYZE_TEXT`, content.js opens a `keepalive` named port. background.js additionally pings `chrome.runtime.getPlatformInfo()` every 20s. Both mechanisms are required because deep scans take 25–40s.

**Tier selection logic** (in `background.js → analyzeText()`):
1. `tierOverride` set by popup → use that
2. `forceDeep=true` (user clicked "Run Deep Scan" from quick result) → deep
3. `text.length > 30000` → auto-promote to deep
4. Otherwise → quick

PDFs are always forced to deep regardless of size.

**Auth token flow**: Firebase ID tokens are stored in `chrome.storage.local` by the web app's content script after sign-in (`STORE_AUTH`). The background reads the token on every scan and attaches `Authorization: Bearer <token>`. Tokens expire after 1h; the stored `authTokenExpiry` field is checked before use.

## T&C Detection (content.js — Agent 1)

Uses weighted confidence scoring (threshold 30). Signal weights:

| Signal | Weight |
|--------|--------|
| URL path matches legal regex | 40 |
| Page `<title>` has legal keyword | 25 |
| `<h1>` has legal keyword | 20 |
| `<h2>` has legal keyword | 15 |
| Visible modal/dialog with legal keyword | 30 |
| Cookie banner detected (OneTrust, Cookiebot, etc.) | 20 |
| Meta tag mentions legal | 10 |

Hosts containing `paypal`, `stripe`, `bank`, `trading`, `invest`, `crypto`, `gambling`, `casino`, `betting`, `forex`, `brokerage` are always blocked (false-positive risk).

## Text Extraction (content.js — Agent 2)

Uses Mozilla `Readability.js` to strip nav/footer/ads before extraction. For PDFs detected in the active tab, routes the URL through `background.js → offscreen.js` (pdf.js). Popup-initiated scans use `EXTRACT_FOR_POPUP` to reuse content-script logic; falls back to `chrome.scripting.executeScript` on restricted pages.

## Result Rendering (content.js — Agent 4)

Injects a floating badge into the page DOM. Badge updates incrementally via `ANALYSIS_PROGRESS` SSE steps. `mark.js` is used to highlight verbatim citation text in the original page.

## Storage Keys (`chrome.storage.local`)

| Key | Type | Purpose |
|-----|------|---------|
| `apiUrl` | string | Backend URL override (default: Cloud Run) |
| `eli5Mode` | boolean | ELI5 citations on/off |
| `darkPatterns` | boolean | Dark patterns pillar on/off |
| `authToken` | string | Firebase ID token |
| `authUid` | string | Firebase UID |
| `authEmail` | string | User email |
| `authTokenExpiry` | number | Token expiry (ms since epoch) |
| `authCredits` | number | Cached credit balance |

## Permissions

- `activeTab`, `storage`, `scripting` — standard content + storage
- `offscreen` — required for pdf.js ESM in hidden document
- Host: `*://*.run.app/*` + `http://localhost:3000/*` — backend API calls
