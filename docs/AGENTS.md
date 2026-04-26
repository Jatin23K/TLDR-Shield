# AGENTS.md

Guidance for Codex when working in this repository.
Read this file fully before making any changes.

---

## What This Project Is

**TLDR Shield** is a privacy tool that scans Terms of Service and Privacy Policy pages and scores them across six privacy "pillars". It has three components that work together:

1. **Chrome Extension** (MV3, plain JS) — detects T&C pages, extracts text, shows a floating badge with the verdict.
2. **Express Backend** (`server.ts`) — the brain: receives text, runs it through NVIDIA NIM LLMs, streams results back via SSE.
3. **React Web App** (`src/`) — landing page + scan history dashboard; served by Express in dev, built to `dist/` for prod.

Users install the extension, browse to a ToS page, and get a SAFE / OKAY / RISKY score with verbatim citations within a few seconds — without reading the document themselves.

---

## Current State

| Area | Status |
|------|--------|
| Core scan pipeline (Quick + Deep) | Working and in production |
| Credit system (400/month, monthly reset) | Working |
| L1 in-memory cache | Working |
| L2 Firestore shared cache (48h quick / 7d deep) | Working |
| NIM key rotation + retry/backoff | Working |
| Sentence-aware chunking (via `compromise`) | Working |
| Embedding-based pillar ranking (`nv-embedqa-e5-v5`) | Working |
| Verbatim citation grounding (`findVerbatimInChunk`) | Working |
| Deterministic fallback (when LLM fails) | Working |
| Firebase Auth (Google sign-in) | Working |
| Scan history dashboard (Firestore `onSnapshot`) | Working |
| User feedback endpoint (`POST /api/report`) | Working |
| Eval suite (`runEval.ts` + `golden.test.ts`) | Working — 30 dataset cases, 10 golden tests |
| Extension PDF handling (offscreen + pdf.js) | Working |
| Service worker keepalive (MV3 30s limit) | Working |
| Rate limiting (30 req/15min per IP) | Working |
| `POST /api/analyze` auto-promotes text >30k to Deep | Working |
| ELI5 mode (plain-English citations) | Working |
| Dark patterns pillar (optional feature flag) | Working |
| Dynamic Pro Mode (runtime toggleable) | Working |

**Known gaps / not yet built:**
- ~~No CI/CD pipeline (deploys are manual)~~ ✅ CI pipeline live (`.github/workflows/ci.yml`)
- ~~No scheduled eval runs (accuracy drift can go undetected)~~ ✅ Weekly eval live (`.github/workflows/weekly-eval.yml`)
- ~~No NIM key health monitoring (key failures are reactive, not proactive)~~ ✅ NIM health monitor live (`.github/workflows/nim-health.yml`)
- ~~No user-facing policy change notifications (manual re-scan only)~~ ✅ Policy change alerts live (via `/api/recheck` + `/api/notifications`)
- ~~Extension popup, badge UI, and dashboard are prototype-grade~~ ✅ Phase 2 UX polish complete (popup redesign, skeleton screen, history dashboard, landing page, Chrome side panel)

---

## Repository Layout

