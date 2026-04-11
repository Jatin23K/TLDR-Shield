# TLDR Shield — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build TLDR Shield into a polished, production-grade privacy analysis tool — Chrome extension + React dashboard + Express backend — that reliably scans Terms of Service and Privacy Policies, scores them across 6 privacy pillars, and gives users actionable results with full scan history, credit management, and advanced privacy tools.

**Architecture:** Three-layer system — Chrome MV3 Extension (vanilla JS) detects legal pages and streams results from the Express backend (Node.js + TypeScript on Google Cloud Run), which calls NVIDIA NIM LLMs, caches results in Firestore, and manages user credits via Firebase Auth. The React 19 dashboard (served by the same Express server) shows scan history and serves as the public landing page.

**Tech Stack:** Node.js + Express + TypeScript (backend), React 19 + Tailwind CSS 4 + Framer Motion (frontend), NVIDIA NIM `meta/llama-3.3-70b-instruct` + `nvidia/nv-embedqa-e5-v5` (AI), Firebase Auth + Firestore (auth + DB), Google Cloud Run (hosting), Chrome MV3 Vanilla JS (extension).

**Live URL:** `https://tldr-shield-14714987621.us-central1.run.app`
**GitHub:** `https://github.com/Jatin23K/TLDR-Shield`
**Firebase Project:** `gen-lang-client-0199678316` (Firestore DB ID: `ai-studio-ab2f680c-4045-42d2-9306-ee0a1281b5ad`)
**Cloud Run Project:** `tldr-493003`

---

## Current State Snapshot

### What Is Working ✅
- Core scan pipeline: Quick (10 credits) + Deep (20 credits) via NIM LLaMA 3.3 70B
- 6 Privacy Pillars: AI Training, Data Selling, Transparency, Data Retention, Content Ownership, Dark Patterns
- L1 in-memory LRU cache (500 entries, per instance)
- L2 Firestore shared cross-user cache (48h quick / 7d deep)
- NIM key rotation + retry/backoff across 3 keys
- Sentence-aware chunking (compromise NLP, 10k chars / 2.5k overlap)
- Embedding-based semantic pillar ranking (nv-embedqa-e5-v5)
- Verbatim citation grounding
- Deterministic fallback when LLM fails
- Firebase Auth (Google sign-in)
- Scan history dashboard with real-time Firestore updates
- PDF extraction via offscreen document (MV3 compliant)
- SSE streaming for real-time progress
- Service worker keepalive (dual mechanism for MV3 30s limit)
- Rate limiting (30 req/15min/IP)
- ELI5 mode
- Dark patterns pillar (optional toggle)
- Code splitting: 4 Vite chunks (main 219KB, firebase 456KB, motion 137KB, vendor 4KB)
- Cloud Run deployment with ADC Firestore access

### Known Gaps ❌
- Eval dataset: only 8 cases (shallow coverage)
- No CI/CD pipeline (manual deploys)
- No scheduled eval runs (accuracy drift undetected)
- No NIM key health monitoring (reactive, not proactive)
- No policy change notifications
- Extension manifest still lists Railway in host_permissions
- Extension version is 1.1 (stale)
- No GDPR one-click email generation
- No privacy benchmarking across sites
- No Firefox support
- No batch scan
- No WASM local inference
- Firestore sharedCache may not be fully connected (cross-project ADC)

---

## Phase Overview

| Phase | Name | Timeline | Goal |
|-------|------|----------|------|
| **0** | Production Hardening | Days 1–2 | Fix all immediate production issues |
| **1** | Testing Infrastructure | Days 3–7 | Reliable eval pipeline, CI/CD |
| **2** | Extension & UX Polish | Week 2 | Polished user-facing product |
| **3** | New Features | Weeks 3–5 | GDPR email, benchmarking, batch scan |
| **4** | Advanced Capabilities | Weeks 6–10 | WASM, Firefox, notifications |

---

## Phase 0 — Production Hardening

**Goal:** Fix all known production issues before building new features. Never build on a shaky foundation.

---

### Task 0.1 — Fix Extension Manifest Host Permissions

**Problem:** `manifest.json` still lists `*://*.railway.app/*` as a host permission. Railway service is deleted. This is dead weight and potentially confusing.

**Files to modify:**
- `extension/manifest.json` — remove Railway host, add Cloud Run host explicitly, bump version to `2.0`

**What to change:**
- Remove: `*://*.railway.app/*`
- Keep: `*://*.run.app/*` and `http://localhost:3000/*`
- Bump `"version"` from `"1.1"` to `"2.0"`
- Update `"description"` to: `"AI-powered privacy analysis for Terms of Service and Privacy Policies. Get SAFE/OKAY/RISKY verdicts with verbatim citations."`

**How to test:**
- Open `chrome://extensions` → reload TLDR Shield
- Verify version shows 2.0 in the extensions list
- Navigate to a ToS page — badge should still appear and scan correctly
- Use the `extension-testing` skill to run automated badge detection

**Commit message:** `fix: update extension manifest — remove Railway, bump to v2.0`

---

### Task 0.2 — Fix Firestore Cross-Project ADC

**Problem:** Firebase project (`gen-lang-client-0199678316`) and Cloud Run project (`tldr-493003`) are different. The Cloud Run default service account (`14714987621-compute@developer.gserviceaccount.com`) is in the `tldr-493003` project but needs access to Firestore in `gen-lang-client-0199678316`.

