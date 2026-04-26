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
14. [Gemini Key Pool Architecture](#14-gemini-key-pool-architecture)
15. [Service Worker Keepalive](#15-service-worker-keepalive)
16. [Auth Flow](#16-auth-flow)
17. [React Web App](#17-react-web-app)
18. [API Endpoints](#18-api-endpoints)
19. [Roadmap](#19-roadmap)

---

## 1. What It Does

TLDR Shield is a Chrome Extension that automatically detects when you visit a Terms of Service or Privacy Policy page and, on demand, runs it through an AI-powered privacy analysis pipeline. It tells you — in plain English — whether the document is **SAFE**, **OKAY**, or **RISKY**, backed by verbatim evidence pulled directly from the text.

**Key outputs:**
- A **rating badge** (SAFE / OKAY / RISKY) injected directly into the page
- A **privacy score** (0–100)
- A **plain-English TL;DR** summary
- **6 pillar breakdowns** with verbatim citations found in the document

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
                    │          Express Backend  (Cloud Run / :8080)           │
                    │                                                          │
                    │  POST /api/analyze                                       │
                    │  ┌──────────────────────────────────────────────────┐   │
                    │  │ 1. Firebase Auth token verify                    │   │
                    │  │ 2. Credit check & deduction (Firestore tx)       │   │
                    │  │ 3. L1 in-memory Redis cache lookup               │   │
                    │  │ 4. L2 Firestore shared_cache lookup              │   │
                    │  │ 5. Sentence-aware chunking (compromise NLP)      │   │
                    │  │ 6. Parallel Gemini calls (Scan Pool Keys 1-3)    │   │
                    │  │ 7. Verbatim citation grounding (regex expansion)  │   │
                    │  │ 8. Pillar consistency check + confidence update  │   │
                    │  │ 9. Write to L1 + L2 cache                       │   │
                    │  │ 10. SSE stream final result back                 │   │
                    │  └──────────────────────────────────────────────────┘   │
                    │                          │                               │
                    └──────────────────────────┼───────────────────────────────┘
                                               │
                    ┌──────────────────────────▼───────────────────────────────┐
                    │          Google Gemini API (AI Studio)                   │
                    │   Pool A (Scan):   gemini-2.5-flash                      │
                    │   Pool B (Util):   gemini-2.5-flash-lite                 │
                    └──────────────────────────────────────────────────────────┘
```

---

## 4. Express Backend

Entry point: `server.ts`. Deployed on **Google Cloud Run**.

### Request Pipeline
1. **Auth:** Token verified via `authMiddleware`.
2. **Credits:** Deducted atomically via `creditService.ts`.
3. **Cache:** Checks Upstash Redis (L1) and Firestore (L2).
4. **LLM:** Parallel calls to Gemini using the **Scan Key Pool**.
5. **Post-Process:** `findVerbatimInChunk` converts LLM paraphrases into exact document quotes.
6. **Persistence:** Saves scan record and updates shared cache.

---

## 5. LLM Pipeline — Step by Step

1. **Truncation:** Limit text to 80k chars (safety buffer).
2. **Chunking:** 12,000 char blocks with 2,000 char overlap.
3. **The Judge Ensemble:** For Deep Scans, each chunk is analyzed by **two models in parallel** (e.g. 1.5 Pro + 1.5 Flash).
4. **Union Merge:** The system performs a conservative 'Union Merge'—if *either* model flags a violation, it is kept. This maximizes recall for legal compliance.
5. **Verbatim Grounding:** `findVerbatimInChunk()` performs a fuzzy keyword co-location search to align LLM citations with the exact source text.
6. **Sanitization:** Strips common LLM prefixes and ensures strict JSON compliance.

---

## 6. Models — Which, Why, and Config

### Primary Model: `gemini-2.5-flash`
*   **Why:** Huge context window, low latency, and excellent instruction following for JSON output.
*   **Role:** Used for all standard Quick and Deep scans.

### Pro Model: `gemini-2.5-pro`
*   **Role:** Used only when `GEMINI_PRO_MODE` is enabled for maximum legal reasoning depth.

### Utility Model: `gemini-2.5-flash-lite`
*   **Role:** Handles background tasks, health checks, and minor utility calls to preserve Scan Pool quota.

---

## 14. Gemini Key Pool Architecture

To bypass the Requests Per Minute (RPM) limits of the free tier, the system uses a **6-key distributed pool**:

### Scan Pool (Keys 1-3)
*   Reserved exclusively for user-initiated scans.
*   Rotates automatically on failure (e.g., if Key 1 hits a 429, the system tries Key 2).

### Utility Pool (Keys 4-6)
*   Reserved for background rechecks, citation grounding, and evaluations.
*   Ensures that high-volume background work never "starves" a real user of quota.

---

## 19. Roadmap

- **WASM Local Inference:** Analyze short policies locally in-browser to save API cost.
- **Policy Watcher:** Alert users when a site they use silently updates its terms.
- **GDPR Article 17 Generator:** Convert a "Data Selling" violation into a formal legal erasure request email in one click.
- **Firefox Parity:** Porting the manifest to Firefox standards.
