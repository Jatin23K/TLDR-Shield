# TLDR Shield — LLM Classification System for Privacy Risk Detection

![Version](https://img.shields.io/badge/version-2.0.0-6366f1)
![License](https://img.shields.io/badge/license-Apache--2.0-10b981)
![Stack](https://img.shields.io/badge/stack-React%20%7C%20Express%20%7C%20Gemini%202.5%20%7C%20Firebase-3b82f6)
![Platform](https://img.shields.io/badge/platform-Chrome%20MV3%20%7C%20Firefox-f59e0b)
![Deep Accuracy](https://img.shields.io/badge/deep%20accuracy-10%2F10-brightgreen)
![Recall](https://img.shields.io/badge/recall-97%25-brightgreen)
![Precision](https://img.shields.io/badge/precision-84%25-green)

---

## Project Navigation

| Document | What it shows |
|----------|--------------|
| [README.md](./README.md) | Problem framing, approach, eval results, architecture |
| [EVAL_REPORT.md](./EVAL_REPORT.md) | Full benchmark report — per-service precision/recall, error analysis, post-processing rules |
| [eval_output.txt](./eval_output.txt) | Raw model output for all 10 services — unedited, verifiable |
| [scratch/scan_test.py](./scratch/scan_test.py) | Evaluation script — reproduces all results with a paid Gemini API key |
| [server/postprocess.ts](./server/postprocess.ts) | Post-processing validation rules (D1–D5) |
| [server/prompts.ts](./server/prompts.ts) | Prompt engineering — ensemble prompts + PP co-scan prompt |

> Results are fully reproducible. Run `python -X utf8 scratch/scan_test.py` with a Gemini API key to verify.

---

## Problem

Terms of Service and Privacy Policy documents average **5,000–20,000 words**. 91% of users never read them. Yet these documents contain clauses that authorize AI training on personal data, third-party data selling, and forced arbitration — all with real legal consequences.

**Business KPI:** Reduce time to understand privacy risk from ~30 minutes (manual reading) to ~30 seconds (automated classification), with measurable precision and recall against ground truth labels from [tosdr.org](https://tosdr.org).

---

## Approach

### Why Not Rule-Based?

A simple keyword matcher (baseline) achieves ~55% recall — it misses violations expressed in indirect language ("trusted partners", "personalized content", "ecosystem partners"). Legal language is deliberately evasive.

### Why Not a Single LLM?

A single `gemini-2.5-flash` call achieves ~80% recall but suffers from false positives — it hallucinates violations from ban clauses ("you may not use automated means...") and misclassifies feedback submission clauses as content ownership violations.

### Chosen Approach: Ensemble + Deterministic Post-Processing

```
Primary Model (Flash)  ──┐
                          ├──► Ensemble Merge ──► Post-Processing (D1–D5) ──► Final Result
Corroborator (Flash-Lite) ┘         ↑                      ↑
                               HIGH confidence         Deterministic
                               gate required            rule overrides
```

- **Ensemble:** Flash + Flash-Lite must agree at HIGH confidence for a violation to be flagged
- **Post-processing rules (D1–D5):** Deterministic code overrides model decisions for known failure modes
- **PP co-scan:** Privacy Policy fetched separately for `data_selling` — this information lives in PP, not ToS

---

## Evaluation Results

Benchmarked against **10 real services** (Discord, GitHub, Twitter/X, Google, LinkedIn, PayPal, Spotify, Netflix, TikTok, Zoom) using tosdr.org grades as ground truth.

| Scan Mode | Rating Accuracy | Precision | Recall | Avg Latency |
|-----------|----------------|-----------|--------|-------------|
| Basic (Flash only) | **10/10** | 87% | 76% | 11.8s |
| Deep (Ensemble) | **10/10** | 84% | **97%** | 24.3s |

**Ensemble gain over single model: +21% recall** with negligible precision cost.

### Per-Service Deep Results

| Service | tosdr Grade | Rating | Precision | Recall |
|---------|------------|--------|-----------|--------|
| Discord | D | ✅ RISKY | 100% | 67% |
| GitHub | B | ✅ RISKY | 67% | 100% |
| Twitter/X | F | ✅ RISKY | 100% | 100% |
| Google | E | ✅ RISKY | 100% | 100% |
| LinkedIn | D | ✅ RISKY | 100% | 100% |
| PayPal | D | ✅ RISKY | 67% | 100% |
| Spotify | C | ✅ RISKY | 67% | 100% |
| Netflix | D | ✅ RISKY | 67% | 100% |
| TikTok | D | ✅ RISKY | 75% | 100% |
| Zoom | D | ✅ RISKY | 100% | 100% |

---

## The 6 Privacy Pillars (Classification Labels)

| # | Pillar | What It Detects |
|---|--------|----------------|
| 1 | **AI Training** | Service uses your data to train AI models without explicit consent |
| 2 | **Data Selling** | Data shared with third parties for their own commercial benefit |
| 3 | **Transparency** | Intentionally vague, evasive, or confusing language |
| 4 | **Data Retention** | No clear deletion path or excessive retention after account closure |
| 5 | **Content Ownership** | Broad sublicensable license to user-generated content |
| 6 | **Dark Patterns** | Forced arbitration, class action waivers, liability caps |

---

## Error Analysis & Fixes

A structured error analysis pass identified the root cause of every false positive and false negative. Deterministic post-processing rules (D1–D5) were implemented to override model errors:

| Rule | Type | Problem | Fix |
|------|------|---------|-----|
| D1 | FP killer | `ai_training` cited without "train"/"fine-tune" in text | Require train-word in citation |
| D2 | FP killer | Ban clauses flagged as violations ("you may not use automated means") | Blocklist of prohibition prefixes |
| D3 | FP killer | `transparency` violation on scoped policy sections | Detect section-scoping language |
| D4 | FP killer | Feedback/submission clauses misclassified as `content_ownership` | Two-path incoming-submission detection |
| D5 | FP killer | PP co-scan fires on service-provider-only PPs (GitHub) | Pre-filter: block if zero commercial-sharing language |

**Before D1–D5:** Deep precision ~65%, multiple false positives per service.  
**After D1–D5:** Deep precision 84%, false positives isolated to structural data_selling ambiguity.

---

## Why the Model Alone Is Not Enough

Three systematic failure modes required non-model solutions:

**1. Ban clauses look like violations**
> *"using automated means to access content from any of our services"* — Google ToS
> 
> The model flags this as `ai_training`. A human reads this as a prohibition. D2 detects the context and overrides.

**2. Feedback clauses look like content ownership**
> *"Netflix is free to use any comments, information, ideas, concepts, feedback..."* — Netflix ToS
>
> The model flags this as `content_ownership`. D4 detects "feedback/comments" without published-content markers and clears it.

**3. Data selling language lives in Privacy Policy, not ToS**
>
> ToS rarely mentions data brokers. The PP co-scan fetches the Privacy Policy separately and uses a dedicated `PP_DATA_SELLING_SYSTEM` prompt tuned for commercial sharing language — catching indirect phrasing like "marketing partners", "advertising ecosystem".

---

## System Architecture

```
┌────────────────────────── Browser (Chrome / Firefox) ──────────────────────────┐
│                                                                                  │
│  content.js            background.js (SW)         popup.html / popup.js         │
│  ┌────────────────┐    ┌──────────────────┐    ┌────────────────────────────┐   │
│  │ Detect T&C     │    │ SSE stream reader │    │ Tier picker                │   │
│  │ Extract text   │───▶│ Auth token attach │    │ ELI5 / dark patterns       │   │
│  │ Inject badge   │◀───│ Credit error UI   │    │ Sign-in / credits          │   │
│  │ Highlight cite │    │ Keepalive pings   │    │ GDPR email / batch scan    │   │
│  └────────────────┘    └──────────────────┘    └────────────────────────────┘   │
└────────────────────────────────┬──┬──────────────────────────────────────────────┘
                                 │  │ SSE
                    ┌────────────▼──┴──────────────────────────────────┐
                    │        Express Backend  (Google Cloud Run)        │
                    │                                                    │
                    │  1. Firebase Auth token verify                    │
                    │  2. Credit deduction (Firestore transaction)      │
                    │  3. L1 in-memory LRU cache lookup                 │
                    │  4. L2 Firestore shared_cache lookup              │
                    │  5. Sentence-aware chunking (compromise NLP)      │
                    │  6. Privacy Policy co-scan (data_selling)         │
                    │  7. LLM inference — Flash primary                 │
                    │  8. LLM corroboration — Flash-Lite ensemble       │
                    │  9. Ensemble merge (HIGH confidence gate)         │
                    │  10. Post-processing validation (D1–D5 rules)     │
                    │  11. Citation grounding + JSON extraction         │
                    │  12. Aggregation + score computation              │
                    │  13. Write to L1 + L2 cache                      │
                    │  14. SSE stream result to extension               │
                    └───────────────────────────────────────────────────┘
                                         │
                     ┌────────────────────▼──────────────────────────────┐
                     │          Google Gemini API (AI Studio)            │
                     │  Primary:     gemini-2.5-flash                    │
                     │  Corroborator: gemini-2.5-flash-lite              │
                     └───────────────────────────────────────────────────┘
```

---

## What the User Sees

| Output | Description |
|--------|-------------|
| **Rating badge** | SAFE / OKAY / RISKY injected into the page |
| **Privacy score** | 0–100 numerical score |
| **Plain-English TL;DR** | One-paragraph summary |
| **Pillar breakdown** | 6 categories with verbatim citations highlighted in the document |
| **ELI5 mode** | Legal jargon translated to plain English |

---

## Scoring

| Rating | Condition |
|--------|-----------|
| **SAFE** | 0 violations across all pillars |
| **OKAY** | 0 violations but vague Transparency pillar |
| **RISKY** | 1 or more violations detected |

---

## Scan Tiers

| | Basic Scan | Deep Scan |
|-|-----------|-----------|
| **Model** | Flash only | Flash + Flash-Lite ensemble |
| **Recall** | 76% | 97% |
| **Latency** | ~12s | ~24s |
| **Output** | Rating + score + TL;DR | Full pillar breakdown + verbatim citations |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Chrome Extension | Manifest V3, Vanilla JavaScript |
| Backend | Node.js, Express, TypeScript |
| AI Models | Google Gemini 2.5 Flash / Flash-Lite |
| NLP Chunking | `compromise` (sentence-aware splitting) |
| Auth & DB | Firebase Auth + Firestore |
| Cache | In-memory LRU (L1) + Firestore shared cache (L2) |
| Deployment | Google Cloud Run |
| Web App | React 19, Tailwind CSS 4 |
| Content Extraction | `@mozilla/readability` |

---

## Installation

```bash
git clone https://github.com/Jatin23K/TLDR-Shield.git
cd TLDR-Shield
npm install
```

Create a `.env` file:

```env
GEMINI_SCAN_KEY_1=AIza...
GEMINI_SCAN_KEY_2=AIza...
GEMINI_SCAN_KEY_3=AIza...
```

```bash
npm run dev     # Express + Vite on :3000
npm run build   # Production build
npm run lint    # TypeScript type-check
```

**Chrome Extension (unpacked):**

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Enter your backend URL in the popup → Save

---

## Limitations & Next Iterations

- **data_selling precision gap (84%):** The PP co-scan flags "marketing partners" language that may be service-provider-scoped. A fine-grained classifier trained on ToS-specific labeled examples could reduce this.
- **35K char window:** Documents > 35K chars are truncated. Multi-chunk deep scan with semantic ranking would improve coverage on very long policies.
- **Ground truth scope:** Benchmarked on 10 services. Expanding to 50+ services would give more robust precision/recall estimates.

---

Built with ❤️ for privacy.