```
.
├── server.ts               # ENTIRE Express backend (~4,100 lines) — do not split lightly
├── src/
│   ├── App.tsx             # ENTIRE React app — landing page + history dashboard (~900 lines)
│   ├── firebase.ts         # Firebase client init, signIn/signOut helpers
│   ├── main.tsx            # React entry point
│   └── index.css           # Tailwind base styles
├── extension/              # Chrome Extension — NO BUILD STEP
│   ├── manifest.json       # MV3 manifest — permissions, SW, content scripts
│   ├── content.js          # Agent 1+2+4: T&C detection, text extraction, badge rendering
│   ├── background.js       # Agent 3: service worker, SSE streaming, auth, PDF routing
│   ├── popup.html/.js      # Tier picker, ELI5/dark-patterns flags, sign-in, credits display
│   ├── sidepanel.html/.js  # Chrome Side Panel — shows full scan result with live progress
│   ├── offscreen.html/.js  # PDF text extraction via pdf.js (MV3 requires offscreen doc)
│   ├── content.css         # Badge styles injected into pages
│   └── lib/                # Vendored: Readability.js, mark.min.js, pdf.min.mjs, pdf.worker.min.mjs
├── eval/
│   ├── dataset.jsonl       # Eval test cases (30 cases, JSONL format)
│   ├── golden.test.ts      # 10 hand-crafted golden test cases with verbatim citation checks
│   ├── runEval.ts          # Main eval harness — runs dataset.jsonl against NIM
│   └── checkNimKeys.ts     # NIM key health checker
├── firebase-applet-config.json  # Firebase project config (checked in, non-secret)
├── firebase-blueprint.json      # Firestore schema reference (documentation only)
├── firestore.rules              # Firestore security rules — deploy separately
├── vite.config.ts          # Vite config — React + Tailwind, alias @ → project root
├── tsconfig.json           # TypeScript — ES2022, strict, path alias @/
├── package.json
└── .env                    # Local secrets — never commit
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Node.js + Express 4, TypeScript (via `tsx`) |
| LLM | Google Gemini 2.5 (Flash / Pro) |
| Key Pooling | Hybrid Lane Priority failover (6 keys) |
| NLP chunking | `compromise` (sentence-aware text splitting) |
| Frontend framework | React 19 |
| Frontend build | Vite 6 |
| CSS | Tailwind CSS 4 (via `@tailwindcss/vite` plugin) |
| Animations | `motion/react` (Framer Motion) |
| Icons | `lucide-react` |
| Auth | Firebase Auth (Google sign-in via popup) |
| Database | Firestore (Firebase Admin SDK on server, Firebase client SDK in browser) |
| Deployment | Google Cloud Run (production) |
| Extension | Chrome Extension Manifest V3, vanilla JS |
| PDF extraction | `pdfjs-dist` (via MV3 offscreen document) |
| Content extraction | `@mozilla/readability` |
| Text highlighting | `mark.js` |
| Rate limiting | `express-rate-limit` |

---

## Commands

```bash
# Development
npm run dev          # Start full-stack dev server (Express + Vite HMR on :3000)
npm run build        # Vite production build → dist/
npm run lint         # TypeScript type-check only (no emit — catches type errors)
npm run clean        # Remove dist/

# Evaluation
npm run eval         # Full eval: quick + deep tiers against dataset.jsonl
npm run eval:quick   # Quick-tier only
npm run eval:deep    # Deep-tier only
npm run eval:dark    # Dark patterns pillar eval
npm run check:nim    # Health-check all NIM API keys (tests each key individually)
```

**Extension:** No build step. After editing any file under `extension/`:
1. Open `chrome://extensions`
2. Click the reload icon on the TLDR Shield card
3. If `manifest.json` permissions changed: remove and re-add the extension

---

## Environment Variables

File: `.env` (local dev). Cloud Run uses env vars set in the service configuration.

```env
# Required
GEMINI_SCAN_KEY_1=AIza...
GEMINI_SCAN_KEY_2=AIza...
GEMINI_SCAN_KEY_3=AIza...
GEMINI_UTIL_KEY_1=AIza...
GEMINI_UTIL_KEY_2=AIza...
GEMINI_UTIL_KEY_3=AIza...

# Models
GEMINI_MODEL_SCAN_PRIMARY=gemini-2.5-flash
GEMINI_MODEL_SCAN_FALLBACK=gemini-2.5-flash-lite
GEMINI_MODEL_UTILITY=gemini-2.5-flash-lite

# Production
APP_URL=https://your-cloud-run-url.run.app
PORT=3000                     # Cloud Run sets this automatically
INTERNAL_API_KEY=...          # Optional: require x-internal-key header on all endpoints
ALLOW_UNMETERED_LOCAL=true    # Dev only: bypass credit check when Firestore is offline
```

**Firestore credentials** (checked in this priority order in `server.ts`):
1. `FIREBASE_SERVICE_ACCOUNT_JSON` — inline JSON string; works on Railway, Render, Fly, and any PaaS that can't mount files.
2. `FIREBASE_SERVICE_ACCOUNT_PATH` — path to a service account JSON file; local dev or CI with mounted secrets.
3. Application Default Credentials — automatic on Cloud Run / GKE; use `gcloud auth application-default login` locally.

---

## API Endpoints

All endpoints live in `server.ts`. Rate limit: 30 requests per 15 minutes per IP.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | None | Memory, cache size, Firestore status, NIM key count |
| `POST` | `/api/analyze` | Firebase ID token (Bearer) | Main scan — SSE stream |
| `GET` | `/api/credits` | Firebase ID token (Bearer) | Current credit balance |
| `POST` | `/api/report` | Firebase ID token (Bearer) | Submit incorrect result feedback |
| `DELETE` | `/api/cache` | INTERNAL_API_KEY | Clear L1 cache (Redis) |

**`POST /api/analyze` request body:**
```json
{
  "text": "...full policy text...",
  "tier": "quick" | "deep",
  "eli5": true | false,
  "darkPatterns": true | false,
  "url": "https://example.com/privacy"
}
```
Response: `text/event-stream` (SSE). Each event is `data: {...}\n\n`. Final event has the full result; intermediate events carry `{ status: "..." }` progress updates.