**What to do:**
- In Firebase Console → Project Settings → Service Accounts → generate a new service account JSON for `gen-lang-client-0199678316`
- Add this JSON as `FIREBASE_SERVICE_ACCOUNT_JSON` env var in Cloud Run:
  ```bash
  gcloud run services update tldr-shield --region us-central1 --update-env-vars "FIREBASE_SERVICE_ACCOUNT_JSON=<paste_json>"
  ```
- **Alternative (cleaner):** Add the Cloud Run SA as a Firestore editor in the Firebase project's IAM:
  Firebase Console → Project Settings → Service Accounts → IAM → add `14714987621-compute@developer.gserviceaccount.com` with role `Cloud Datastore User`

**How to test:**
- After deploy, check `/health` endpoint
- `sharedCache.connected` must be `true`
- Do a deep scan — verify the result saves to Firestore shared cache
- Do the same scan again from a fresh browser — it should return instantly (cache hit, `cached: true`)

**Commit message:** N/A — this is infrastructure config, no code change

---

### Task 0.3 — Set INTERNAL_API_KEY in Production

**Problem:** Server logs `WARNING: INTERNAL_API_KEY is not set in production — all API endpoints are publicly accessible.` This means anyone can use your NIM quota for free.

**What to do:**
- Generate a secure random key (32+ chars alphanumeric)
- Add to Cloud Run: `gcloud run services update tldr-shield --region us-central1 --update-env-vars "INTERNAL_API_KEY=<your_key>"`
- Update `extension/background.js` — add `'X-API-Key': '<your_key>'` header to all fetch calls to the backend
- Update `src/firebase.ts` or wherever the React app calls the backend — add the same header

**How to test:**
- Hit `/api/credits` without the `X-API-Key` header → should return 401
- Hit `/api/credits` with the correct header → should return credit balance
- Run extension on a ToS page → scan should still work

**Commit message:** `security: add INTERNAL_API_KEY header to all backend calls`

---

### Task 0.4 — Regenerate Exposed NIM API Keys

**Problem:** NIM API keys were visible in a terminal screenshot (shared in chat). They must be rotated.

**What to do:**
1. Go to `integrate.api.nvidia.com` → API Keys → regenerate all 3 keys
2. Update Cloud Run: `gcloud run services update tldr-shield --region us-central1 --update-env-vars "NIM_API_KEY_1=new1,NIM_API_KEY_2=new2,NIM_API_KEY_3=new3"`
3. Verify with `/health` → `nimKeys: 3`

**How to test:**
- `/health` must return `nimKeys: 3`
- Run a quick scan — must complete without NIM auth errors

**Commit message:** N/A — keys are env vars, no code change

---

### Task 0.5 — Add Budget Alert in Google Cloud

**What to do:**
- Google Cloud Console → Billing → Budgets & Alerts → Create Budget
- Set monthly budget: ₹500 (or $6 USD)
- Alert thresholds: 50%, 90%, 100%
- Email: your Google account email

**Why:** Protects against runaway costs if the extension gets shared widely or NIM keys are abused.

---

## Phase 1 — Testing Infrastructure

**Goal:** Build a reliable quality gate so that every change to the analysis pipeline is validated before deploy. Currently there are only 8 eval cases — this phase expands coverage and automates it.

---

### Task 1.1 — Expand Eval Dataset to 30+ Cases

**Files to modify:**
- `eval/dataset.jsonl` — add 22+ new test cases

**Current cases (8):** t1_safe_clear, t2_ai_training_no_optout, t3_data_selling_brokers, t4_transparency_deceptive, t5_retention_over_1y, t6_content_ownership_broad, t7_dark_patterns_arbitration, t8_multi_violation

**New cases to add (22):**

Category: AI Training (add 4 more)
- `t9_ai_training_opt_out_present` — Has AI training clause BUT with a clear opt-out → should be SAFE
- `t10_ai_training_bundled_in_license` — AI training buried inside a broad content license clause → RISKY
- `t11_ai_training_third_party_only` — Only third-party ads use AI, not the platform itself → borderline OKAY
- `t12_ai_training_ambiguous` — "improve our services" without explicitly mentioning AI → OKAY (not a violation)

Category: Data Selling (add 3 more)
- `t13_data_selling_opt_out_provided` — Shares with advertisers but provides opt-out mechanism → OKAY
- `t14_data_selling_aggregated_only` — Only aggregated/anonymized data → SAFE
- `t15_data_selling_explicit_broker` — Explicitly sells to data brokers → RISKY

Category: Data Retention (add 3 more)
- `t16_retention_30_days_clear` — Deletes within 30 days — SAFE
- `t17_retention_no_timeline` — Account deleted but "data may be retained for business purposes" with no timeline → RISKY
- `t18_retention_legal_requirement` — Keeps for legal compliance only, max 1 year → OKAY

Category: Content Ownership (add 3 more)
- `t19_content_ownership_display_only` — License only to display your content on the platform → SAFE
- `t20_content_ownership_sub_licensable` — Worldwide, sub-licensable, royalty-free "for any purpose" → RISKY
- `t21_content_ownership_monetization` — Can use your photos in their ads → RISKY

Category: Dark Patterns (add 3 more)
- `t22_dark_patterns_class_action_waiver` — Explicit class action waiver → RISKY
- `t23_dark_patterns_shortened_statute` — "You must file any claim within 1 year" → RISKY
- `t24_dark_patterns_unilateral_change` — Can change terms at any time, your continued use = consent → borderline OKAY

