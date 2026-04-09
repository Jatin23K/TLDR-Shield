# Project Rules

Behavioral rules for Claude Code when working on TLDR Shield.
These are constraints derived from how this codebase actually works — not generic best practices.

---

## 1. Before Making Any Change

**Read before you write.**
- Read the full function you are changing, not just the lines around the edit.
- Read the callers of any function you modify. `server.ts` has long call chains — a change deep in `analyzeChunk()` affects `startServer()` at the bottom.
- If the change touches pillar logic, read ALL FOUR pillar locations before editing any of them:
  1. `buildSystemPrompt()` — server.ts ~line 1112
  2. `applyConsistencyCrossCheck()` — server.ts ~line 735
  3. `buildDeterministicDeepFallback()` — server.ts ~line 1014
  4. `eval/dataset.jsonl` + `eval/golden.test.ts`

**Check git state first.**
- Run `git status` and `git diff` before starting any task.
- If there are uncommitted changes not related to the task, flag them to the user before proceeding. Do not silently overwrite in-progress work.

**Understand the failure mode before fixing it.**
- If fixing a bug, reproduce it in your head with the actual code path before writing a fix.
- NIM errors, Firestore errors, and SSE errors all have different retry/fallback behavior. Read the relevant handler before patching it.

**Do not assume the current code is wrong.**
- Many patterns in `server.ts` that look unusual (double retry, `fire-and-forget` Firestore writes, the `tailSentences` overlap logic) exist because of specific, documented failure modes. Read the surrounding comments before "simplifying."

---

## 2. Never Do Without Explicit Permission

**Never modify these without asking first:**

| What | Why |
|------|-----|
| `checkAndDeductCredits()` or `refundCredits()` | Firestore transaction logic — bugs cause real money/credit loss for real users |
| The cache hash construction in `/api/analyze` | Changing the hash formula silently invalidates the entire shared Firestore cache for all users |
| `aggregateResults()` worst-case scoring | The union-of-violations + worst-score design is a deliberate safety choice. Weakening it lets bad policies through |
| `applyConsistencyCrossCheck()` keyword list | Only change after running full evals and confirming no regression |
| `PARAPHRASE_PATTERNS` or `sanitizeCitations()` | Over-aggressive stripping removes real citations; under-aggressive leaves hallucinations |
| `firestore.rules` | Any loosening of `shared_cache` client-block or `users` owner-only rules is a security regression |
| Extension keepalive mechanism (port + `getPlatformInfo` interval) | Both mechanisms are required. Removing either causes deep scans to silently fail on slow connections |
| `CHUNK_CONCURRENCY` | Currently 2. Raising it risks simultaneous 429s across all 3 NIM keys |
| `FREE_CREDITS` or `CREDIT_COST` | Changing credit values affects all existing users immediately on next scan |

**Never:**
- Delete or rename Firestore collection names (`scans`, `users`, `shared_cache`, `reports`) — these are live production collections.
- Add `console.log` calls that could print user text, auth tokens, or PII.
- Add `try/catch` blocks that silently swallow errors without at minimum a `console.warn`.
- Hardcode port 3000 anywhere in `server.ts` — always read `process.env.PORT`.
- Commit `.env` or any file containing `nvapi-` keys.
- Use `getFirestore()` directly in either `server.ts` or `src/firebase.ts` — always use the existing `firestoreDb` (server) or `db` (client) exports.

---

## 3. Extension-Specific Rules (MV3)

**After every edit to any file under `extension/`:**
1. Tell the user to reload the extension at `chrome://extensions`.
2. If `background.js` changed, warn that any scan currently in progress will be terminated on reload.
3. If `manifest.json` changed and permissions were added or removed, the extension must be fully removed and re-added — a simple reload is not enough.

**Service worker constraints:**
- The MV3 service worker (`background.js`) has no persistent state between invocations. Any state that must survive across messages must live in `chrome.storage.local`, not module-level variables.
- Exception: `activePorts` (Map of tabId → port) is intentionally module-level — it is ephemeral and only needed for the duration of a scan.
- The keepalive `setInterval` in `analyzeText()` must be cleared in the `finally` block. If you add new early-return paths in `analyzeText()`, ensure `clearInterval` is called on each path.