---

## The LLM Pipeline (inside `server.ts`)

Every call to `POST /api/analyze` goes through this sequence:

```
1. Auth check (Firebase ID token)
2. Credit deduction (Firestore transaction, atomic)
3. Cache lookup:
   L1 (in-memory LRU, 500 entries)  →  L2 (Firestore shared_cache)
   If hit: refund credits, stream cached result
4. Text preprocessing:
   Truncate to 80,000 chars (8 chunks × 10,000 chars)
5. Sentence-aware chunking via `compromise`:
   CHUNK_SIZE=10,000 | CHUNK_OVERLAP=2,500 | MAX_CHUNKS=8
6. For each chunk (CHUNK_CONCURRENCY=2 parallel):
   → `analyzeChunk()` — NIM LLM call with `buildSystemPrompt()`
   → Verbatim citation grounding via `findVerbatimInChunk()`
   → Per-chunk retry (once) on parse failure
7. `aggregateResults()` — worst-case score, union of violations
8. `applyConsistencyCrossCheck()` — keyword-based secondary verification
9. `sanitizeCitations()` — strip LLM paraphrase patterns, validate verbatim
10. (Deep tier only) `extractVerbatimForPillar()` — embedding + focused LLM pass
    per pillar to ground citations in the original text
11. `saveScanRecord()` — write to Firestore /scans (non-blocking, 1 retry)
12. `setSharedCache()` — write to Firestore shared_cache (non-blocking)
13. SSE result event sent to client
```

**Two tiers:**

| Parameter | Quick | Deep |
|-----------|-------|------|
| Max tokens | 120 | 1,400 |
| Timeout | 20s | 45s |
| Credit cost | 10 | 20 |
| Returns pillars? | No (badge only) | Yes (full breakdown + citations) |
| Auto-promote? | If text >30k chars → Deep | — |
| PDF | Always forced to Deep | — |

---

## Privacy Pillars

Six pillars, each analyzed independently. Definitions are in `buildSystemPrompt()` (server.ts ~line 1112).

| Pillar key | What it checks | Violation threshold |
|-----------|---------------|---------------------|
| `ai_training` | User content used for AI/ML training | ANY mention without opt-out = violation |
| `data_selling` | Data shared with third parties / advertisers | Sharing for commercial use = violation |
| `transparency` | Vague, obscuring, or contradictory language | Actively misleading only (not merely concise) |
| `data_retention` | Deletion timeline after account closure | >1 year post-deletion OR completely unspecified |
| `content_ownership` | IP/license rights over user content | Worldwide sublicensable "for any purpose" = violation |
| `dark_patterns` | Unfair contractual clauses | $100 liability cap, class action waiver, forced arbitration, shortened statute |

**Scoring bands (enforced by post-processing, not just LLM):**
- 0 violations, clear language → 90–100, **SAFE**
- 0 violations, minor vagueness → 75–89, **OKAY**
- 1 low-severity violation → 50–74, **OKAY**
- 1 high-severity or 2 violations → 25–49, **RISKY**
- 3–4 violations → 10–24, **RISKY**
- 5–6 violations → 0–9, **RISKY**

Score < 50 is enforced as RISKY regardless of what the LLM says.

**Pillar logic is distributed across FOUR locations that must stay in sync:**
1. `buildSystemPrompt()` — LLM instructions (server.ts ~1112)
2. `applyConsistencyCrossCheck()` — keyword-based secondary check (server.ts ~735)
3. `buildDeterministicDeepFallback()` — regex fallback when LLM fails (server.ts ~1014)
4. `eval/dataset.jsonl` + `eval/golden.test.ts` — expected results

Changing a pillar definition requires updating ALL FOUR.

---

## Firestore Collections

| Collection | Document ID | Key fields | Who writes |
|-----------|-------------|-----------|------------|
| `/users/{uid}` | Firebase UID | `credits`, `lastResetMonth`, `role` | Server (credit transactions) |
| `/scans/{scanId}` | Auto-generated | `uid`, `url`, `rating`, `score`, `tldr`, `pillars`, `tier`, `model`, `cached`, `latencyMs`, `createdAt` | Server (post-scan) |
| `/shared_cache/{hash}` | SHA-256 of text+tier+model | `result`, `tier`, `scannedAt`, `expiresAt`, `scanCount`, `sourceUrlHash` | Server (Admin SDK only) |
| `/reports/{id}` | Auto-generated | `uid`, `url`, `rating`, `score`, `pillars`, `createdAt` | Server (feedback endpoint) |