Category: Multi-violation real-world (add 4 more)
- `t25_twitter_tos_snippet` — X/Twitter-like AI training + content license + arbitration → RISKY
- `t26_gdpr_compliant` — Clear GDPR-style policy with all rights documented → SAFE
- `t27_facebook_style` — Data monetization + AI training + broad license → RISKY (score < 20)
- `t28_small_saas_minimal` — Simple SaaS privacy policy, minimal data collection → SAFE

Category: Edge cases (add 2 more)
- `t29_empty_policy` — Empty/blank text → must not crash, must return graceful error
- `t30_non_legal_text` — Random news article → should not falsely detect violations

**Use the `add-eval-case` skill for each new case to ensure correct schema.**

**How to test after adding:**
- Run `npm run eval` — all 30 cases must pass with pillarsPct > 85%
- Run `npm run eval:quick` and `npm run eval:deep` separately
- Commit only after both pass

**Commit message:** `test: expand eval dataset from 8 to 30 cases covering all pillar edge cases`

---

### Task 1.2 — Expand Golden Tests to 10 Cases

**Files to modify:**
- `eval/golden.test.ts` — add 5 more hand-crafted golden tests

**Current golden tests (5):** one per major pillar violation

**New golden tests (5):**
- Golden 6: Multi-pillar (3+ violations) — verify all violations flagged simultaneously
- Golden 7: AI training opt-out present — verify not falsely flagged
- Golden 8: Dark patterns (arbitration clause) — verify verbatim citation contains "arbitration"
- Golden 9: SAFE document — verify score ≥ 90 and all pillars false
- Golden 10: ELI5 mode — run same document in ELI5 mode, verify citations are plain English (not legalese)

**How to test:**
- Run `npx tsx eval/golden.test.ts` — all 10 must pass
- Run with both quick and deep tier
- Commit only after all pass

**Commit message:** `test: expand golden test suite to 10 cases`

---

### Task 1.3 — Set Up GitHub Actions CI/CD Pipeline

**Files to create:**
- `.github/workflows/ci.yml` — runs on every push to `master` and every PR
- `.github/workflows/deploy.yml` — runs on push to `master` only, after CI passes

**CI Pipeline steps (`.github/workflows/ci.yml`):**
1. Checkout code
2. Set up Node.js 22
3. Run `npm ci`
4. Run `npm run lint` (TypeScript type-check)
5. Run `npm run build` (Vite production build)
6. Run `npm run eval:quick` with a subset of eval cases (5 fast cases, no deep tier to save NIM credits)
7. Report pass/fail — block merge on failure

**Deploy Pipeline steps (`.github/workflows/deploy.yml`):**
1. Only runs after CI passes
2. Authenticate with Google Cloud using a service account key (stored as GitHub secret `GCP_SA_KEY`)
3. Run `gcloud run deploy tldr-shield --source . --region us-central1 --project tldr-493003`
4. Post the deploy URL as a GitHub deployment

**GitHub Secrets to add:**
- `GCP_SA_KEY` — Google Cloud service account JSON with Cloud Run Developer + Storage Writer roles
- `NIM_API_KEY_1` — for eval runs in CI
- `FIREBASE_SERVICE_ACCOUNT_JSON` — for Firestore tests in CI (optional, can skip if not needed)

**How to test:**
- Push a trivial change (add a comment) → verify CI runs and passes
- Create a PR → verify CI blocks merge if lint fails
- Merge to master → verify auto-deploy runs and `/health` returns OK

**Commit message:** `ci: add GitHub Actions CI/CD pipeline with lint, build, eval, and Cloud Run deploy`

---

### Task 1.4 — Add Scheduled Weekly Eval Run

**Files to create:**
- `.github/workflows/weekly-eval.yml` — runs every Monday at 9:00 AM IST (3:30 AM UTC)

**What it does:**
1. Runs `npm run eval` (full dataset, both tiers)
2. Parses the JSON output
3. Compares `pillarsPct` against a baseline (stored in `eval/baseline.json`)
4. If accuracy drops > 5% from baseline → create a GitHub Issue automatically titled "⚠️ Eval regression detected"
5. Always post a summary comment with current accuracy numbers

**Files to create:**
- `eval/baseline.json` — stores the current known-good accuracy numbers:
  ```json
  { "pillarsPct": 87.5, "ratingPct": 92.0, "parseFails": 0 }
  ```

**How to test:**
- Manually trigger the workflow from GitHub Actions tab → "Run workflow"
- Verify the summary is posted
- Temporarily lower the baseline to trigger a false regression → verify the Issue is created

**Commit message:** `ci: add weekly scheduled eval run with regression detection`

---

### Task 1.5 — Add Deploy Checklist Pre-Hook

**Files to modify:**
- `package.json` — update deploy script to run `deploy-checklist` skill first

**What to add to package.json scripts:**
```json
"predeploy": "npm run lint && npm run build && npm run eval:quick"
"deploy": "gcloud run deploy tldr-shield --source . --region us-central1 --project tldr-493003 --allow-unauthenticated"
```

**How to test:**
- Run `npm run deploy` with a TypeScript error in `server.ts` → should fail at lint step
- Fix the error → should proceed through build and eval before deploying

**Commit message:** `chore: add predeploy checklist — lint + build + quick eval must pass before deploy`

---

## Phase 2 — Extension & UX Polish

**Goal:** Make the extension feel like a polished product, not a prototype. This is what users and interviewers see first.

---

### Task 2.1 — Extension Popup Redesign

**Files to modify:**
- `extension/popup.html` — redesign layout
- `extension/popup.js` — update logic