**Storage reads:**
- Always use `chrome.storage.local.get({ key: defaultValue }, callback)` — provide defaults. Never read storage without a default; missing keys return `undefined` and cause silent failures in comparisons like `authTokenExpiry > Date.now()`.

**Auth token:**
- Always check `authToken && authTokenExpiry > Date.now()` before using the token. A stored but expired token is indistinguishable from a valid one without this check.
- Firebase ID tokens expire after 1 hour. The stored `authTokenExpiry` is set to 55 minutes (`Date.now() + 55 * 60 * 1000`).

**Cross-context messaging:**
- `chrome.runtime.sendMessage` throws if no listener is registered. Always wrap calls that might fire before the target context is ready in a try/catch.
- The `ANALYZE_TEXT` message must be sent only after the keepalive port is open. The order in `content.js` is: open port → send message. Do not reverse this.

**PDF handling:**
- PDFs are always forced to Deep tier regardless of text length. This is not a bug — PDF extraction via pdf.js in an offscreen document produces noisy text that benefits from longer analysis.
- Never route PDF analysis through Quick tier.

**Content script isolation:**
- `content.js` runs in every page. Any global variable or event listener you add runs on every tab. Keep the footprint minimal — no heavy computation in the global scope.

---

## 4. Backend Rules (`server.ts`)

**NIM calls:**
- All NIM completions go through `nimCreateWithRetry()`. Never instantiate an `OpenAI` client and call `.chat.completions.create()` directly inside a route handler or helper — you will bypass key rotation, timeout handling, and retry logic.
- The per-key timeout (`PER_KEY_TIMEOUT_MS`) and the global scan timeout (set in `background.js`, 90s) are independent. Changes to one do not affect the other.
- When adding a new NIM call (e.g., for a new feature), pass the existing `signal: AbortSignal` through to it. Every NIM call must be abortable.

**SSE streaming:**
- Call `startSse()` (sets SSE headers) before writing any data. Once headers are sent, you cannot change the status code — errors that occur mid-stream must be communicated as SSE events with an `error` field, not HTTP error codes.
- The SSE connection is held open until `res.end()`. Always call `res.end()` in a `finally` block — not just on the happy path.

**Firestore writes are non-blocking:**
- `saveScanRecord()` and `setSharedCache()` are intentionally fire-and-forget with internal error handling. Do not `await` them in the main scan path — scan latency must not depend on Firestore write speed.
- If you add a new Firestore write to the scan path, follow the same pattern: wrap in an IIFE, catch errors internally, do not block the SSE response.

**Cache hash:**
- The hash is: `SHA-256(processedText + '_eli5' (if eli5) + '_deep' (if deep) + '_dp' (if darkPatterns) + '_' + model.id)`
- The `model.id` suffix prevents stale cached results from being served after a model upgrade. If a new model is added, the hash automatically changes — no cache flush needed.
- Do not add new hash components without considering that it will create a cold-cache event for all existing cached results.

**Credit refunds:**
- Credits are refunded when a scan hits cache (user does not consume LLM resources).
- Credits are refunded when the LLM call fails completely and we fall back to the deterministic fallback — or when the request errors before analysis starts.
- Credits are NOT refunded for partial failures (some chunks fail, others succeed) — the analysis still completed.

**Rate limiting:**
- The `/health` endpoint is explicitly excluded from rate limiting. Do not add rate limiting to health checks — they are used by Cloud Run's health check probes.

**Error logging format:**
- Use `[TLDR Shield] [requestId]` prefix for all production logs so they can be correlated in Cloud Run logs.
- Use `console.error` for unrecoverable errors, `console.warn` for degraded states (Firestore offline, key failure), `console.log` for normal operational events.

---

## 5. Eval Rules

**When to run evals:**
- Run `npm run eval:quick` before committing any change to `buildSystemPrompt()` in `server.ts`.
- Run `npm run eval` (full suite) before committing any change to pillar definitions, scoring logic, `aggregateResults()`, `applyConsistencyCrossCheck()`, or `sanitizeCitations()`.
- Run `npm run eval:dark` before committing any change to dark patterns logic.
- Run `npm run check:nim` if any NIM call is failing — confirm which keys are healthy before debugging the code.

