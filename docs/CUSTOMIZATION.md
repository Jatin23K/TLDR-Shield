# TLDR Shield — Customization Guide

Everything you can tune, swap, or extend — with exact env vars and code locations.
All changes are isolated: no feature flag sprawl, no hidden coupling.

---

## Quick Reference

| What to change | How | Effort |
|----------------|-----|--------|
| Switch LLM provider (Gemini → OpenAI / Claude / NIM) | Swap API client + model ID in `server.ts` | ~30 min |
| Change the AI model | Set env var | Instant |
| Add a new privacy pillar | 5 locations in `server.ts` + `eval/runEval.ts` | ~2 hours |
| Adjust credit limits | Edit constants in `server.ts` | 2 lines |
| Change cache TTL | Edit constants in `server.ts` | 1 line |
| Tune rate limiting | Edit `express-rate-limit` config in `server.ts` | 1 line |
| Enable dark patterns pillar by default | Flip default in `popup.js` | 1 line |
| Change scan tiers (cost, token budget) | Edit `TIER_CONFIG` in `server.ts` | 4 lines |
| Adjust auto-promote threshold | Edit `AUTO_PROMOTE_CHARS` in `server.ts` | 1 line |
| Add a new language / ELI5 mode variant | Extend `buildSystemPrompt()` in `server.ts` | ~1 hour |
| Use a custom Firestore database | Change `databaseId` in `firebase-applet-config.json` | 1 line |
| Deploy to a different cloud provider | Change `npm run deploy` command in `package.json` | ~20 min |

---

## 1. Switching LLM Providers

TLDR Shield uses the **OpenAI-compatible API format** — every major provider supports it.
Swapping providers requires changing only the API base URL and model ID.

### Currently: Google Gemini (via NVIDIA NIM-compatible endpoint)

```env
GEMINI_API_KEY_1=AIza...
GEMINI_API_KEY_2=AIza...
```

### Switch to: OpenAI GPT-4o

```env
# .env
OPENAI_API_KEY=sk-...
```

In `server.ts`, find the OpenAI client initialization (~line 80) and change:

```typescript
// Before (Gemini)
const client = new OpenAI({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: key,
});

// After (OpenAI)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL defaults to api.openai.com — no change needed
});
```

### Switch to: Anthropic Claude (via OpenAI-compatible proxy)

```env
ANTHROPIC_API_KEY=sk-ant-...
```

```typescript
const client = new OpenAI({
  baseURL: 'https://api.anthropic.com/v1/',
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-version': '2023-06-01' },
});
```

### Switch to: NVIDIA NIM (original backend)

```env
NIM_API_KEY_1=nvapi-...
NIM_API_KEY_2=nvapi-...
NIM_API_KEY_3=nvapi-...
```

```typescript
const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: key,
});
```

> **Why this works:** The entire analysis pipeline (`analyzeChunk`, `extractVerbatimForPillar`,
> embedding calls) calls `nimCreateWithRetry()` which wraps a single OpenAI client instance.
> One function to change, everything else stays identical.

---

## 2. Choosing the AI Model

Model selection is fully env-var driven — no code changes needed.

```env
# Quick scan model (speed-optimised — lower cost)
NIM_MODEL_QUICK=gemini-2.0-flash

# Deep scan model (accuracy-optimised — higher token budget)
NIM_MODEL_DEEP=gemini-2.0-flash

# Examples of drop-in alternatives:
# NIM_MODEL_QUICK=gpt-4o-mini
# NIM_MODEL_DEEP=gpt-4o
# NIM_MODEL_DEEP=claude-3-5-sonnet-20241022
# NIM_MODEL_DEEP=meta/llama-3.3-70b-instruct
```

**Model selection trade-offs:**

| Model | Speed | Accuracy | Cost/scan |
|-------|-------|----------|-----------|
| `gemini-2.0-flash` | Fast (~4s) | 85% | Free tier |
| `gpt-4o-mini` | Fast (~3s) | 87% | ~$0.001 |
| `gpt-4o` | Medium (~8s) | 93% | ~$0.01 |
| `claude-3-5-sonnet` | Medium (~7s) | 94% | ~$0.012 |
| `llama-3.3-70b` | Medium (~6s) | 82% | Free (NIM) |