**Current state:** Basic form with tier picker, toggles, and sign-in button.

**What to build:**
- Header: TLDR Shield logo + version badge
- Auth section: If signed out → Google sign-in button (prominent). If signed in → avatar + email + credits badge (green pill showing "400 credits")
- Tier section: Card-style picker — Quick Scan card (10 credits, ~5s) vs Deep Scan card (20 credits, ~30s). Deep card has a "Recommended" badge. Currently selected card has a highlighted border.
- Toggles section: Two clearly labeled toggles — "ELI5 Mode" (plain English) and "Dark Patterns" (extra checks). Each has a one-line description below.
- Scan button: "Scan This Page" button at the bottom, disabled if not signed in
- Footer: Link to dashboard (`View History`) + small text with backend URL

**How to test:**
- Open popup on any page → verify all elements render correctly
- Sign in → verify credits update in real-time
- Toggle ELI5 → run a scan → verify citations are plain English
- Use `extension-testing` skill to automate badge detection

**Commit message:** `feat: redesign extension popup with card-based tier picker and credit display`

---

### Task 2.2 — Improve Badge UI & Progress Steps

**Files to modify:**
- `extension/content.js` — update badge rendering and progress display
- `extension/content.css` — update badge styles

**Current state:** Floating badge with basic spinner and final result.

**What to build:**
- **Loading state:** Show animated scanning steps as they arrive via SSE:
  - "Reading document..." (step 1)
  - "Analyzing privacy pillars..." (step 2)
  - "Grounding citations..." (step 3)
  - "Computing final score..." (step 4)
  - Each step shows a checkmark when complete and highlights the current step
- **Result state (Quick):** Large SAFE/OKAY/RISKY badge with score number and one-line TLDR. "Run Deep Scan →" button below.
- **Result state (Deep):** Expandable badge — collapsed shows rating + score. Expanded shows all 6 pillar rows with colored indicators (green dot = safe, red dot = violated) and the verbatim citation for each violated pillar.
- **Error state:** Clear error message with retry button
- **Out of credits state:** "No credits remaining. Resets on [date]." with link to dashboard

