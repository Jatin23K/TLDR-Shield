# TLDR Shield

**Stop blindly clicking "I Agree."**

TLDR Shield is a Chrome Extension + AI backend that automatically detects Terms of Service and Privacy Policy pages, analyzes them using LLMs, and tells you in plain English whether a document is **SAFE**, **OKAY**, or **RISKY** — backed by verbatim evidence pulled directly from the text.

![Version](https://img.shields.io/badge/version-2.0.0-6366f1)
![License](https://img.shields.io/badge/license-Apache--2.0-10b981)
![Stack](https://img.shields.io/badge/stack-React%20%7C%20Express%20%7C%20NVIDIA%20NIM%20%7C%20Firebase-3b82f6)
![Platform](https://img.shields.io/badge/platform-Chrome%20MV3-f59e0b)

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
┌─────────────────────────── Browser (Chrome) ───────────────────────────┐
│                                                                          │
│  content.js            background.js (SW)       popup.html / popup.js   │
│  ┌────────────────┐    ┌──────────────────┐    ┌──────────────────────┐ │
│  │ Detect T&C     │    │ SSE stream reader │    │ Tier picker          │ │
│  │ Extract text   │───▶│ Auth token attach │    │ ELI5 / dark patterns │ │
│  │ Inject badge   │◀───│ Credit error UI   │    │ Sign-in / credits    │ │
│  │ Highlight cite │    │ Keepalive pings   │    └──────────────────────┘ │
│  └────────────────┘    └──────────────────┘                             │
│                                │  ▲                                     │
└────────────────────────────────┼──┼─────────────────────────────────────┘
                                 │  │ SSE
                    ┌────────────▼──┴──────────────────────────────────┐
                    │        Express Backend  (Google Cloud Run)        │
                    │                                                    │
                    │  1. Firebase Auth token verify                    │
                    │  2. Credit deduction (Firestore transaction)      │
                    │  3. L1 in-memory LRU cache lookup                 │
                    │  4. L2 Firestore shared_cache lookup              │
                    │  5. Sentence-aware chunking (compromise NLP)      │
                    │  6. NIM embeddings → semantic chunk ranking       │
                    │  7. LLM inference (2 chunks parallel)             │
                    │  8. Citation grounding + JSON extraction          │
                    │  9. Aggregation + score computation               │
                    │  10. Write to L1 + L2 cache                      │
                    │  11. SSE stream result to extension               │
                    └───────────────────────────────────────────────────┘
                                         │
                    ┌────────────────────▼──────────────────────────────┐
                    │          NVIDIA NIM (integrate.api.nvidia.com)    │
                    │  Embedding:  nvidia/nv-embedqa-e5-v5              │
                    │  LLM:        meta/llama-3.3-70b-instruct          │
                    └───────────────────────────────────────────────────┘
                                         │
                    ┌────────────────────▼──────────────────────────────┐
                    │                   Firestore                       │
                    │  /users/{uid}         credits, lastResetMonth     │
                    │  /scans/{scanId}      full scan result per user   │
                    │  /shared_cache/{hash} anonymous cross-user cache  │
                    │  /reports/{id}        user-submitted feedback     │
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

---

## Credit System

- **400 free credits per month**, auto-reset on the 1st of each month
- Credits deducted only after cache miss (cached results are free)
- Credits refunded automatically if a scan fails
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
| Backend | Node.js, Express, TypeScript, Vite (middleware mode) |
| AI Models | NVIDIA NIM — `meta/llama-3.3-70b-instruct`, `nvidia/nv-embedqa-e5-v5` |
| NLP Chunking | `compromise` (sentence-aware splitting, 10k chars / 2.5k overlap) |
| Auth & DB | Firebase Auth (Google Sign-In) + Firestore |
| Deployment | Google Cloud Run |
| Web App | React 19, Tailwind CSS 4, Framer Motion |
| PDF Support | pdf.js via MV3 offscreen document |

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
# NVIDIA NIM API keys (at least one required, all 3 for failover)
NIM_API_KEY_1=nvapi-...
NIM_API_KEY_2=nvapi-...
NIM_API_KEY_3=nvapi-...

# Firebase service account (local dev only — Cloud Run uses ADC automatically)
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json

# Production backend URL (used for CORS)
APP_URL=https://your-cloud-run-url.run.app

# Optional: protect API endpoints with a key
INTERNAL_API_KEY=your-secret-key

# Optional: tune NIM retry behavior
NIM_PER_KEY_TIMEOUT_MS=12000
NIM_RETRY_ROUNDS=3
```

Start the full-stack dev server:

```bash
npm run dev        # Express + Vite HMR on :3000
npm run build      # Build React frontend
npm run lint       # TypeScript type-check
```

### Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Open the extension popup → enter your backend URL (e.g. `https://your-backend.run.app/api/analyze`) → **Save**
5. Sign in with Google to activate your free credits

The extension requires no build step — it's plain Vanilla JavaScript.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NIM_API_KEY_1` | Yes | Primary NVIDIA NIM API key |
| `NIM_API_KEY_2` | No | Failover key |
| `NIM_API_KEY_3` | No | Failover key |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Local dev | Path to Firebase service account JSON |
| `APP_URL` | Production | Deployed backend URL (CORS allowlist) |
| `INTERNAL_API_KEY` | Optional | Require `X-API-Key` header on all endpoints |
| `NIM_PER_KEY_TIMEOUT_MS` | Optional | Per-key timeout in ms (default: 12000) |
| `NIM_RETRY_ROUNDS` | Optional | Retry rounds on NIM failure (default: 3) |
| `NIM_MODEL_QUICK` | Optional | Override quick scan model ID |
| `NIM_MODEL_DEEP` | Optional | Override deep scan model ID |
| `ALLOW_UNMETERED_LOCAL` | Dev only | Skip credit checks locally (set to `true`) |

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/analyze` | Firebase Bearer token | Main analysis — SSE stream |
| `GET` | `/api/credits` | Firebase Bearer token | Return live credit balance |
| `POST` | `/api/report` | Firebase Bearer token | Submit feedback on a result |
| `DELETE` | `/api/cache` | API key (dev only) | Clear L1/L2 cache by URL or hash |
| `GET` | `/health` | None | Uptime, memory, cache stats |

---

## Evaluation

```bash
npm run eval          # Full evaluation suite
npm run eval:quick    # Quick-tier evals only
npm run eval:deep     # Deep-tier evals only
npm run eval:dark     # Dark pattern detection tests
npm run check:nim     # Health-check all NIM API keys
```

Test documents are in `eval/dataset.jsonl`. Golden tests are in `eval/golden.test.ts`.

---

## Deployment (Google Cloud Run)

```bash
# Build and push container
gcloud builds submit --tag gcr.io/YOUR_PROJECT/tldr-shield

# Deploy
gcloud run deploy tldr-shield \
  --image gcr.io/YOUR_PROJECT/tldr-shield \
  --platform managed \
  --region asia-southeast1 \
  --set-env-vars APP_URL=https://your-url.run.app \
  --set-env-vars NIM_API_KEY_1=nvapi-... \
  --allow-unauthenticated
```

Cloud Run uses Application Default Credentials automatically — no service account file needed in production.

---

## Firestore Collections

| Collection | Document | Fields |
|------------|----------|--------|
| `/users/{uid}` | Per user | `credits`, `lastResetMonth`, `role` |
| `/scans/{scanId}` | Per scan | `uid`, `url`, `rating`, `score`, `tldr`, `pillars`, `tier`, `createdAt` |
| `/shared_cache/{hash}` | Per URL+tier | `result`, `tier`, `scannedAt`, `expiresAt`, `scanCount` |
| `/reports/{id}` | Per report | `uid`, `url`, `rating`, `score`, `pillars`, `requestId`, `createdAt` |

---

## Roadmap

- [ ] WASM local inference — run small models in-browser for fully private Quick Scans
- [ ] One-click opt-out — auto-generate GDPR "Right to Erasure" request emails
- [ ] Privacy benchmarking — compare a site's score against industry averages
- [ ] Firefox support
- [ ] Batch scan — analyze all T&C links on a page at once

---

Built with ❤️ for privacy.