**What counts as a regression:**
- Any drop in `accuracy.pillarsPct` greater than **5 percentage points** vs the last known good run.
- Any drop in `accuracy.ratingPct` greater than **5 percentage points**.
- Any increase in `parseFails` above 0 — parse failures should always be 0.
- Any p90 latency increase greater than **5 seconds** for Quick tier or **15 seconds** for Deep tier.

**What does NOT count as a regression (do not block on these):**
- Small score fluctuations on the `transparency` pillar — it is inherently subjective and LLM temperature=0 does not fully eliminate variance.
- Latency variance of ±2 seconds — NIM response time fluctuates with load.

**Adding eval cases:**
- New cases go in `eval/dataset.jsonl`, one JSON object per line.
- Follow the `t{N}_{label}` ID convention (e.g., `t9_opt_out_present`).
- All 6 pillar keys must be present as booleans in `expected.pillars`. Missing keys silently skip checks.
- Pillar key names are `snake_case` — `ai_training`, not `aiTraining`.
- After adding a case, run `npm run eval:quick` to confirm it parses and executes.

**Do not modify existing eval cases** to make a failing test pass. If the model regresses on a known case, fix the model/prompt — not the expected output. Changing expected outputs to match wrong behavior defeats the purpose of the suite.

**Golden tests (`eval/golden.test.ts`) are for citation verification.** They check that violation citations are verbatim substrings of the source text. Do not relax the citation verification logic to make golden tests pass — tighten the prompt instead.

---

## 6. Memory Management

**Update CLAUDE.md when:**
- A new API endpoint is added — add it to the endpoints table.
- A Firestore collection is added or renamed — update the collections table.
- A new environment variable is added — add it to the env vars section.
- The pillar definitions change materially — update the pillar table and scoring bands.
- A new file is added that is not obviously self-explanatory — add it to the repository layout.
- A "Common Gotcha" is discovered that isn't already listed — add it.

**Do not update CLAUDE.md for:**
- Internal implementation changes that don't affect external behavior or interface (refactors, performance improvements, comment changes).
- Temporary debugging code.
- Changes that will be reverted.

**The sub-CLAUDE.md files** (`extension/CLAUDE.md`, `src/CLAUDE.md`) document their respective layers. Keep them in sync with their layer. Do not duplicate information that is already in the root CLAUDE.md.

**Memory files** (`C:\Users\Jatin\.claude\projects\...\memory\`):
- Save a memory when a non-obvious decision is made that future sessions should know about.
- Save a memory when the user corrects an approach — record the correction and the reason.
- Do not save memory for things that are already in CLAUDE.md or derivable from reading the code.

---

## 7. Git Rules

**Before starting any task:**
```bash
git status    # Check for uncommitted changes
git diff      # See what has changed since last commit
```
If there are uncommitted changes unrelated to the current task, flag them before proceeding. Never silently incorporate them into a new commit.

**Before committing:**
```bash
npm run lint   # TypeScript must pass — no commit with type errors
git diff       # Review everything that will go into the commit
```

**Commit message format:** Conventional commits.
```
type(scope): short description

feat(server): add per-pillar confidence field to deep scan response
fix(extension): prevent keepalive interval leak on early scan abort
chore(eval): add t9 opt-out test case to dataset
docs(claude): update endpoint table with /api/report fields
```

Valid types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.
Valid scopes: `server`, `extension`, `src`, `eval`, `firestore`, `claude`, `deps`.

**Commit granularity:**
- One logical change per commit. Do not bundle a bug fix with an unrelated eval case addition.
- If a pillar change requires updates in four locations, that is one commit — it is one logical change with multiple files.

**Never commit:**
- `.env` or any file containing `nvapi-` API keys.
- `node_modules/`
- `dist/` (built artifacts)
- `server.log` or any log files
- `.vs/` (Visual Studio index files — already in `.gitignore`, verify it stays that way)

**After committing:**
```bash
git log --oneline -5   # Confirm commit landed correctly
git status             # Confirm working tree is clean
```

**Do not force-push** to `master` or `main`. If a commit needs to be undone, use `git revert`. If working on a feature, use a feature branch and merge via PR.

**Do not amend published commits.** If a commit is already on the remote, create a new fix commit — do not `git commit --amend` and force-push.
