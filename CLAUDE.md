# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TLDR Shield is a Chrome Extension (Manifest V3) + Express backend that uses LLMs (NVIDIA NIM / llama-3.3-70b) to scan and score Terms of Service and Privacy Policies. There is also a React web app (landing page + scan history dashboard).

## Commands

```bash
npm run dev          # Start full-stack dev server (Express + Vite HMR on :3000)
npm run build        # Build React frontend with Vite
npm run lint         # TypeScript type-check (no tsc emit)
npm run clean        # Remove dist/

npm run eval         # Full evaluation suite
npm run eval:quick   # Quick-tier evals only
npm run eval:deep    # Deep-tier evals only
npm run eval:dark    # Dark pattern detection tests
npm run check:nim    # Health-check NVIDIA NIM API keys
```

The Chrome extension (`extension/`) is plain JavaScript — no build step. Load it via `chrome://extensions` → "Load unpacked" pointing to `extension/`.

## Architecture

### Three Layers

1. **Chrome Extension** (`extension/`) — Manifest V3, vanilla JS
   - `content.js`: Detects T&C pages (confidence scoring), extracts text via Readability.js, handles PDF via offscreen, injects floating badge
   - `background.js`: Service worker; receives extracted text, streams analysis from backend, manages auth tokens, keepalive port to avoid SW termination
   - `popup.js` + `popup.html`: Tier selection (Quick/Deep), feature flags (ELI5, dark patterns), Firebase sign-in
   - `offscreen.js`: PDF text extraction via pdf.js (offscreen document required by MV3)

2. **Express Backend** (`server.ts`) — runs on Cloud Run, single large file
   - `POST /api/analyze`: Auth token → credit deduction → L1/L2 cache lookup → sentence-aware chunking → NIM embedding + LLM pipeline → SSE stream
   - `GET /api/credits`: Return user credit balance
   - L1 cache: in-memory LRU; L2 cache: Firestore `shared_cache` (TTL: 48h quick / 7d deep)

3. **React Web App** (`src/`) — landing page + scan history, built by Vite, served by Express in dev (middleware mode)

### LLM Pipeline (inside `server.ts`)

1. Split document into sentence-aware chunks (10k chars, 2.5k overlap, via `compromise` NLP)
2. Embed pillar descriptions + chunks via `nvidia/nv-embedqa-e5-v5`, rank by cosine similarity
3. Send top chunks to `meta/llama-3.3-70b-instruct` (OpenAI-compatible SDK pointing at NIM)
4. Analyze 6 privacy pillars: AI Training, Third-Party Monetization, Transparency, Data Retention, Content Ownership, Dark Patterns
5. Ground citations via `findVerbatimInChunk()` (key-term co-location → sentence expansion)
6. Stream SSE results back to extension

**Tiers**: Quick (120 max tokens, 20s timeout, 10 credits) vs Deep (1400 max tokens, 30s timeout, 20 credits). Text >30k chars auto-promotes to Deep.

**NIM key rotation**: 3 keys in `.env` (`NIM_API_KEY_1/2/3`), 8s per-key timeout, auto-failover on 5xx/429.

### Firebase / Firestore Collections

- `/users/{uid}`: `{ credits, lastResetMonth, role }` — 400 free credits/month, auto-reset on 1st
- `/scans/{scanId}`: `{ uid, url, rating, score, tldr, pillars, tier, createdAt }`
- `/shared_cache/{hash}`: anonymous cache shared across users

### Scoring

- **SAFE**: 0 major violations
- **OKAY**: 0 major violations but vague Transparency pillar
- **RISKY**: 1+ major violations

### Service Worker Keepalive

MV3 service workers die after ~30s. Content script opens a `keepalive` chrome.runtime port before triggering analysis; background.js pings itself every 20s via `chrome.runtime.getPlatformInfo()` until scan completes.

## Key Files

| File | Role |
|------|------|
| `server.ts` | Entire backend — LLM pipeline, caching, auth, scoring |
| `src/App.tsx` | React landing page + history dashboard |
| `extension/content.js` | T&C detection + text extraction |
| `extension/background.js` | Service worker + streaming |
| `eval/golden.test.ts` | Golden test suite against known documents |
| `eval/dataset.jsonl` | Test document dataset |
| `firebase-blueprint.json` | Firestore schema reference |
| `firestore.rules` | Firestore security rules |

## Environment Variables (`.env`)

```
NIM_API_KEY_1=nvapi-...   # Primary NIM key
NIM_API_KEY_2=nvapi-...   # Failover
NIM_API_KEY_3=nvapi-...   # Failover
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/sa.json  # Local dev only
APP_URL=https://...       # Deployment URL
```

Cloud Run uses Application Default Credentials automatically (no service account file needed).