**Colours:**
- SAFE → emerald (#10b981)
- OKAY → amber (#f59e0b)
- RISKY → rose (#f43f5e)

**How to test:**
- Navigate to `twitter.com/tos` → trigger scan → verify all 4 progress steps appear in sequence
- Verify deep scan shows expandable pillar breakdown
- Verify ELI5 citations are plain English
- Verify out-of-credits state shows correctly
- Use `extension-testing` skill for automated badge detection

**Commit message:** `feat: improve badge UI with step-by-step progress and expandable deep scan results`

---

### Task 2.3 — React Dashboard — History Page Improvements

**Files to modify:**
- `src/App.tsx` — improve scan history UI

**Current state:** Basic list of scan records with rating badge, score, TLDR, and delete button.

**What to build:**
- **Search/filter bar:** Filter by rating (SAFE/OKAY/RISKY) and by tier (Quick/Deep). Text search over URL and TLDR.
- **Score visualization:** Replace the plain number with an animated score ring (SVG circle, existing `ScoreRing` pattern). Colour matches rating.
- **Pillar summary chips:** For deep scans, show coloured chips for each violated pillar (e.g., red chip "AI Training", red chip "Data Selling"). SAFE pillars are not shown to reduce clutter.
- **Expand to full result:** Click any scan row → expand inline to show full pillar breakdown with citations. Same animation as badge expand.
- **Empty state:** When no scans exist yet, show a helpful prompt: "Install the Chrome extension and visit any Terms of Service or Privacy Policy page to see your first scan here."
- **Stats bar:** At the top of history page — "X scans this month | Y RISKY | Z SAFE". Update in real-time.

**How to test:**
- Sign in → do 3+ scans (mix of SAFE and RISKY) → verify stats bar updates
- Filter by RISKY → only RISKY scans visible
- Search "spotify" → only Spotify scans visible
- Click scan row → expand → verify citations are correct
- Delete a scan → verify it disappears instantly (optimistic update)

**Commit message:** `feat: improve history dashboard with search, filter, pillar chips, and expandable details`

---

### Task 2.4 — Dashboard Landing Page Improvements

**Files to modify:**
- `src/App.tsx` — update landing page sections

**Current state:** Hero + 6-pillar grid + CTA buttons.

**What to add:**
- **Live scan counter:** "X policies analyzed" — read from Firestore `shared_cache` collection count. Update every 60 seconds.
- **Real example section:** "See it in action" — interactive demo showing a scan of a well-known ToS (Twitter/X). The demo result is hardcoded (not a live API call) but looks exactly like a real result.
- **How it works section (3 steps):**
  1. Install the extension
  2. Visit any Terms of Service page
  3. Get your SAFE/OKAY/RISKY verdict instantly
- **Privacy promise section:** "We never read your browsing history. We only analyze text you explicitly submit. Results are cached anonymously — no personal data attached."
- **Update "Add to Chrome" CTA** to link to the actual Chrome Web Store listing (placeholder URL for now, add real URL after publishing)

**How to test:**
- Open landing page → verify scan counter shows a number (or 0 if no shared cache)
- Verify the demo scan section renders with correct Spotify RISKY result
- Verify all 3 CTA buttons link to correct destinations
- Test on mobile viewport (375px) — all sections must be readable

**Commit message:** `feat: improve landing page with live counter, demo section, and how-it-works`

---

### Task 2.5 — Extension: Side Panel Support

**Files to modify:**
- `extension/manifest.json` — add `sidePanel` permission and declare side_panel
- `extension/popup.js` — add button to open side panel
- Create: `extension/sidepanel.html` + `extension/sidepanel.js`

**What to build:**
- Chrome Side Panel (available since Chrome 114) that shows the scan result in a larger, scrollable panel instead of the floating badge
- Side panel shows: Rating banner, score ring, full TLDR paragraph, all 6 pillar rows with citations, "Scan Again" button
- The floating badge gets a small "Open Panel →" button that opens the side panel
- Side panel persists across page navigation (shows last scan result until new page triggers a new scan)

**Manifest additions:**
```json
"permissions": ["activeTab", "storage", "scripting", "offscreen", "sidePanel"],
"side_panel": { "default_path": "sidepanel.html" }
```

**How to test:**
- Install updated extension → navigate to a ToS page → trigger scan → click "Open Panel"
- Verify side panel appears on the right with full results
- Navigate to a new ToS page → verify panel updates with new scan results
- Verify panel persists if you navigate back to the same URL (shows cached result)

**Commit message:** `feat: add Chrome side panel for full-detail scan results`

---

## Phase 3 — New Features

**Goal:** Add the three highest-value features from the roadmap: GDPR email generation, privacy benchmarking, and batch scan.

---

### Task 3.1 — One-Click GDPR "Right to Erasure" Email Generator

**Files to create:**
- `server.ts` — add `POST /api/gdpr-email` endpoint
- `extension/sidepanel.js` — add "Generate GDPR Email" button in side panel
- `src/App.tsx` — add GDPR email generator in history page (per scan record)

**What to build:**

Backend endpoint `POST /api/gdpr-email`:
- Input: `{ url: string, companyName: string, userEmail: string, violations: string[] }`
- Uses NIM LLM to generate a formal GDPR "Right to Erasure" (Article 17) email draft
- Prompt includes: the company name, user's email, specific violations found (e.g., "AI training without opt-out", "data sold to brokers")
- Output: `{ subject: string, body: string }` — a ready-to-send email
- Cost: 5 credits (cheaper than a scan since it's a simple generation task)
- No caching (personalized per user email)

Extension side panel UI:
- After a RISKY or OKAY deep scan → show "Generate Opt-Out Email" button
- Opens a small form: "Your email address" input → "Generate Email" button
- Shows generated email in a text area → "Copy to Clipboard" button
- Also shows "mailto:" link that pre-fills Gmail/Outlook with the email

Dashboard UI:
- Each RISKY scan record gets a "Generate Email" icon button
- Same form flow as extension

**How to test:**
- Do a deep scan of Spotify ToS (RISKY) → click "Generate Email" → enter your email → verify generated email mentions Spotify and references the specific violations found
- Verify email is properly formatted (has subject line, formal greeting, article citations)
- Verify "Copy to Clipboard" works
- Verify 5 credits are deducted after generation
- Verify clicking "Generate Email" on a SAFE scan is disabled (no violations to opt out of)

**Commit message:** `feat: add one-click GDPR Right to Erasure email generator`

---

### Task 3.2 — Privacy Benchmarking (Compare Against Industry Average)

**Files to modify:**
- `server.ts` — add `GET /api/benchmark/:category` endpoint
- `src/App.tsx` — add benchmark view in history page
- Create: `eval/benchmarks.json` — pre-computed industry averages

**What to build:**

Industry categories:
- Social Media (Twitter, Instagram, Facebook, TikTok, LinkedIn)
- Streaming (Spotify, Netflix, YouTube, Apple Music)
- Cloud Storage (Dropbox, Google Drive, iCloud, OneDrive)
- E-commerce (Amazon, eBay, Etsy, Shopify)
- Gaming (Steam, Epic, Xbox, PlayStation)
- Finance (PayPal, Stripe, Venmo, Cash App) — excluded from live scans but can use pre-scanned data

`eval/benchmarks.json` structure:
```json
{
  "social_media": { "avgScore": 31, "riskiest": "TikTok", "safest": "LinkedIn", "commonViolations": ["ai_training", "data_selling"] },
  "streaming": { "avgScore": 42, ... }
}
```

Backend endpoint `GET /api/benchmark/:category`:
- Returns pre-computed benchmark data for the requested category
- Also queries Firestore `shared_cache` for real scans of known sites in that category
- Returns: `{ categoryAvg: number, userSiteScore: number, rank: string, topViolations: string[] }`

Dashboard benchmark view:
- After viewing a scan from history → "How does this compare?" button
- Shows a horizontal bar chart: the user's site score vs category average
- Label: "Spotify scores 34/100 — worse than 73% of streaming services"
- Shows which violations are most common in that category

**How to test:**
- View Spotify scan in history → click "Compare" → verify benchmark shows streaming category
- Verify user's score is correctly positioned vs industry average
- Test with a SAFE site → "Better than X% of sites in category" message
- Verify the chart renders correctly on mobile viewport

**Commit message:** `feat: add privacy benchmarking — compare site score against industry category average`

---

### Task 3.3 — Batch Scan (All Legal Links on a Page)

**Files to modify:**
- `extension/content.js` — add link detection for legal pages
- `extension/background.js` — add batch scan queue
- `extension/popup.js` — add "Scan All Legal Links" button
- `server.ts` — no changes needed (existing `/api/analyze` handles each scan)

**What to build:**

Link detection (`content.js`):
- Scan all `<a>` tags on the current page
- Filter those whose `href` or link text matches legal keywords (privacy, terms, cookie, legal, conditions, gdpr)
- Return an array of `{ url, text }` objects (max 10 links to avoid credit exhaustion)

Batch scan queue (`background.js`):
- New message type: `BATCH_SCAN` — accepts array of URLs
- Processes them sequentially (not parallel) to avoid rate limiting
- Sends `BATCH_PROGRESS` messages back to popup: `{ total: 5, completed: 2, currentUrl: "...", results: [...] }`

Popup UI:
- New button: "Scan All Legal Links on This Page"
- Shows progress: "Scanning 2/5 links..."
- When done: shows a mini-report listing all scanned URLs with their ratings (color-coded badges)
- Each result links to open the full scan in the side panel

**How to test:**
- Navigate to `google.com` (has multiple legal links in footer) → click "Scan All Legal Links"
- Verify popup detects multiple links (Privacy Policy, Terms of Service, Cookie Policy)
- Verify each one gets scanned sequentially with progress updates
- Verify final mini-report shows all results
- Verify credits are deducted correctly (10 per quick scan × number of links)
- Verify if a page has no legal links → button is disabled with tooltip "No legal links found on this page"

**Commit message:** `feat: add batch scan — detect and scan all legal links on a page`

---

## Phase 4 — Advanced Capabilities

**Goal:** Long-term differentiators that make TLDR Shield technically impressive for a portfolio and commercially viable.

---

### Task 4.1 — NIM Key Health Monitoring Dashboard

**Files to create:**
- `eval/nimHealthMonitor.ts` — health check script
- `.github/workflows/nim-health.yml` — runs every 6 hours

**What to build:**

`eval/nimHealthMonitor.ts`:
- Tests each NIM key individually (1 short completion request per key)
- Records: latency, success/failure, rate limit status
- Outputs a JSON report: `{ key1: { ok: true, latencyMs: 340 }, key2: { ok: false, error: "429" }, key3: { ok: true, latencyMs: 280 } }`

GitHub Actions workflow (every 6 hours):
- Runs the health check
- If any key returns error → creates a GitHub Issue: "⚠️ NIM Key 2 is failing — check API quota"
- Posts the latency report as a workflow artifact

Dashboard `/health` endpoint update:
- Add per-key health status to the health response:
  ```json
  "nimKeys": { "total": 3, "healthy": 2, "failing": ["key2"] }
  ```

**How to test:**
- Set one NIM key to an invalid value → run `npm run check:nim` → verify it reports that key as failing
- Trigger the GitHub workflow manually → verify Issue is created for the bad key
- Fix the key → run again → verify Issue is auto-closed

**Commit message:** `feat: add NIM key health monitoring with GitHub Actions and issue alerts`

---

### Task 4.2 — Policy Change Notifications

**Files to modify:**
- `server.ts` — add `POST /api/watch` endpoint and scheduled re-scan logic
- `src/App.tsx` — add "Watch for Changes" button on history records
- `extension/background.js` — add notification trigger

**What to build:**

Watch endpoint `POST /api/watch`:
- Input: `{ uid, url, lastScanId, lastScore, lastHash }`
- Stores a watch record in Firestore `/watches/{watchId}` with: uid, url, lastHash (SHA-256 of the policy text), lastScore, lastRating, createdAt, nextCheckAt
- Users can watch up to 10 URLs (free tier limit)

Re-scan job (`POST /api/recheck` — internal endpoint protected by `INTERNAL_API_KEY`):
- Called by a Cloud Scheduler cron job every 24 hours
- For each watch record where `nextCheckAt <= now`:
  - Fetch the URL and extract text
  - Compute SHA-256 of the text
  - Compare to `lastHash` — if different → policy has changed
  - Run a quick scan on the new text
  - If score changes by > 10 points or rating changes → send notification
  - Update the watch record with new hash and score
  - Set `nextCheckAt = now + 24h`

Notification delivery:
- Write a notification record to Firestore `/notifications/{uid}/items/{id}`
- The React dashboard subscribes to this collection and shows a red badge on the "History" button when new notifications exist
- Chrome extension checks for notifications on startup (once per session)

Dashboard UI:
- Bell icon in nav bar → opens notification panel: "Spotify's Privacy Policy changed! Score dropped from 42 to 28. View changes →"
- Each notification links to the updated scan in history
- Mark as read removes the badge

**How to test:**
- Watch Spotify's ToS URL
- Manually update the stored hash in Firestore to force a "change detected"
- Trigger `/api/recheck` manually → verify notification appears in dashboard
- Verify Chrome extension shows notification badge on startup
- Test with a URL that doesn't change → verify no false notification

**Commit message:** `feat: add policy change notifications with 24h monitoring and Firestore alerts`

---

### Task 4.3 — Firefox Extension Support

**Files to modify:**
- `extension/manifest.json` — make MV3-compatible with Firefox Manifest V3 quirks
- `extension/background.js` — replace Chrome-only APIs with cross-browser compatible versions
- Create: `extension/manifest.firefox.json` — Firefox-specific manifest overrides
- Create: `build-extension.sh` — script to build Chrome and Firefox variants

**Key differences between Chrome MV3 and Firefox MV3:**
- Firefox does not support `chrome.runtime.getPlatformInfo()` in the same way → replace keepalive ping with `browser.runtime.getBrowserInfo()`
- Firefox offscreen API is not supported → PDF extraction needs alternative (use `fetch` + manual PDF.js init without offscreen document)
- Firefox uses `browser.*` namespace alongside `chrome.*` — add polyfill
- Firefox requires `browser_specific_settings` in manifest:
  ```json
  "browser_specific_settings": { "gecko": { "id": "tldr-shield@jatin", "strict_min_version": "109.0" } }
  ```

**Build script:**
- Chrome: use `manifest.json` as-is
- Firefox: merge `manifest.json` with `manifest.firefox.json` overrides, output to `dist-firefox/`

**How to test:**
- Load `dist-firefox/` as a temporary extension in Firefox: `about:debugging` → "This Firefox" → "Load Temporary Add-on"
- Navigate to `twitter.com/tos` → verify badge appears and scan completes
- Test PDF scan (navigate to a PDF policy URL) → verify PDF text extraction works

**Commit message:** `feat: add Firefox MV3 extension support with cross-browser polyfill`

---

### Task 4.4 — WASM Local Inference (Offline Quick Scans)

**Context:** This is the most technically complex task. Run small language models directly in the browser using WebAssembly — no backend call, no credits needed for quick scans. Requires a model small enough to fit in browser memory (~2GB limit) but capable enough for basic pillar detection.

**Recommended model:** Gemma 2B or Phi-3 Mini (via `@huggingface/transformers` WebGPU/WASM backend)

**Files to create:**
- `extension/wasm-worker.js` — Web Worker that loads and runs the WASM model
- `extension/wasm-inference.js` — interface between content/background and the WASM worker
- `extension/manifest.json` — add worker permissions

**Architecture:**
- The WASM model loads once when the extension starts (cached in IndexedDB after first load)
- Quick scans under 5,000 characters → use WASM local inference (free, instant, private)
- Quick scans over 5,000 characters → use NIM backend as usual (10 credits)
- Deep scans always use NIM backend (quality requirement too high for small model)
- Popup shows "Local AI" badge vs "Cloud AI" badge to indicate which inference path was used

**What the local model outputs:**
- Same 6-pillar JSON schema as the NIM backend (but no verbatim citations — just violation flags)
- No score (score is shown as null for local scans — "Score: N/A (local mode)")
- Rating: SAFE / OKAY / RISKY based on pillar flags

**How to test:**
- First time: load extension → navigate to a short ToS snippet → verify model downloads (~1-2GB, show progress bar in popup during download)
- Second time: verify model loads from IndexedDB (instant, no download)
- Scan a short ToS → verify "Local AI" badge in popup, 0 credits deducted
- Scan a long ToS (>5k chars) → verify "Cloud AI" badge, 10 credits deducted
- Disable internet → scan a short ToS → verify local AI still works
- Compare local result with NIM result for the same document → verify they broadly agree on violations

**Commit message:** `feat: add WASM local inference for short quick scans — free, offline, private`

---

## Testing Strategy by Phase

### When to Test What

| Event | Tests to Run |
|-------|-------------|
| Any edit to `server.ts` | `npm run lint` + `npm run eval:quick` (5 cases) |
| Any edit to `extension/*.js` | `extension-testing` skill (Playwright automated badge test) |
| Any edit to `src/App.tsx` | Visual review in browser (`npm run dev`) |
| Any edit to `eval/dataset.jsonl` | `npm run eval` (full suite) |
| Before any Cloud Run deploy | `deploy-checklist` skill (lint + build + eval:quick) |
| After any Cloud Run deploy | Check `/health` endpoint, do one live scan |
| Weekly (automated) | Full eval suite via GitHub Actions |
| Every 6 hours (automated) | NIM key health check via GitHub Actions |
| On PR to master | CI pipeline: lint + build + eval:quick |

### Accuracy Baselines to Maintain

| Metric | Minimum acceptable | Target |
|--------|-------------------|--------|
| `pillarsPct` (all pillars correct) | > 80% | > 90% |
| `ratingPct` (SAFE/OKAY/RISKY correct) | > 85% | > 95% |
| `parseFails` | 0 | 0 |
| Quick scan p50 latency | < 10s | < 6s |
| Deep scan p50 latency | < 35s | < 25s |
| Deep scan p90 latency | < 50s | < 40s |

### Manual Test Checklist (run before any public announcement)

- [ ] Sign in with Google → verify 400 credits shown
- [ ] Navigate to `twitter.com/tos` → verify RISKY badge with score < 40
- [ ] Navigate to a simple ToS (e.g., a small open-source project) → verify SAFE badge
- [ ] Toggle ELI5 mode → run scan → verify citations are plain English
- [ ] Toggle Dark Patterns off → run scan → verify 5 pillars only
- [ ] Run out of credits (or lower to 0 in Firestore) → verify "Out of credits" UI appears
- [ ] Click "View History" → verify all past scans appear in chronological order
- [ ] Delete a scan → verify it disappears instantly
- [ ] Open `/health` → verify `status: ok`, `nimKeys: 3`, `sharedCache.connected: true`
- [ ] Verify same-page scan shows "cached" result instantly (no credits deducted)

---

## File Map — Complete Picture

```
2. TLDR/
├── server.ts                    ← Backend (all API routes, NIM pipeline, caching)
│                                  Phase 0: INTERNAL_API_KEY
│                                  Phase 3: /api/gdpr-email, /api/benchmark, /api/watch, /api/recheck
├── vite.config.ts               ← Already updated (code splitting) ✅
├── src/
│   ├── App.tsx                  ← React app (landing + history)
│   │                              Phase 2: history improvements, landing improvements
│   │                              Phase 3: GDPR email UI, benchmark UI, notifications UI
│   ├── firebase.ts              ← Firebase client (no changes expected)
│   ├── main.tsx                 ← Entry point (no changes)
│   └── index.css                ← Global styles (no changes)
├── extension/
│   ├── manifest.json            ← Phase 0: remove Railway, bump to v2.0
│   │                              Phase 2: add sidePanel permission
│   │                              Phase 4: Firefox compatibility
│   ├── content.js               ← Phase 2: badge UI improvements, link detection
│   ├── background.js            ← Phase 2: progress steps, Phase 3: batch scan queue
│   ├── popup.html/.js           ← Phase 2: popup redesign
│   ├── sidepanel.html/.js       ← Phase 2: NEW side panel (create from scratch)
│   ├── offscreen.html/.js       ← No changes expected
│   └── content.css              ← Phase 2: badge style updates
├── eval/
│   ├── dataset.jsonl            ← Phase 1: expand from 8 to 30 cases
│   ├── golden.test.ts           ← Phase 1: expand from 5 to 10 cases
│   ├── runEval.ts               ← No changes
│   ├── checkNimKeys.ts          ← No changes
│   ├── nimHealthMonitor.ts      ← Phase 4: NEW (key health monitoring)
│   ├── baseline.json            ← Phase 1: NEW (accuracy baseline)
│   └── benchmarks.json          ← Phase 3: NEW (industry averages)
├── .github/
│   └── workflows/
│       ├── ci.yml               ← Phase 1: NEW (lint + build + eval on every PR)
│       ├── deploy.yml           ← Phase 1: NEW (auto-deploy on master merge)
│       ├── weekly-eval.yml      ← Phase 1: NEW (weekly accuracy monitoring)
│       └── nim-health.yml       ← Phase 4: NEW (6-hour NIM key health check)
├── docs/
│   └── superpowers/
│       └── plans/
│           └── 2026-04-11-tldr-shield-master-plan.md  ← THIS FILE
├── nixpacks.toml                ← No changes
├── railway.json                 ← Can be deleted (no longer on Railway)
├── firebase-applet-config.json  ← No changes (non-secret, checked in)
├── firestore.rules              ← Review: ensure shared_cache still client-read-blocked
├── package.json                 ← Phase 1: add predeploy script
└── .env                         ← Local dev only, never commit
```

---

## Deployment Workflow (After CI/CD is Set Up)

```
Developer pushes to master
        ↓
GitHub Actions CI runs:
  1. npm run lint           ← must pass
  2. npm run build          ← must pass
  3. npm run eval:quick     ← must pass (5 cases, pillarsPct > 80%)
        ↓ (all pass)
GitHub Actions Deploy runs:
  1. gcloud run deploy tldr-shield --source . --region us-central1
  2. Verify /health returns ok
  3. Post deploy URL to GitHub deployment log
        ↓
Live at: https://tldr-shield-14714987621.us-central1.run.app
```

---

## Priority Order for Implementation

1. **Phase 0** — All 5 tasks — do these immediately, in order
2. **Phase 1, Task 1.3** — CI/CD pipeline — set this up before Phase 2 so all changes are gated
3. **Phase 1, Task 1.1** — Expand eval dataset — run evals to establish baseline accuracy
4. **Phase 2, Task 2.1** — Popup redesign — highest user-facing impact
5. **Phase 2, Task 2.2** — Badge UI improvements — second highest user-facing impact
6. **Phase 2, Task 2.3** — History page improvements
7. **Phase 1, Task 1.2** — Golden tests
8. **Phase 1, Task 1.4** — Weekly eval schedule
9. **Phase 1, Task 1.5** — Deploy checklist script
10. **Phase 2, Task 2.4** — Landing page improvements
11. **Phase 2, Task 2.5** — Side panel
12. **Phase 3, Task 3.1** — GDPR email generator
13. **Phase 3, Task 3.2** — Benchmarking
14. **Phase 3, Task 3.3** — Batch scan
15. **Phase 4, Task 4.1** — NIM health monitoring
16. **Phase 4, Task 4.2** — Policy change notifications
17. **Phase 4, Task 4.3** — Firefox support
18. **Phase 4, Task 4.4** — WASM local inference

---

## Definition of Done (Per Phase)

### Phase 0 Done When:
- `/health` returns `sharedCache.connected: true`
- Extension version shows 2.0 in Chrome
- `/api/credits` returns 401 without `X-API-Key` header
- NIM keys regenerated and all 3 working
- Budget alert set in Google Cloud

### Phase 1 Done When:
- `npm run eval` runs 30 cases with `pillarsPct > 85%`
- All 10 golden tests pass
- CI/CD pipeline runs on every PR and blocks on failure
- Auto-deploy triggers on master merge and succeeds
- Weekly eval workflow runs without errors

### Phase 2 Done When:
- Extension popup shows card-based tier picker and live credit count
- Badge shows step-by-step progress during scan
- History page has search, filter, pillar chips, and expandable details
- Side panel works on Chrome 114+
- Manual test checklist passes 100%

### Phase 3 Done When:
- GDPR email generates correctly for RISKY scans and deducts 5 credits
- Benchmark compares correctly against pre-computed industry averages
- Batch scan processes up to 10 legal links sequentially with progress UI

### Phase 4 Done When:
- NIM key health check runs every 6 hours and creates GitHub Issues on failure
- Policy change notifications fire when SHA-256 hash of watched URL changes
- Firefox extension passes manual test on Firefox 109+
- WASM local inference completes quick scan under 5k chars offline with 0 credits deducted
