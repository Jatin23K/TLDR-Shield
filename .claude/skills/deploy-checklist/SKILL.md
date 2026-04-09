---
name: deploy-checklist
description: Pre-deployment gate before any Cloud Run deploy. Runs lint, eval, build, and verifies config. Blocks deploy on failure.
user-invocable: true
---

# Deploy Checklist Skill

Run this before every Cloud Run deploy. Block deploy if any step fails.

## Checklist

### Step 1 — TypeScript lint

```bash
npm run lint
```

- Must exit 0 (no type errors)
- ❌ Any type error = **BLOCK DEPLOY**
- Common failures: missing types after editing `server.ts`, unused imports, wrong return types

---

### Step 2 — Quick eval accuracy gate

```bash
npm run eval:quick
```

Parse the JSON output. Check:

| Metric | Gate |
|--------|------|
| `parseFails` | Must be 0 |
| `accuracy.pillarsPct` | Must not drop ≥ 5pp vs last known baseline |
| `accuracy.ratingPct` | Must not drop ≥ 5pp vs last known baseline |

- ❌ Any `parseFails` > 0 = **BLOCK DEPLOY**
- ❌ Any regression ≥ 5pp = **BLOCK DEPLOY** (investigate first)
- ✅ All gates pass = continue

---

### Step 3 — Production build

```bash
npm run build
```

- Must complete without errors
- Output goes to `dist/` — verify it exists after build
- ❌ Build error = **BLOCK DEPLOY**

---

### Step 4 — Firestore rules reminder

Check if `firestore.rules` was modified since the last deploy:

```bash
git diff HEAD~1 -- firestore.rules
```

- If changed: **you must deploy rules separately**
  ```bash
  firebase deploy --only firestore:rules
  ```
- If not changed: ✅ skip
- ⚠️ `npm run build` does NOT deploy Firestore rules — this is a manual step

**Critical rules to preserve:**
- `shared_cache` must remain client-read-blocked (Admin SDK only)
- `users` must remain owner-only

---

### Step 5 — Cloud Run env vars verification

Verify the Cloud Run service has all required env vars set. Check via:

```bash
gcloud run services describe tldr-shield --region=us-central1 --format="value(spec.template.spec.containers[0].env)"
```

Required vars:

| Var | Check |
|-----|-------|
| `NIM_API_KEY_1` | Set, starts with `nvapi-` |
| `NIM_API_KEY_2` | Set, starts with `nvapi-` |
| `NIM_API_KEY_3` | Set, starts with `nvapi-` |
| `APP_URL` | Set to production Cloud Run URL |
| `PORT` | Not hardcoded (Cloud Run sets this automatically — should NOT be in env vars) |

- ❌ Any NIM key missing = **BLOCK DEPLOY**
- ⚠️ NIM keys must be `.trim()`-clean — trailing whitespace causes silent 404s

---

### Step 6 — Firebase project config

Verify `firebase-applet-config.json` points to the **production** Firebase project:

```bash
node -e "const c = require('./firebase-applet-config.json'); console.log('projectId:', c.projectId, '| authDomain:', c.authDomain);"
```

- Must show production project ID (not a dev/test project)
- ❌ Wrong project = **BLOCK DEPLOY** (would write scan data to wrong Firestore)

---

## Final gate

All 6 steps must be ✅ before proceeding with deploy.

Report format:

```
Deploy Checklist
────────────────────────────────────────
Step 1  lint              ✅ / ❌
Step 2  eval:quick        ✅ / ❌  (pillarsPct: X%, ratingPct: X%, parseFails: N)
Step 3  build             ✅ / ❌
Step 4  firestore rules   ✅ changed+deployed / ✅ unchanged / ❌ changed but not deployed
Step 5  Cloud Run env     ✅ / ❌  (list any missing vars)
Step 6  Firebase config   ✅ / ❌  (projectId: ...)

Result: ✅ READY TO DEPLOY  /  ❌ BLOCKED — fix above before deploying
```
