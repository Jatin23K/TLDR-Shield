# TLDR Shield — Complete Technical Reference

> Everything about how TLDR Shield works, why it was designed the way it was, and what every moving part does.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [System Overview](#2-system-overview)
3. [Chrome Extension](#3-chrome-extension)
4. [Express Backend](#4-express-backend)
5. [LLM Pipeline — Step by Step](#5-llm-pipeline--step-by-step)
6. [Models — Which, Why, and Config](#6-models--which-why-and-config)
7. [Scanning Criteria — The 6 Privacy Pillars](#7-scanning-criteria--the-6-privacy-pillars)
8. [Scoring System](#8-scoring-system)
9. [Chunking — How Large Documents Are Handled](#9-chunking--how-large-documents-are-handled)
10. [Citation Grounding — Verbatim Evidence](#10-citation-grounding--verbatim-evidence)
11. [Caching Architecture](#11-caching-architecture)
12. [Firebase & Firestore — Why and How](#12-firebase--firestore--why-and-how)
13. [Credit System](#13-credit-system)
14. [NIM API Key Rotation & Failover](#14-nim-api-key-rotation--failover)
15. [Service Worker Keepalive](#15-service-worker-keepalive)
16. [Auth Flow](#16-auth-flow)
17. [React Web App](#17-react-web-app)
18. [Evaluation & Testing](#18-evaluation--testing)
19. [API Endpoints](#19-api-endpoints)
20. [Environment Variables](#20-environment-variables)
21. [Deployment](#21-deployment)

---

## 1. What It Does

TLDR Shield is a Chrome Extension that automatically detects when you visit a Terms of Service or Privacy Policy page and, on demand, runs it through an AI-powered privacy analysis pipeline. It tells you — in plain English — whether the document is **SAFE**, **OKAY**, or **RISKY**, backed by verbatim evidence pulled directly from the text.

**The problem it solves**: Legal documents are intentionally complex, dense, and long. Most users click "I Agree" without reading. TLDR Shield acts as a real-time privacy attorney in the browser, surfacing clauses that matter — AI training opt-outs, data selling, ownership grabs, dark patterns — in seconds.

**Key outputs:**
- A **rating badge** (SAFE / OKAY / RISKY) injected directly into the page
- A **privacy score** (0–100)
- A **plain-English TL;DR** summary
- On Deep scan: **6 pillar breakdowns** each with a verbatim citation highlighted in the actual document

---

## 2. System Overview

```
┌─────────────────────────────── Browser (Chrome) ──────────────────────────────┐
│                                                                                 │
│  content.js          background.js (SW)        popup.html / popup.js           │
│  ┌──────────────┐    ┌────────────────────┐    ┌──────────────────────────┐    │
│  │ Detect T&C   │    │ SSE stream reader  │    │ Tier picker (Quick/Deep) │    │
│  │ Extract text │───▶│ Auth token attach  │    │ ELI5 / dark patterns     │    │
│  │ Inject badge │◀───│ Credit error UI    │    │ Sign-in / credits badge  │    │
│  │ Highlight    │    │ Keepalive pings    │    └──────────────────────────┘    │
│  └──────────────┘    └────────────────────┘                                    │
│                              │  ▲                                              │
│                         POST │  │ SSE                                          │
└──────────────────────────────┼──┼──────────────────────────────────────────────┘
                               │  │
                    ┌──────────▼──┴──────────────────────────────────────────┐
                    │          Express Backend  (Cloud Run / :3000)           │
                    │                                                          │
                    │  POST /api/analyze                                       │
                    │  ┌──────────────────────────────────────────────────┐   │
                    │  │ 1. Firebase Auth token verify                    │   │
                    │  │ 2. Credit check & deduction (Firestore tx)       │   │
                    │  │ 3. L1 in-memory LRU cache lookup                 │   │
                    │  │ 4. L2 Firestore shared_cache lookup              │   │
                    │  │ 5. Sentence-aware chunking (compromise NLP)      │   │
                    │  │ 6. NIM embeddings → semantic chunk ranking       │   │
                    │  │ 7. LLM inference per chunk (2 parallel)          │   │
                    │  │ 8. JSON extraction + citation grounding          │   │
                    │  │ 9. Aggregation + score override                  │   │
                    │  │ 10. Write to L1 + L2 cache                       │   │
                    │  │ 11. SSE stream result back                       │   │
                    │  └──────────────────────────────────────────────────┘   │
                    │                          │                               │
                    └──────────────────────────┼───────────────────────────────┘
                                               │
                    ┌──────────────────────────▼───────────────────────────────┐
                    │               NVIDIA NIM  (integrate.api.nvidia.com)     │
                    │   Embedding:  nvidia/nv-embedqa-e5-v5                    │
                    │   Quick LLM:  meta/llama-3.3-70b-instruct                │
                    │   Deep LLM:   meta/llama-3.3-70b-instruct                │
                    └──────────────────────────────────────────────────────────┘
                                               │
                    ┌──────────────────────────▼───────────────────────────────┐
                    │                       Firestore                          │
                    │  /users/{uid}        — credits, lastResetMonth, role     │
                    │  /scans/{scanId}     — full scan result per user         │
                    │  /shared_cache/{hash}— anonymous cross-user result cache │
                    │  /reports/{id}       — user-submitted feedback           │
                    └──────────────────────────────────────────────────────────┘
```

---

## 3. Chrome Extension

The extension is **Manifest V3, plain vanilla JavaScript** — no build step, no framework. Load unpacked from the `extension/` directory.

### Files and Roles

| File | Role |
|------|------|
| `manifest.json` | Permissions, content scripts, service worker declaration |
| `content.js` | Detects T&C pages, extracts text, injects badge, renders results |
| `background.js` | Service worker: streams analysis, manages auth, routes PDFs |
| `popup.js` + `popup.html` | Tier selection, feature toggles, sign-in UI, live credit balance |
| `offscreen.js` | PDF text extraction via pdf.js (MV3 requires offscreen doc for ESM) |
| `lib/Readability.js` | Mozilla Readability — strips nav/footer/ads from page DOM |
| `lib/mark.min.js` | Highlights verbatim citation text in the original page |
| `lib/pdf.min.mjs` + `pdf.worker.min.mjs` | pdf.js bundled locally (CSP-safe) |

### T&C Detection Algorithm (content.js)

Detection runs on every page load using **weighted confidence scoring**. A button only appears when the score clears the threshold of **30 points**:

| Signal | Points | How It's Detected |
|--------|--------|-------------------|
| URL path matches legal regex | 40 | `/terms`, `/privacy`, `/tos`, `/eula`, `/legal`, `/cookie-policy`, etc. |
| Page `<title>` has legal keyword | 25 | "Terms of Service", "Privacy Policy", "EULA", etc. |
| `<h1>` contains legal keyword | 20 | First heading on the page |
| `<h2>` contains legal keyword | 15 | Only counted if total score < 60 to prevent stacking |
| Visible modal/dialog with legal keyword | 30 | `.modal`, `[role="dialog"]`, etc. that are currently visible |
| Cookie consent banner detected | 20 | OneTrust, Cookiebot, Osano, `.cc-window`, and 10+ others |
| Meta tag mentions legal | 10 | `og:type`, meta description |

**Blocked hosts** (false-positive risk too high): `paypal`, `stripe`, `bank`, `trading`, `invest`, `crypto`, `gambling`, `casino`, `betting`, `forex`, `brokerage`.

### Text Extraction

Uses Mozilla `Readability.js` to clone the DOM and strip non-content elements (nav, footer, sidebars, ads) before extracting text — the same library that powers Firefox Reader Mode. This ensures the LLM receives clean legal prose rather than a soup of button labels and navigation links.

For PDF pages: the PDF URL is routed to `offscreen.js` via `background.js`. An offscreen document (required by MV3 for ESM + DOM access) uses pdf.js to extract text page-by-page and returns it as a concatenated string.

### Message Bus

All cross-context communication is via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `ANALYZE_TEXT` | content → background | Submit extracted text for analysis |
| `ANALYZE_PDF` | content → background | Route a PDF URL through the offscreen pipeline |
| `EXTRACT_PDF` | background → offscreen | Start pdf.js extraction |
| `PDF_TEXT` | offscreen → background | Extracted PDF text ready |
| `EXTRACT_FOR_POPUP` | popup → content | Popup-initiated scan: reuse content script extraction |
| `ANALYSIS_PROGRESS` | background → content | Forward SSE progress steps to the in-page badge |
| `ANALYSIS_RESULT` | background → content | Final result object (or error string) |
| `OUT_OF_CREDITS` | background → content | 402 response — show out-of-credits UI |
| `STORE_AUTH` / `CLEAR_AUTH` | content → background | Persist/clear Firebase ID token from web app |
| `GET_AUTH` | popup → background | Read auth state from `chrome.storage.local` |

---

## 4. Express Backend

Single file: `server.ts`. Runs on **Google Cloud Run**, port from `$PORT` env var (default 3000).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/analyze` | Firebase Bearer token | Main analysis endpoint — SSE stream |
| `GET` | `/api/credits` | Firebase Bearer token | Return live credit balance |
| `POST` | `/api/report` | None | Store user-submitted feedback in Firestore |
| `DELETE` | `/api/cache` | None (dev only) | Clear L1 and/or L2 cache for a URL |
| `GET` | `/health` | None | Uptime, memory, cache size, NIM key count |

### Request Validation

Before any LLM call:
1. `text` must be a string and present — 400 if missing
2. `tier` must be `"quick"`, `"deep"`, or absent — 400 if unrecognized value
3. Text must contain at least 20 words — 400 if too short
4. Firebase ID token must be valid — 401 if missing or expired
5. User must have enough credits — 402 with reset date if insufficient

### CORS

In dev: all origins allowed. In production:
- Known web app origin (`APP_URL`)
- `http://localhost:3000` and `http://localhost:5173`
- Any `chrome-extension://` origin
- Any `moz-extension://` origin
- Null origin (extension service workers send `Origin: null`)

### Rate Limiting

30 requests per 15 minutes per IP (`express-rate-limit`). Health check is exempt.

---

## 5. LLM Pipeline — Step by Step

This is the full path from raw page text to final SSE result for a **Deep scan** of a large document:

```
Raw page text (up to 80,000 chars)
        │
        ▼
1. TRUNCATE to 80k chars (MAX_CHUNKS × CHUNK_SIZE = 8 × 10k)
        │
        ▼
2. SENTENCE-AWARE CHUNKING (compromise NLP)
   - Split into sentences
   - Group sentences into 10,000-char blocks
   - 2,500-char sentence-level overlap between adjacent blocks
   - Result: 1–8 chunks
        │
        ▼
3. PARALLEL ANALYSIS (2 chunks at a time)
   For each chunk:
     ├─ Build system prompt (Quick or Deep, ELI5 flag, dark patterns flag)
     ├─ Call NIM (meta/llama-3.3-70b-instruct) via OpenAI-compatible SDK
     ├─ Extract JSON from raw completion (strip <think> tags, depth-counter parser)
     └─ Result: { rating, score, tldr, pillars{}, deductions[] }
        │
        ▼
4. AGGREGATION (multi-chunk only)
   - Worst score wins (most conservative result)
   - Pillars: if ANY block flags a violation → violation=true overall
   - Citations come from the block that found the actual violation
   - Consistency cross-check: deductions must match violation=true pillars
        │
        ▼
5. CITATION GROUNDING (deep tier)
   Pass 1: findVerbatimInChunk()
     - Extract key terms from LLM's paraphrase
     - Find co-located terms in source text (±150 char window)
     - Expand to sentence boundaries (±200 chars, ≤60 words)
     - Replace paraphrase with verbatim passage

   Pass 2 (only if Pass 1 fails): extractVerbatimForPillar()
     - Embed pillar description via nvidia/nv-embedqa-e5-v5
     - Rank source paragraphs by cosine similarity
     - Focused LLM call on top-3 passages: "copy-paste exact clause"
     - Verify the returned citation prefix exists in source text

   If neither pass finds verbatim evidence → demote violation to CLEAR
        │
        ▼
6. CITATION VALIDATION
   - Paraphrase pattern check: "The policy states...", "The terms...", etc. → demote
   - Existence check: first 50 chars of citation must appear in source text → demote if not
   - Confidence filter: violation with no citation = unreliable → demote to CLEAR
        │
        ▼
7. SERVER-SIDE SCORE OVERRIDE
   Count actual violations → force score into correct band regardless of LLM's score:
   - 0 violations  → score 80-100
   - 1 violation   → score 40-60
   - 2 violations  → score 25-45
   - 3-4 violations → score 15-24
   - 5-6 violations → score 15-19
        │
        ▼
8. RATING CONSISTENCY ENFORCEMENT
   - score < 50   → rating forced to RISKY
   - score 50-74  → rating cannot be SAFE
   - score ≥ 75 and rating=RISKY → override to OKAY
        │
        ▼
9. CACHE WRITE (L1 + L2)
        │
        ▼
10. SSE STREAM RESULT to browser
```

---

## 6. Models — Which, Why, and Config

### Current Model: `meta/llama-3.3-70b-instruct` (both tiers)

**Why this model:**

| Criterion | Reason |
|-----------|--------|
| **Instruction following** | Llama-3.3-70b reliably outputs strict JSON with no markdown fences, no extra prose — critical because the server uses a depth-counter JSON extractor and any malformed output breaks the pipeline |
| **Legal reasoning accuracy** | 70B parameters provide sufficient context window and reasoning capacity to identify subtle clause violations, not just keyword matches |
| **NIM availability** | Hosted on NVIDIA's inference infrastructure with high availability and sub-second TTFT (time-to-first-token) |
| **Speed on NIM** | On NVIDIA NIM, 70B produces 120 tokens (quick scan output) in ~1-3s — well within the target window |
| **OpenAI SDK compatibility** | NIM exposes an OpenAI-compatible API, meaning the existing `openai` npm package works without modification |

**Why not a smaller model (8B/12B)?**
Smaller models frequently hallucinate violations, produce invalid JSON, paraphrase rather than quote, and miss subtle clause language. The citation accuracy requirement (verbatim copy-paste) is very difficult for sub-20B models.

**Why not a larger model (405B)?**
Latency. A 405B model on NIM takes 8-20s for 120 tokens — it would fail the Quick scan target of 5-10s. The 70B model hits the same accuracy ceiling for clause detection at a fraction of the latency.

### Model Configuration

```env
NIM_MODEL_QUICK=meta/llama-3.3-70b-instruct
NIM_MODEL_DEEP=meta/llama-3.3-70b-instruct
```

Both are overridable via `.env` without code changes. The eval suite (`eval/runEval.ts`) reads these same variables.

### Tier Parameters

| Parameter | Quick | Deep |
|-----------|-------|------|
| `max_tokens` | 120 | 1400 |
| `temperature` | 0 | 0 |
| Timeout | 20s | 30s (+ 20s for chunked docs) |
| Step interval | 900ms | 1200ms |
| Output | `rating + score + tldr` only | Full pillars + citations + deductions |
| Credits | 10 | 20 |

**Temperature = 0** on both tiers. This is deliberate: deterministic output reduces the chance of the model "getting creative" with citations. Legal analysis requires reproducibility — running the same document twice should return the same verdict.

### Embedding Model: `nvidia/nv-embedqa-e5-v5`

Used for semantic chunk ranking in the two-pass citation extraction (deep tier only). Embeds pillar descriptions and source paragraphs together in a single batch, then ranks by cosine similarity to surface the most relevant passages for each pillar. Falls back to keyword-based ranking if the embedding call fails.

---

## 7. Scanning Criteria — The 6 Privacy Pillars

Each pillar has a precise violation threshold. The model is instructed to apply the **null hypothesis** — default to `violation: false` and only flip to `true` if it can quote exact text.

### Pillar 1: AI Training (`ai_training`)

**What it detects:** Any clause where the service uses your content or personal data to train, fine-tune, or improve AI/ML models — unless a clear, accessible opt-out is present.

**Violation examples:**
- `"for use with and training of our machine learning and artificial intelligence models, whether generative or another type"`
- `"to train our AI"`, `"improve our AI systems using your data"`
- Broad license clauses that include AI training bundled inside other permissions

**Why it matters:** Users are unknowingly contributing to commercial AI training datasets without consent or compensation.

---

### Pillar 2: Data Selling / Third-Party Monetization (`data_selling`)

**What it detects:** Content or personal data shared with advertisers, data brokers, or third-party partners beyond what is strictly necessary to operate the service.

**Violation examples:**
- `"we and our third-party providers and partners may place advertising... in connection with the display of Content"`
- Content syndicated to `"other companies, organizations or individuals"`
- Data shared with `"advertising partners"` for targeting

**Why it matters:** The user's data becomes a product — sold or exchanged for revenue without meaningful consent.

---

### Pillar 3: Transparency (`transparency`)

**What it detects:** Language that is deliberately vague, contradictory, or structured to obscure data practices rather than explain them.

**Violation examples:**
- Key rights buried in dense legalese with no plain-language summary
- Critical data practices only referenced by external links with no content
- Contradictory clauses (grants a right in one sentence, disclaims it in another)

**NOT a violation:** Clear, concise, well-structured policies even if they contain unfavorable terms. Transparency is about clarity of expression, not favorability.

---

### Pillar 4: Data Retention (`data_retention`)

**What it detects:** No stated deletion timeline, or data retained longer than 1 year after account deletion.

**Violation threshold:**
- ≤ 90 days post-deletion → acceptable, no violation
- > 1 year post-deletion → violation
- Completely unspecified with no reference to an external policy → borderline violation
- Delegated entirely to another document without specifics → borderline

**Why it matters:** Users who delete their accounts should not have data retained indefinitely. Lack of any timeline is a red flag.

---

### Pillar 5: Content Ownership (`content_ownership`)

**What it detects:** IP rights granted to the platform that go beyond what is necessary to display your content to you within the service.

**Violation examples:**
- `"worldwide, non-exclusive, royalty-free license (with the right to sublicense) to use, copy, reproduce... for any purpose"`
- Right to modify, adapt, redistribute, or commercially reuse user content
- No compensation for commercial reuse

**NOT a violation:** `"license to display content to users of the service"` — this is a minimal, necessary grant.

---

### Pillar 6: Dark Patterns (`dark_patterns`) *(optional — toggled by user)*

**What it detects:** Clauses that are legally unfair or manipulative regardless of how they are framed.

**Violation examples:**
- Liability cap at trivially small amounts (e.g. `"shall not exceed ONE HUNDRED U.S. DOLLARS ($100.00)"`)
- Class action waivers: `"you waive the right to participate as a plaintiff or class member in any purported class action"`
- Shortened statute of limitations (under 2 years from the event)
- One-sided termination without notice
- Hidden forced arbitration clauses

---

### Confidence Levels

Each pillar verdict includes a confidence rating:

| Confidence | Meaning |
|------------|---------|
| `HIGH` | Explicit, unambiguous clause found. Citation is a direct verbatim quote. |
| `MEDIUM` | Clause exists but requires interpretation, or language is partially ambiguous. |
| `LOW` | Inferred from indirect language, or relevant text is delegated to an external doc. |

---

## 8. Scoring System

### Score Bands

| Violations | Score Range | Rating |
|------------|-------------|--------|
| 0, clear language | 90–100 | **SAFE** |
| 0, minor vagueness | 75–89 | **OKAY** |
| 1 low-severity | 50–74 | **OKAY** |
| 1 high-severity or 2 | 25–49 | **RISKY** |
| 3–4 | 10–24 | **RISKY** |
| 5–6 | 0–9 | **RISKY** |

### Mandatory Score ↔ Rating Rules (server-enforced)

The LLM proposes a score; the server then enforces consistency regardless of what the model said:

1. `score < 50` → `rating` is forced to `RISKY`
2. `score 50–74` → `rating` cannot be `SAFE` (overridden to `OKAY`)
3. `score ≥ 75` and `rating == RISKY` → overridden to `OKAY`

Additionally, the server counts actual `violation: true` pillars and **overrides the score** into the correct band if the model's score doesn't match the violation count. This prevents a scenario where the model says `score: 80` but has flagged 3 violations.

### Why the Override?

LLMs are probabilistic. Even at temperature=0, a model can produce a score of `80` while simultaneously flagging 4 violations. The server-side override is the single source of truth — it uses the pillar verdicts (which are backed by verbatim citations) as inputs, not the model's self-reported score.

---

## 9. Chunking — How Large Documents Are Handled

### Why Chunking Is Necessary

A typical Terms of Service is 3,000–15,000 words. Some (GDPR-heavy policies, enterprise SaaS) exceed 30,000 words. The NIM model has a 128k token context window, but sending 80k chars in one call:
- Is wasteful (most of a T&C document is boilerplate irrelevant to the 6 pillars)
- Causes the model to lose focus on the key clauses buried in the middle
- Increases per-call cost and latency

### How Chunking Works

```
Threshold: 12,000 chars → single call (no chunking)
Chunk size: 10,000 chars
Overlap:    2,500 chars
Max chunks: 8 (≤ 80,000 chars total)
Concurrency: 2 parallel LLM calls
```

**Sentence-aware splitting** (via `compromise` NLP library):
1. Split the document into individual sentences
2. Fill a chunk with sentences until it would exceed 10,000 chars
3. When a chunk fills: save it, then seed the next chunk with the trailing sentences that total ~2,500 chars (the overlap)
4. This ensures no clause is split mid-sentence at a chunk boundary

**Why sentence-aware overlap?** Before this approach, naive character-based splitting cut sentences in half. The LLM would receive a clause starting mid-sentence, miss the subject, and either skip it or paraphrase incorrectly. The 2,500-char sentence-level overlap is the single biggest fix for citation accuracy.

### Aggregation After Chunking

After all chunks are analyzed in parallel:
- **Score**: worst (lowest) score across all chunks wins
- **Rating**: worst rating wins (RISKY > OKAY > SAFE)
- **TL;DR**: taken from the chunk with the worst score
- **Pillars**: if ANY chunk flags `violation: true` for a pillar → overall violation is true. The citation comes from the chunk that found the evidence.

---

## 10. Citation Grounding — Verbatim Evidence

This is the most technically sophisticated part of the pipeline. The core problem: **LLMs paraphrase**. When asked for a verbatim quote, they often produce a plausible-sounding summary instead. A paraphrased citation is useless for two reasons:
1. It can't be highlighted in the page (mark.js needs exact text)
2. It could be hallucinated — there is no way to verify it

### Pass 1: `findVerbatimInChunk()`

Runs on every violation pillar after the initial LLM call:

1. Extract **key terms** from the LLM's citation (4+ chars, non-stopwords, max 6 terms)
2. Scan the original chunk for positions where 2+ key terms appear within a **±150 char window**
3. **Expand** the best-matching position to sentence/clause boundaries: `rawStart = pos - 100`, `rawEnd = pos + 300`
4. Trim leading text to the first capital letter or post-punctuation start
5. Cap at 60 words
6. Return the passage if it is ≥ 30 chars

This works because even a paraphrased citation retains the key terms from the original clause. The co-location requirement (2+ terms within 150 chars) prevents false matches.

### Pass 2: `extractVerbatimForPillar()` (deep tier, only if Pass 1 fails)

An entire second LLM call targeted at a single pillar:

1. **Embed** the pillar description (e.g. `"AI or machine learning training using user content"`) using `nvidia/nv-embedqa-e5-v5`
2. **Embed all paragraphs** of the source document in the same batch
3. **Rank paragraphs** by cosine similarity to the pillar description
4. **Call the LLM** on only the top-3 most relevant paragraphs with the instruction: `"copy-paste the exact clause"`
5. **Verify** the returned citation's first 50 chars appear in the source text
6. If verification fails → demote pillar to CLEAR (`violation: false`)

### Citation Demotion Cascade

A violation pillar is demoted to CLEAR if:
- No citation was returned
- Citation is exactly `"Not addressed in document."`
- Citation matches a paraphrase pattern: `"The policy states..."`, `"The terms..."`, `"This document..."`, etc.
- Citation's first 50 chars do not appear in the source text (hallucination check)

**Philosophy**: A violation we can't point to is worse than no violation. An unverified claim erodes trust more than a missed flag. The pipeline prefers false negatives over false positives.

---

## 11. Caching Architecture

### Two Layers

```
Request arrives
      │
      ▼
L1: In-memory LRU (500 entries max, per-instance, resets on restart)
      │ miss
      ▼
L2: Firestore shared_cache (persistent, cross-user, cross-instance)
      │ miss
      ▼
NIM inference → result
      │
      ├─▶ Write to L1 (synchronous, sub-ms)
      └─▶ Write to L2 Firestore (async, fire-and-forget)
```

### Cache Key

```
SHA-256( processedText + tier_suffix + eli5_suffix + darkpatterns_suffix + model_id )
```

The model ID is included in the hash so that a model upgrade automatically invalidates the cache. ELI5 and dark patterns are included because they change the output format.

### TTL

| Tier | L2 TTL |
|------|--------|
| Quick | 48 hours |
| Deep | 7 days |

Firestore has a TTL policy on the `expiresAt` field that asynchronously deletes expired documents. The server also performs a manual expiry check on read (`expiresAt.toMillis() < Date.now()`) so a document is never served after its TTL even if Firestore's cleanup hasn't run yet.

### Anonymous Cache

The shared cache (`/shared_cache`) stores results **without any user identifier**. When User A scans Spotify's Privacy Policy, the result is cached anonymously. When User B visits the same page, they get the cached result instantly — without User A's identity being attached. Deleting your scan history does not affect the shared cache.

### L1 LRU Eviction

The in-memory LRU is implemented with a plain `Map` (insertion-order iteration). When the map reaches 500 entries, the oldest key (first in insertion order) is deleted before adding the new one. No external library required.

---

## 12. Firebase & Firestore — Why and How

### Why Firebase?

1. **Zero-config auth**: Firebase Authentication provides Google sign-in with ID tokens that are verifiable server-side using the Admin SDK — no session management, no cookie infrastructure needed
2. **Serverless transactions**: Firestore transactions handle the credit deduction atomically. There is no race condition where two simultaneous scans can both pass the credit check and double-spend
3. **Real-time history**: The React web app uses Firestore `onSnapshot` to stream scan history updates live — no polling needed
4. **Cloud Run compatibility**: Application Default Credentials mean no service account key is needed in production — Cloud Run's service account is used automatically

### Collections

#### `/users/{uid}`
```json
{
  "uid": "firebase-uid",
  "credits": 380,
  "lastResetMonth": "2026-03",
  "role": "user"
}
```
Created automatically on first scan. `lastResetMonth` is checked on every scan — if it doesn't match the current month (format `"YYYY-MM"`), credits are reset to 400 before the deduction is applied.

#### `/scans/{scanId}`
```json
{
  "uid": "firebase-uid",
  "url": "https://example.com/privacy",
  "rating": "RISKY",
  "score": 22,
  "tldr": "This policy allows AI training on your content...",
  "tier": "deep",
  "createdAt": "Timestamp",
  "pillars": {
    "ai_training":       { "violation": true,  "citation": "for use with and training of our machine learning...", "confidence": "HIGH" },
    "data_selling":      { "violation": true,  "citation": "we and our third-party advertising partners...", "confidence": "HIGH" },
    "transparency":      { "violation": false, "citation": "Our Privacy Policy describes how we handle...", "confidence": "LOW" },
    "data_retention":    { "violation": false, "citation": "Not addressed in document.", "confidence": "LOW" },
    "content_ownership": { "violation": true,  "citation": "worldwide, royalty-free license... for any purpose", "confidence": "HIGH" },
    "dark_patterns":     { "violation": false, "citation": "Not addressed in document.", "confidence": "LOW" }
  }
}
```
Written by the backend after every fresh scan (not from cache). Displayed in the React web app dashboard.

#### `/shared_cache/{hash}`
```json
{
  "result": { "rating": "RISKY", "score": 22, "tldr": "...", "pillars": {} },
  "tier": "deep",
  "scannedAt": "Timestamp",
  "expiresAt": "Timestamp",
  "scanCount": 47
}
```
Anonymous — no UID. `scanCount` uses `FieldValue.increment(1)` so concurrent cache hits are counted accurately.

#### `/reports/{id}`
```json
{
  "url": "https://example.com/privacy",
  "rating": "RISKY",
  "score": 22,
  "pillars": {},
  "requestId": "uuid",
  "userAgent": "Mozilla/5.0...",
  "createdAt": "2026-03-31T..."
}
```
Written when a user submits a "this result is wrong" report. Used for manual model quality review.

### Fail-Open Design

If Firestore is unavailable (credentials missing, network error, cold-start failure):
- Scans still proceed — LLM pipeline runs without credit tracking
- `creditsLeft: -1` is returned (client treats this as "unknown")
- The server logs a warning but does not fail the request

This means a temporary Firestore outage never blocks users from scanning.

---

## 13. Credit System

### Allocation

| Tier | Cost | Free monthly allowance |
|------|------|----------------------|
| Quick scan | 10 credits | 400 credits |
| Deep scan | 20 credits | 400 credits |

400 credits = 40 Quick scans or 20 Deep scans per month, or any combination.

### Monthly Reset

The reset is not a scheduled job — it happens lazily on the next scan after the month changes. During the credit check transaction:
1. Read the user's `lastResetMonth`
2. If it doesn't match the current month (`YYYY-MM`) → reset `credits` to 400 and update `lastResetMonth`
3. Then proceed with the deduction

This avoids the need for a cron job or scheduled function and ensures the reset is atomic.

### Credit Deduction Transaction

Uses a Firestore transaction to ensure atomicity:
```
BEGIN TRANSACTION
  READ  /users/{uid}
  CHECK credits >= cost
  IF YES: WRITE credits - cost, lastResetMonth
  IF NO:  ABORT (return 402)
COMMIT
```

A 402 response includes the reset date (`"April 1"`) and the remaining credits so the client can show an informative error.

---

## 14. NIM API Key Rotation & Failover

Three API keys (`NIM_API_KEY_1/2/3`) are maintained for two reasons:
1. NVIDIA NIM enforces per-key rate limits — distributing load across 3 keys effectively triples the throughput
2. If one key returns a 5xx or 429, the next key is tried immediately

### Retry Logic (`nimCreateWithRetry`)

```
For each key (attempt 1, 2, 3):
  Start per-key timeout (8s)
  Call NIM
  If success → return result
  If 5xx or 429 → try next key
  If 4xx (except 429) → throw immediately (client error, retrying won't help)
  If global abort signal fired → throw immediately
```

The 8-second per-key timeout is deliberately short. If a NIM endpoint is degraded and responding slowly, it's better to move to the next key fast than to wait 20s on a single key and burn the global timeout.

### Key Index

Keys are used in round-robin order (`nimKeyIndex % NIM_KEYS.length`), incrementing on every call. This distributes embedding calls and LLM calls across keys even within a single analysis.

---

## 15. Service Worker Keepalive

**The problem**: Manifest V3 service workers are terminated by Chrome after approximately 30 seconds of inactivity. Deep scans of large documents take 25–40 seconds. Without intervention, Chrome kills the service worker mid-stream, the SSE reader is abandoned, and the user sees a timeout.

**The solution** (two complementary mechanisms):

### Mechanism 1: Port-based keepalive
Before `content.js` sends `ANALYZE_TEXT`, it opens a named port:
```js
const keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
```
Chrome does not terminate service workers that have open ports. The port is automatically disconnected when `content.js` closes or the tab navigates away.

### Mechanism 2: Self-ping interval
Inside `background.js`, once analysis starts:
```js
keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
```
`getPlatformInfo` is a cheap no-op API call that resets Chrome's idle timer. This fires every 20 seconds — well within the ~30s kill window. The interval is always cleared in the `finally` block regardless of success or failure.

Both mechanisms are needed: the port alone is sufficient on most Chrome versions, but the self-ping is a belt-and-suspenders guard against future Chrome changes.

---

## 16. Auth Flow

```
1. User visits the TLDR Shield web app (React) and clicks "Sign in with Google"

2. Firebase Google sign-in popup → Firebase returns an ID token (JWT, 1h expiry)

3. Web app detects successful sign-in (onAuthStateChanged) and posts the token
   to the Chrome extension via window.postMessage

4. Content script receives the message and sends STORE_AUTH to background.js

5. background.js stores { authToken, authUid, authEmail, authTokenExpiry } in
   chrome.storage.local (authTokenExpiry = now + 55 minutes)

6. On every scan, background.js reads the token and checks authTokenExpiry > Date.now()
   If valid: attaches  Authorization: Bearer <token>  to the POST /api/analyze call
   If expired: omits the header → server returns 401 → badge shows "Sign in required"

7. Server calls Firebase Admin SDK getAuth().verifyIdToken(token) → returns uid
   uid is then used for credit deduction and scan storage

8. User signs out of the web app → CLEAR_AUTH removes all stored credentials
```

**Why store in `chrome.storage.local`?** Service workers don't have access to `localStorage` or `sessionStorage`. `chrome.storage.local` persists across SW restarts and is accessible from all extension contexts (background, popup, content).

---

## 17. React Web App

Built with React 19 + Tailwind CSS 4 + Framer Motion, bundled by Vite 6. Served by the Express backend (Vite middleware mode in dev, static files in production).

### Two Views

**Landing page** (`page === 'landing'`):
- Hero section with animated badge mockup
- Feature cards for Quick/Deep scan, ELI5 mode, citation highlighting
- Pricing / credit tier display
- Chrome Web Store install CTA

**History dashboard** (`page === 'history'`):
- Real-time Firestore `onSnapshot` subscription filtered to current user's scans
- `ScoreRing` SVG component with animated stroke-dashoffset
- Per-scan expandable detail: pillars, citations, tier badge, time-ago timestamp
- Individual scan deletion (`deleteDoc`)
- Rating-based color tokens (emerald / amber / rose)

### Firebase Client

`src/firebase.ts` initialises from `firebase-applet-config.json` (checked in — contains only public project config, no secrets). The Firestore database ID is **not** `(default)` — it is read from `firestoreDatabaseId` in the config file. Always use the exported `db` instance, never call `getFirestore()` directly.

---

## 18. Evaluation & Testing

### Eval Suite (`eval/`)

| File | Purpose |
|------|---------|
| `runEval.ts` | Full evaluation runner — sends dataset docs through both tiers, measures accuracy |
| `golden.test.ts` | 5 curated golden test cases with known violation profiles |
| `stress_test.ts` | Load testing — concurrent requests, rate limit behavior |
| `checkNimKeys.ts` | Health-checks all 3 NIM keys, reports which are functional |
| `dataset.jsonl` | JSONL dataset: `{ id, text, expected: { rating, pillars } }` |

### Commands

```bash
npm run eval          # Full suite (quick + deep tiers)
npm run eval:quick    # Quick tier only
npm run eval:deep     # Deep tier only
npm run eval:dark     # Dark patterns detection focus
npm run check:nim     # Validate all NIM API keys
```

### Accuracy Measurement

For each document × tier combination, the eval runner:
1. Sends the text to the live NIM API using the same prompt as the server
2. Compares predicted `violation` booleans for all 6 pillars against expected values
3. Reports per-pillar accuracy, overall pillar accuracy %, and rating accuracy %
4. Computes latency percentiles (p50, p95)

A golden test case passes if:
- All expected `violation: true` pillars are flagged
- No expected `violation: false` pillar is falsely flagged
- The citation for each violation is a substring found in the source text
- The score falls within the expected band (e.g., `[40, 74]` for 1-violation docs)

---

## 19. API Endpoints

### `POST /api/analyze`

**Request body:**
```json
{
  "text": "full document text (up to 80,000 chars)",
  "tier": "quick" | "deep",
  "eli5": true | false,
  "darkPatterns": true | false
}
```

**Headers required:** `Authorization: Bearer <Firebase ID token>`

**Response:** Server-Sent Events (SSE) stream. Each event is `data: <JSON>\n\n`.

Progress events (during analysis):
```json
{ "status": "Reading legal document..." }
{ "status": "Analyzing 3 blocks..." }
```

Final result event:
```json
{
  "rating": "RISKY",
  "score": 22,
  "tldr": "This policy...",
  "pillars": { ... },
  "deductions": [...],
  "status": "Complete",
  "cached": false,
  "truncated": false,
  "chunked": true,
  "chunkCount": 3,
  "latencyMs": 8450,
  "model": "meta/llama-3.3-70b-instruct",
  "requestId": "uuid",
  "creditsLeft": 360
}
```

**Error responses:**
- `400` — missing text, too short, invalid tier
- `401` — missing or expired Firebase token
- `402` — insufficient credits (includes `creditsLeft` and `resetDate`)
- SSE error event — analysis failure (model error, timeout, etc.)

### `GET /api/credits`

**Headers required:** `Authorization: Bearer <Firebase ID token>`

**Response:**
```json
{ "credits": 380, "requestId": "uuid" }
```

---

## 20. Environment Variables

```env
# NVIDIA NIM keys (at least 1 required; 2-3 recommended for failover + throughput)
NIM_API_KEY_1=nvapi-...
NIM_API_KEY_2=nvapi-...
NIM_API_KEY_3=nvapi-...

# Model overrides (both tiers default to llama-3.3-70b-instruct)
NIM_MODEL_QUICK=meta/llama-3.3-70b-instruct
NIM_MODEL_DEEP=meta/llama-3.3-70b-instruct

# Firebase service account (local dev only — Cloud Run uses ADC automatically)
FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json

# Deployment URL (used for CORS in production)
APP_URL=https://your-cloud-run-url.run.app

# Optional: require X-API-Key header in production
INTERNAL_API_KEY=your-secret-key

# Set automatically by Cloud Run
PORT=8080
```

---

## 21. Deployment

**Backend**: Google Cloud Run (serverless, auto-scales to zero). Deployment is a Docker container built from the project root. Cloud Run injects `$PORT` and provides Application Default Credentials for Firebase Admin SDK — no service account file needed in production.

**Frontend**: Served as static files by the Express backend from `dist/` (built by `npm run build`). No separate CDN or hosting needed.

**Extension**: Loaded unpacked during development. For distribution, submitted to the Chrome Web Store as a `.zip` of the `extension/` directory.

**Backend URL in extension**: Hardcoded default in `background.js` and `popup.js` as a constant (`DEFAULT_API_URL`). Users can override this in the popup settings for self-hosted deployments.
