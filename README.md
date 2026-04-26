# TLDR Shield

**Stop blindly clicking "I Agree."**

TLDR Shield is a browser extension + AI backend that automatically detects Terms of Service and Privacy Policy pages, analyzes them using LLMs, and tells you in plain English whether a document is **SAFE**, **OKAY**, or **RISKY** — backed by verbatim evidence pulled directly from the text.

![Version](https://img.shields.io/badge/version-2.0.0-6366f1)
![License](https://img.shields.io/badge/license-Apache--2.0-10b981)
![Stack](https://img.shields.io/badge/stack-React%20%7C%20Express%20%7C%20Gemini%202.5%20%7C%20Firebase-3b82f6)
![Platform](https://img.shields.io/badge/platform-Chrome%20MV3%20%7C%20Firefox-f59e0b)

---

## What It Does

| Output | Description |
|--------|-------------|
| **Rating badge** | SAFE / OKAY / RISKY injected directly into the page |
| **Privacy score** | 0–100 numerical score |
| **Plain-English TL;DR** | One-paragraph summary anyone can understand |
| **Pillar breakdown** | 6 privacy categories each with a verbatim citation highlighted in the actual document |
| **ELI5 mode** | Toggle to translate legal jargon into simple conversational English |

---

## Architecture

```
┌────────────────────────── Browser (Chrome / Firefox) ──────────────────────────┐
│                                                                                  │
│  content.js            background.js (SW)         popup.html / popup.js         │
│  ┌────────────────┐    ┌──────────────────┐    ┌────────────────────────────┐   │
│  │ Detect T&C     │    │ SSE stream reader │    │ Tier picker                │   │
│  │ Extract text   │───▶│ Auth token attach │    │ ELI5 / dark patterns       │   │
│  │ Inject badge   │◀───│ Credit error UI   │    │ Sign-in / credits          │   │
│  │ Highlight cite │    │ Keepalive pings   │    │ GDPR email / batch scan    │   │
│  └────────────────┘    └──────────────────┘    │ Watch / notifications      │   │
│                                │  ▲             │ ⚡ Local AI badge           │   │
└────────────────────────────────┼──┼─────────────┴────────────────────────────┘  │
                                 │  │                                              │
                                 │  │ SSE                                          │
                    ┌────────────▼──┴──────────────────────────────────┐
                    │        Express Backend  (Google Cloud Run)        │
                    │                                                    │
                    │  1. Firebase Auth token verify                    │
                    │  2. Credit deduction (Firestore transaction)      │
                    │  3. L1 in-memory LRU cache lookup                 │
                    │  4. L2 Firestore shared_cache lookup              │
                    │  5. Sentence-aware chunking (compromise NLP)      │
                    │  6. NIM embeddings → semantic chunk ranking       │
                    │  7. LLM inference (chunks run in parallel)        │
                    │  8. Second NIM judge pass (result verification)   │
                    │  9. Citation grounding + JSON extraction          │
                    │  10. Aggregation + score computation              │
                    │  11. Consistency cross-check + retry on conflict  │
                    │  12. Write to L1 + L2 cache                      │
                    │  13. SSE stream result to extension               │
                    └───────────────────────────────────────────────────┘
                                         │
                     ┌────────────────────▼──────────────────────────────┐
                     │          Google Gemini API (AI Studio)            │
                     │  Models:  gemini-2.5-flash (Primary)              │
                     │           gemini-2.5-flash-lite (Utility)         │
                     └───────────────────────────────────────────────────┘

---

## 🏗 High-Availability Architecture
TLDR Shield uses a **Hybrid-Lane Priority Pool** to bypass free-tier rate limits.
*   **SCAN POOL (Keys 1-3):** Prioritized for real-time document analysis.
*   **UTILITY POOL (Keys 4-6):** Prioritized for citations, grounding, and background tasks.
*   **The Judge Ensemble:** Runs multiple models (Flash + Flash-Lite) in parallel to reach consensus on risky clauses.

For a deep dive into the engineering tradeoffs, see [SYSTEM_DESIGN.md](./TLDR_SYSTEM_DESIGN.md).

---

## 🚀 Key Features
*   **Verbatim Grounding:** Heuristic-based alignment that replaces LLM paraphrases with the exact source text.
*   **Multi-Layer Cache:** Sub-millisecond retrieval via Upstash Redis (L1) and persistent shared intelligence via Firestore (L2).
*   **The Judge Pattern:** Multi-model ensemble to maximize violation recall.
                                         │
                    ┌────────────────────▼──────────────────────────────┐
                    │                   Firestore                       │
                    │  /users/{uid}              credits, lastResetMonth│
                    │  /scans/{scanId}           full scan result       │
                    │  /shared_cache/{hash}      cross-user cache       │
                    │  /reports/{id}             user feedback          │
                    └───────────────────────────────────────────────────┘
```

---

## The 6 Privacy Pillars

| # | Pillar | What It Checks |
|---|--------|----------------|
| 1 | **AI Training Opt-Out** | Does the service use your data to train AI models without explicit consent? |
| 2 | **Third-Party Monetization** | Is your data sold to brokers or shared for targeted advertising? |
| 3 | **Transparency** | Is the language intentionally vague, evasive, or confusing? |
| 4 | **Data Retention & Exit** | Can you permanently delete your data? How long is it kept? |
| 5 | **Content Ownership** | Do you surrender copyright to your uploaded content? |
| 6 | **Dark Patterns** | Does the document use manipulative language to hide traps or bury opt-outs? |

---

## Scoring

| Rating | Condition |
|--------|-----------|
| **SAFE** | 0 major violations across all pillars |
| **OKAY** | 0 major violations but vague Transparency pillar |
| **RISKY** | 1 or more major violations detected |

---

## Scan Tiers

| | Quick Scan | Deep Scan |
|-|-----------|-----------|
| **Cost** | 10 credits | 20 credits |
| **Max tokens** | 120 | 1,400 |
| **Timeout** | 20s | 45s |
| **Output** | Rating + score + TL;DR | Full pillar breakdown + verbatim citations |
| **Auto-promote** | — | Documents > 30,000 chars auto-promoted to Deep |
| **Local inference** | Texts ≤ 5,000 chars run free in-browser (WASM) | Cloud always |

---

## Credit System

- **400 free credits per month**, auto-reset on the 1st of each month
- Credits deducted only after cache miss (cached results are free)
- Credits refunded automatically if a scan fails
- GDPR erasure email generation costs 5 credits
- Sign in with Google to access credits and scan history

---

## Caching

| Layer | Type | TTL |
|-------|------|-----|
| **L1** | In-memory LRU (per instance) | Until server restart |
| **L2** | Firestore `shared_cache` (shared across all users) | 48h Quick / 7d Deep |

When User A scans Spotify's ToS, the result is anonymously cached. When User B scans the same page within the TTL window, it's served instantly at no credit cost.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Chrome Extension | Manifest V3, Vanilla JavaScript |
| Backend | Node.js, Express, TypeScript |
| AI Models | Google Gemini 2.5 (Flash / Pro) |
| NLP Chunking | `compromise` (sentence-aware splitting) |
| Auth & DB | Firebase Auth (Google Sign-In) + Firestore |
| Cache | Upstash Redis (L1) + Firestore (L2 Shared Cache) |
| Deployment | Google Cloud Run |
| Web App | React 19, Tailwind CSS 4, Framer Motion |
| Content Extraction | `@mozilla/readability` (Same as Firefox Reader Mode) |

---

## Installation

### Backend + Web App

```bash
git clone https://github.com/Jatin23K/TLDR-Shield.git
cd TLDR-Shield
npm install
```

Create a `.env` file:

```env
# Gemini API keys (6 keys recommended for failover pooling)
# Lanes 1-3 for Scanning, Lanes 4-6 for Utility
GEMINI_SCAN_KEY_1=AIza...
GEMINI_SCAN_KEY_2=AIza...
GEMINI_SCAN_KEY_3=AIza...
GEMINI_UTIL_KEY_1=AIza...
GEMINI_UTIL_KEY_2=AIza...
GEMINI_UTIL_KEY_3=AIza...

# Optional: tune retry behavior
GEMINI_RETRY_ROUNDS=3
```

Start the full-stack dev server:

```bash
npm run dev        # Express + Vite HMR on :3000
npm run build      # Build React frontend
npm run lint       # TypeScript type-check
```

### Chrome and Firefox Extension

```bash
# Build both Chrome and Firefox variants
bash build-extension.sh
# → dist-chrome/  (Chrome — load via chrome://extensions)
# → dist-firefox/ (Firefox — load via about:debugging > This Firefox > Load Temporary Add-on)
```

**Chrome (unpacked, no build required):**

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Open the extension popup → enter your backend URL → **Save**
5. Sign in with Google to activate your free credits

**Firefox (built):**

1. Run `bash build-extension.sh`
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**
3. Select `dist-firefox/manifest.json`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NIM_API_KEY_1` | Yes | Primary NVIDIA NIM API key |
| `NIM_API_KEY_2` | No | Failover key |
| `NIM_API_KEY_3` | No | Failover key |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Local dev | Path to Firebase service account JSON |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | PaaS | Inline service account JSON string |
| `APP_URL` | Production | Deployed backend URL (CORS allowlist) |
| `INTERNAL_API_KEY` | Optional | Require `x-internal-key` header on internal endpoints |
| `NIM_PER_KEY_TIMEOUT_MS` | Optional | Per-key timeout in ms (default: 12000) |
| `NIM_RETRY_ROUNDS` | Optional | Retry rounds on NIM failure (default: 3) |
| `NIM_MODEL_QUICK` | Optional | Override quick scan model ID |
| `NIM_MODEL_DEEP` | Optional | Override deep scan model ID |
| `ALLOW_UNMETERED_LOCAL` | Dev only | Skip credit checks locally (set to `true`) |

---

## API Endpoints

| Method | Path | Auth | Credits | Description |
|--------|------|------|---------|-------------|
| `POST` | `/api/analyze` | Firebase Bearer token | 10 / 20 | Main analysis — SSE stream |
| `GET` | `/api/credits` | Firebase Bearer token | — | Return live credit balance |
| `POST` | `/api/report` | Firebase Bearer token | — | Submit feedback on a result |
| `POST` | `/api/gdpr-email` | Firebase Bearer token | 5 | Generate GDPR Right to Erasure request email |
| `GET` | `/api/benchmark/:category` | None | — | Industry benchmark comparison for a category |
| `POST` | `/api/watch` | Firebase Bearer token | — | Watch a URL for policy changes (max 10 per user) |
| `DELETE` | `/api/watch/:watchId` | Firebase Bearer token | — | Unwatch a URL |
| `GET` | `/api/watch` | Firebase Bearer token | — | List all watched URLs for the current user |
| `GET` | `/api/notifications` | Firebase Bearer token | — | Get unread policy change notifications |
| `POST` | `/api/recheck` | `x-internal-key` | — | Internal: purge cache for a URL to force fresh scan |
| `DELETE` | `/api/cache` | `x-internal-key` | — | Internal: clear global hot cache (Redis) |
| `GET` | `/health` | None | — | Uptime, memory, cache stats |

---

## Firestore Collections

| Collection | Document | Fields |
|------------|----------|--------|
| `/users/{uid}` | Per user | `credits`, `lastResetMonth`, `role` |
| `/scans/{scanId}` | Per scan | `uid`, `url`, `rating`, `score`, `tldr`, `pillars`, `tier`, `createdAt` |
| `/shared_cache/{hash}` | Per URL+tier | `result`, `tier`, `scannedAt`, `expiresAt`, `scanCount` |
| `/reports/{id}` | Per report | `uid`, `url`, `rating`, `score`, `pillars`, `requestId`, `createdAt` |
| `/watches/{watchId}` | Per watched URL | `url`, `uid`, `lastHash`, `nextCheckAt` |
| `/notifications/{uid}/items/{id}` | Per alert | `url`, `changedAt`, `read`, `previousHash`, `newHash` |

---

## Scan Quality

Every result passes through multiple verification layers before being returned:

- **Second NIM judge pass** — a separate LLM call verifies the primary result for each pillar before the response is finalized
- **Citation verification** — `sanitizeCitations()` strips hallucinated paraphrase patterns and validates that citations are verbatim substrings of the source text
- **Rating/score consistency cross-check** — a SAFE rating paired with a score below 60, or a RISKY rating paired with a score above 70, automatically triggers a retry
- **Content extraction** — `@mozilla/readability` (the same library powering Firefox Reader Mode) strips boilerplate navigation, ads, and footers before text reaches the LLM pipeline
- **Auto-escalation** — low-confidence Quick scan results are automatically re-run as Deep scans without user intervention

---

## Performance

- Deep scan chunks run in parallel via `Promise.allSettled` — wall-clock time scales as O(n chunks / concurrency) rather than O(n chunks) sequentially
- Policy text is capped at 400 KB before entering the LLM pipeline, preventing runaway latency on unusually large documents
- The `/api/recheck` job is paginated (limit/offset) so Cloud Scheduler invocations never time out regardless of the number of watched URLs

---

## 🏗 Key Pool Architecture (Free Tier Optimization)

TLDR Shield uses a **6-key rotation strategy** to bypass the rate limits of the Gemini free tier.
*   **SCAN POOL (Keys 1-3):** Dedicated to high-priority user scans.
*   **UTILITY POOL (Keys 4-6):** Dedicated to background tasks (grounding, emails, rechecks).
This ensures that background work never blocks a user from getting a result.

---

## 🚀 Roadmap

- [ ] **WASM Local Inference:** Analyze short texts (<5k chars) entirely in the browser using Transformers.js to save credits.
- [ ] **Policy Watcher:** Receive alerts when a site you use silently updates its terms.
- [ ] **GDPR Email Generator:** One-click generation of formal Article 17 erasure requests.
- [ ] **Privacy Benchmarking:** Compare a site's score against industry averages for its category.
- [ ] **Firefox Support:** Cross-browser parity.

---

Built with ❤️ for privacy.