> The `TIER_CONFIG` in `server.ts` sets `maxTokens` per tier. Upgrading to a smarter model
> with the same token budget gives immediate accuracy gains with zero other changes.

---

## 3. Credit System

Location: `server.ts` → `checkAndDeductCredits()` (~line 200)

```typescript
// Current defaults
const MONTHLY_CREDITS   = 400;   // Free credits per user per month
const QUICK_SCAN_COST   = 10;    // Credits per Quick scan
const DEEP_SCAN_COST    = 20;    // Credits per Deep scan
```

**Example: Freemium model (100 free, paid top-up)**

```typescript
const MONTHLY_CREDITS = 100;  // Lower free tier
// Add a top-up endpoint that writes to users/{uid}.credits in Firestore
```

**Example: Remove credits entirely (open access)**

```typescript
// In POST /api/analyze, comment out:
// await checkAndDeductCredits(uid, cost);
// await refundCredits(uid, cost);
```

---

## 4. Cache TTL

Location: `server.ts` → `setSharedCache()` (~line 350)

```typescript
// Current TTLs
const QUICK_CACHE_TTL_MS = 48 * 60 * 60 * 1000;  // 48 hours
const DEEP_CACHE_TTL_MS  = 7  * 24 * 60 * 60 * 1000;  // 7 days
```

**Example: Longer cache for stable policies (Google, Apple rarely change)**

```typescript
const DEEP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
```

**Example: Disable cache entirely (always fresh)**

```typescript
// Comment out the L1/L2 cache lookup block in POST /api/analyze
// and the setSharedCache() call at the end
```

---

## 5. Rate Limiting

Location: `server.ts` → `express-rate-limit` setup (~line 130)

```typescript
// Current: 30 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
});
```

**Example: Stricter (prevent abuse)**

```typescript
windowMs: 60 * 60 * 1000,  // 1 hour window
max: 20,                    // 20 requests per hour
```

**Example: Bypass for trusted IPs (internal tools)**

```typescript
skip: (req) => req.ip === '127.0.0.1' || req.headers['x-internal-key'] === process.env.INTERNAL_API_KEY,
```

---

## 6. Adding a New Privacy Pillar

To add a new pillar (e.g. `biometric_data`) you must update **5 locations** — they are all
documented here to prevent silent mismatches.

**Step 1 — System prompt** (`server.ts` → `buildSystemPrompt()` ~line 1615)

```typescript
// Add to the pillar definitions block:
biometric_data: {
  description: 'Collection or sharing of fingerprints, face scans, voice prints, or other biometric identifiers.',
  violationThreshold: 'ANY collection of biometric data without explicit consent = violation',
}
```

**Step 2 — Penalty table** (`server.ts` → `PILLAR_PENALTY` ~line 972)

```typescript
const PILLAR_PENALTY: Record<string, number> = {
  ai_training:       30,
  data_selling:      30,
  transparency:      20,
  data_retention:    30,
  content_ownership: 30,
  dark_patterns:     40,
  biometric_data:    40,  // ← add this (elevated — sensitive data category)
};
```

**Step 3 — Consistency cross-check** (`server.ts` → `applyConsistencyCrossCheck()` ~line 1014)

```typescript
biometric_data: {
  keywords: ['biometric', 'fingerprint', 'face scan', 'facial recognition', 'voice print', 'retinal'],
  minKeywords: 1,
}
```

**Step 4 — Deterministic fallback** (`server.ts` → `buildDeterministicDeepFallback()` ~line 1500)

```typescript
biometric_data: /biometric|fingerprint|facial recognition|voice print/i.test(text),
```

**Step 5 — Eval harness mirror** (`eval/runEval.ts` → `PILLAR_PENALTY`)

```typescript
// Must exactly mirror server.ts Step 2
biometric_data: 40,
```

> After adding the pillar, add at least 3 test cases to `eval/dataset.jsonl` — one
> with a clear violation, one without, and one edge case — then run `npm run eval:quick`
> to validate accuracy before deploying.

---

## 7. Scan Tiers (Cost, Token Budget, Timeout)

Location: `server.ts` → `TIER_CONFIG` (~line 160)

```typescript
const TIER_CONFIG = {
  quick: {
    maxTokens:   120,
    timeoutMs:   20_000,
    creditCost:  10,
  },
  deep: {
    maxTokens:   1_400,
    timeoutMs:   45_000,
    creditCost:  20,
  },
};
```