**Important:** `shared_cache` is client-read-blocked (Firestore rules deny all client access). Only the Admin SDK can write. This is intentional — it's a server-side anonymous cache.

**Credit system:** 400 free credits per month, auto-reset on the 1st. Reset is handled by `checkAndDeductCredits()` in a Firestore transaction — it detects `lastResetMonth !== currentMonth` and resets to 400 before deducting.

---

## Chrome Extension — Message Protocol

All cross-context communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.

| Message type | Direction | Purpose |
|---|---|---|
| `ANALYZE_TEXT` | content → background | Kick off text analysis |
| `ANALYZE_PDF` | content → background | Route PDF URL through offscreen |
| `EXTRACT_PDF` | background → offscreen | Start pdf.js extraction |
| `PDF_TEXT` | offscreen → background | Extracted PDF text |
| `PDF_ERROR` | offscreen → background | Extraction failure |
| `EXTRACT_FOR_POPUP` | popup → content | Fetch page text for popup-initiated scan |
| `ANALYSIS_PROGRESS` | background → content | Forward SSE progress steps to badge |
| `ANALYSIS_RESULT` | background → content | Final result or error |
| `OUT_OF_CREDITS` | background → content | 402 response — show out-of-credits UI |
| `STORE_AUTH` / `CLEAR_AUTH` | content → background | Persist/clear Firebase ID token |
| `GET_AUTH` | popup/content → background | Read auth state from storage |

**`chrome.storage.local` keys:**

| Key | Type | Purpose |
|-----|------|---------|
| `apiUrl` | string | Backend URL (default: Cloud Run URL) |
| `eli5Mode` | boolean | ELI5 plain-English citations on/off |
| `darkPatterns` | boolean | Dark patterns pillar on/off |
| `authToken` | string | Firebase ID token (1h expiry) |
| `authUid` | string | Firebase UID |
| `authEmail` | string | User email (display only) |
| `authTokenExpiry` | number | Token expiry timestamp (ms) |
| `authCredits` | number | Cached credit balance |

---

## Service Worker Keepalive (Critical MV3 Constraint)

Chrome kills MV3 service workers after ~30s of inactivity. Deep scans take 25–45s. Two mechanisms keep the worker alive — **both are required**:

1. Content script opens a named `keepalive` port (`chrome.runtime.connect`) before sending `ANALYZE_TEXT`. Chrome does not terminate workers with open ports.
2. `background.js` calls `chrome.runtime.getPlatformInfo()` every 20s via `setInterval`.

If you touch the scan lifecycle in either `content.js` or `background.js`, verify these mechanisms are preserved.

---

## T&C Detection (content.js — Agent 1)

Confidence scoring — shows the trigger badge only if score ≥ 30.

| Signal | Weight |
|--------|--------|
| URL path matches legal regex | 40 |
| `<title>` contains legal keyword | 25 |
| `<h1>` contains legal keyword | 20 |
| `<h2>` contains legal keyword | 15 |
| Visible modal/dialog with legal keyword | 30 |
| Cookie banner present (OneTrust, Cookiebot, etc.) | 20 |
| Meta description mentions legal | 10 |

Hosts containing `paypal`, `stripe`, `bank`, `trading`, `invest`, `crypto`, `gambling`, `casino`, `betting`, `forex`, `brokerage` are blocked entirely (false-positive risk too high).

---

## Eval Dataset Format

`eval/dataset.jsonl` — one JSON object per line.

```jsonc
{
  "id": "t1_safe_clear",          // t{N}_{label} convention
  "text": "...policy text...",
  "expected": {
    "rating": "SAFE",             // "SAFE" | "OKAY" | "RISKY"
    "pillars": {
      "ai_training": false,       // all 6 keys required, all boolean
      "data_selling": false,
      "transparency": false,
      "data_retention": false,
      "content_ownership": false,
      "dark_patterns": false
    }
  }
}
```

**The pillar key names are snake_case, not camelCase.** Wrong casing silently skips the check in `runEval.ts`.

Eval output is raw JSON. Key fields to read:
- `accuracy.pillarsPct` — % of pillar predictions correct
- `accuracy.ratingPct` — % of overall ratings correct
- `latencyMs.p50` / `p90` — latency percentiles
- `parseFails` — JSON parse failures (should be 0)

---

## Conventions

### TypeScript / Backend (`server.ts`)
- Async throughout — all NIM calls, Firestore operations, and auth use `async/await`.
- Every route attaches a `requestId` (UUID) to responses via `X-Request-ID` header.
- NIM calls go through `nimCreateWithRetry()` — never call the OpenAI client directly inside a route handler.
- All Firestore writes are non-blocking (fire-and-forget with a catch). Scan analysis results are never delayed by Firestore write failures.
- SSE: set `Content-Type: text/event-stream` before writing any data. Each event is `data: <JSON>\n\n`.