**Example: Add an "Ultra" tier with full GPT-4o analysis**

```typescript
ultra: {
  maxTokens:  4_000,
  timeoutMs:  90_000,
  creditCost: 50,
}
// Then handle 'ultra' in POST /api/analyze alongside 'quick' | 'deep'
```

---

## 8. Auto-Promote to Deep Scan

Long documents (e.g. 50-page ToS) are automatically upgraded from Quick to Deep
to ensure full coverage.

Location: `server.ts` (~line 420)

```typescript
const AUTO_PROMOTE_CHARS = 30_000;  // Promote if text > 30,000 chars
```

**Example: Always use Deep for PDFs regardless of length**

```typescript
// Already implemented — PDFs are force-promoted in background.js
// To change: edit the `if (isPdf)` block in POST /api/analyze
```

---

## 9. Chunk Tuning (Accuracy vs Speed)

For very long documents the text is split into overlapping chunks and analyzed in
parallel. Tuning these affects both accuracy and API cost.

Location: `server.ts` (~line 175)

```typescript
const CHUNK_SIZE        = 10_000;  // Characters per chunk
const CHUNK_OVERLAP     = 2_500;   // Overlap between adjacent chunks (catches violations near boundaries)
const MAX_CHUNKS        = 8;       // Hard cap — prevents runaway costs on huge documents
const CHUNK_CONCURRENCY = 2;       // Parallel LLM calls (set to match number of API keys ÷ 1.5)
```

> `CHUNK_CONCURRENCY` is deliberately conservative at 2. With 5 Gemini keys the theoretical
> max is 5, but bursting all keys simultaneously risks 429 storms. Keep it ≤ `keyCount / 1.5`.

---

## 10. Extension: Enable Dark Patterns by Default

The dark patterns pillar is currently opt-in (user toggles it in the popup).
To make it default-on for all users:

Location: `extension/popup.js` (~line 15)

```javascript
// Before
chrome.storage.local.get({ darkPatterns: false }, ...)

// After
chrome.storage.local.get({ darkPatterns: true }, ...)
```

---

## 11. Deploying to a Different Cloud Provider

The backend is a standard Express app with a `Dockerfile`-compatible source layout.
Cloud Run was chosen for its zero-config HTTPS and free tier — but it runs anywhere.

| Provider | Command |
|----------|---------|
| Google Cloud Run (current) | `npm run deploy` |
| Railway | Push to GitHub → Railway auto-deploys from `server.ts` |
| Render | Connect repo → set `npm run start` as start command |
| Fly.io | `fly launch` → `fly deploy` |
| AWS App Runner | Point at container registry → deploy |

**Required env vars on any platform:**

```env
GEMINI_API_KEY_1=...
FIREBASE_SERVICE_ACCOUNT_JSON='{...}'   # Inline JSON — works on all PaaS
PORT=8080                               # Or whatever the platform assigns
```

---

## 12. Firefox Support

Firefox MV3 support is already implemented via manifest overrides.

Location: `extension/manifest.firefox.json` (overrides applied at build time)

To build the Firefox package:

```bash
npm run build:firefox   # outputs to dist-firefox/
```

The cross-browser shim in `extension/background.js` handles `browser` vs `chrome` API
differences automatically — no code changes needed when targeting Firefox.

---

## Architecture Notes for Reviewers

**Why Express over serverless functions?**
SSE (Server-Sent Events) streaming requires a persistent HTTP connection — serverless
functions time out at 10–30s, well short of a 45s Deep scan. Express on Cloud Run keeps
the connection alive for the full analysis duration.

**Why Firestore over a traditional SQL database?**
The `onSnapshot` real-time listener in `App.tsx` gives the history dashboard instant
updates without polling. Firestore's document model maps 1:1 to scan records with no
schema migrations needed as pillars are added.

**Why not store analysis results in the extension itself?**
Cross-device sync, the shared L2 cache (anyone who scans Google's policy benefits from
the cached result), and policy change detection all require server-side storage. The
extension stores only auth tokens and user preferences locally.

**Why sentence-aware chunking via `compromise` instead of character splits?**
A raw character split at position 10,000 can cut through the middle of a sentence,
causing the LLM to receive incomplete context and miss violations that span a sentence
boundary. `compromise` splits at sentence boundaries, preserving semantic completeness.