### React Web App (`src/App.tsx`)
- All UI in a single file. Do not split unless the file approaches 1,500+ lines.
- Rating tokens live in the `rating` constant at the top — use them, never hardcode colors.
- Animations use `motion/react` (`<motion.div>` + `<AnimatePresence>`).
- Firestore subscription in `App.tsx` uses `onSnapshot` — real-time, no polling.
- Always import only the Lucide icons actually used.

### Chrome Extension (`extension/`)
- Plain JavaScript — no TypeScript, no bundler, no build step.
- Use `chrome.storage.local.get` with defaults as the second argument (pattern: `{ key: defaultValue }`).
- Never access `chrome.storage.local` synchronously — always use the callback/promise form.
- Auth token validation: always check `authTokenExpiry > Date.now()` before using `authToken`.

### CSS / Design
- Tailwind 4 — utility classes only, no custom CSS except in `index.css` for globals.
- Design tokens follow `rating.SAFE` / `rating.OKAY` / `rating.RISKY` shape in `App.tsx`.
- Extension badge styles live in `content.css` — scoped to avoid conflicts with host pages.

---

## Do NOT Touch Without Permission

These areas have subtle invariants that are easy to break silently:

| Area | Why |
|------|-----|
| `checkAndDeductCredits()` and `refundCredits()` in `server.ts` | Firestore transactions — concurrency-sensitive. Changing retry or reset logic can cause double-charges or credit loss. |
| `aggregateResults()` — worst-case scoring logic | The "union of violations + worst score" design is deliberate. Changing it to average or best-case would let bad policies through. |
| `applyConsistencyCrossCheck()` — keyword list | Adding keywords increases false positives; removing them reduces catch rate. Only change after running full evals. |
| `sanitizeCitations()` + `PARAPHRASE_PATTERNS` | These strip LLM hallucinations. Adding too-aggressive patterns will strip real citations. |
| `buildDeterministicDeepFallback()` — regex patterns | The fallback runs when the LLM completely fails. It must err conservative (flag more). |
| Firestore rules (`firestore.rules`) | `shared_cache` must remain client-read-blocked. `users` must be owner-only. Any loosening is a security issue. |
| Extension `keepalive` port mechanism | Removing either keepalive mechanism causes deep scans to fail on slow connections. |
| Cache hash construction in `/api/analyze` | The SHA-256 hash includes `text + eli5 + tier + darkPatterns + model.id`. Changing this invalidates the entire shared cache. |
| `CHUNK_CONCURRENCY = 2` | Set deliberately against 3 NIM keys. Raising it risks 429 storms across all keys simultaneously. |

---

## Common Gotchas

**Firestore database ID is not `(default)`** — it's set in `firebase-applet-config.json`. The server reads this file at startup. Never call `getFirestore()` directly; always use `firestoreDb` (server) or the `db` export from `src/firebase.ts` (client).

**NIM model IDs are trimmed** — `process.env.NIM_MODEL_DEEP.trim()`. If you add a new model env var, `.trim()` it. Trailing whitespace in `.env` causes silent 404s from the NIM API.

**Text truncation cap is 80,000 chars** (`MAX_CHUNKS × CHUNK_SIZE = 8 × 10,000`). Documents longer than this are analyzed only up to the cap. This is logged but not surfaced to the user.

**Quick tier returns no `pillars`** — `pillars: null` is intentional for quick scans. The badge only needs `rating`, `score`, and `tldr`. Code that reads `result.pillars` must null-check.

**ELI5 mode changes citation instructions** — in ELI5 mode, the LLM writes plain-English explanations instead of verbatim quotes. `findVerbatimInChunk()` and citation sanitization still run, but grounding verification is loosened. Don't add verbatim-quote validation in ELI5 paths.

**Extension `apiUrl` must not end with `/api/analyze`** — `background.js` appends the path itself. The storage key holds the base URL only (e.g., `https://my-service.run.app`).

**Cloud Run `PORT` is dynamic** — never hardcode port 3000 in production code. Always read from `process.env.PORT`.

**`firestore.rules` deploys separately** — `npm run build` does not deploy Firestore rules. Rules are deployed via `firebase deploy --only firestore:rules`. Forgetting this means production uses stale rules.

**`firebase-applet-config.json` is not `.env`** — it contains the Firebase project config (project ID, API key, etc.) and is intentionally checked into git. It is not a secret. The actual secrets are NIM keys and the service account JSON.
