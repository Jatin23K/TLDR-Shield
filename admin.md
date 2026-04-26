# TLDR Shield — Internal Admin Manual

This document is for **local use only**. It contains sensitive internal keys and administrative commands for managing the TLDR Shield ecosystem.

---

## 🔑 Administrative Credentials

| Variable | Value |
| :--- | :--- |
| **Internal Admin Key** | `ts-admin-d236d37b61a71053279f2f271089b326` |
| **Required Header** | `x-internal-key: ts-admin-d236d37b61a71053279f2f271089b326` |
| **Admin Email** | `markshadow843@gmail.com` |

> [!CAUTION]
> Never share this key or commit it to a public repository. It bypasses all security and credit metering on the backend.

---

## 🎖️ Admin Role Upgrade (One-Time)

You can permanently upgrade your Google account (`markshadow843@gmail.com`) to have **unlimited free scans** without needing the `x-internal-key` header every time.

### How to Upgrade:
Send a `POST` request to `/api/admin/verify` with your Firebase token and the internal key.

```bash
curl -X POST https://tldr-shield-292798741977.us-central1.run.app/api/admin/verify \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_FIREBASE_ID_TOKEN",
    "key": "ts-admin-d236d37b61a71053279f2f271089b326"
  }'
```

**What happens:**
- The server verifies your email and key.
- It sets `role: "ADMIN"` in your Firestore document.
- From then on, all your scans are **FREE**.

---

## 🚀 Pro Mode Hierarchy (Feature Flags)

You can control which models are used for **Deep Scans** via `.env` without redeploying code:

1. **`GEMINI_PRO_MODE`**: The Master Switch.
   - `false`: Pro Mode is disabled for everyone. Everyone uses Flash.
   - `true`: Pro Mode is active (subject to the flag below).

2. **`GEMINI_PRO_FOR_USERS`**: The User Switch.
   - `false`: Only you (the Admin) get Pro Mode for Deep Scans. Regular users stay on Flash.
   - `true`: Everyone gets the Pro Model for Deep Scans.

**How to trigger Pro as Admin:**
Simply include the `x-internal-key` header in your request. The server will detect you as `SYSTEM_ADMIN` and grant you the Pro model (if `GEMINI_PRO_MODE` is `true`).

---

## 🛠 Maintenance Commands

### 1. Force a Fresh Scan (Purge Cache for URL)
If a site updates its terms and you want to force TLDR Shield to re-analyze it immediately (bypassing the 48h/7d cache):

```bash
curl -X POST https://tldr-shield-292798741977.us-central1.run.app/api/recheck \
  -H "Content-Type: application/json" \
  -H "x-internal-key: ts-admin-d236d37b61a71053279f2f271089b326" \
  -d '{"url": "https://example.com/privacy"}'
```

### 2. Global Hot Cache Purge
Clears the L1 Redis cache across the entire service.

```bash
curl -X DELETE https://tldr-shield-292798741977.us-central1.run.app/api/cache \
  -H "x-internal-key: ts-admin-d236d37b61a71053279f2f271089b326"
```

### 3. Unmetered Analysis (Credit Bypass)
Run a scan as an admin to test new prompts or verify accuracy without burning through user credits.

```bash
curl -X POST https://tldr-shield-292798741977.us-central1.run.app/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-internal-key: ts-admin-d236d37b61a71053279f2f271089b326" \
  -d '{
    "text": "Paste policy text here...",
    "tier": "deep",
    "url": "https://test-site.com"
  }'
```

### 4. Real-time Config Toggle (Pro Mode)
Toggle Gemini Pro features instantly without redeploying the server.

*   **GEMINI_PRO_MODE:** Master switch for all Pro features.
*   **GEMINI_PRO_FOR_USERS:** Enables Pro model for regular users (if Master is ON).

```bash
# Example: Enable Pro Mode for everyone
curl -X POST https://tldr-shield-292798741977.us-central1.run.app/api/admin/config \
  -H "Content-Type: application/json" \
  -H "x-internal-key: ts-admin-d236d37b61a71053279f2f271089b326" \
  -d '{
    "GEMINI_PRO_MODE": true,
    "GEMINI_PRO_FOR_USERS": true
  }'
```

---

## 📈 System Monitoring

### Health Check
Check memory usage, Firestore connectivity, and API key health.
- **Endpoint**: `GET /health`
- **Auth**: None required.

---

## 🧪 Evaluation Suite (Local Development)

Run these from the project root using `npm`:

| Command | Description |
| :--- | :--- |
| `npm run eval` | Run the full evaluation dataset against the current model. |
| `npm run eval:deep` | Run only the deep-tier evaluation cases. |
| `npm run check:nim` | Health-check all configured API keys for rate limits. |
| `npm run recheck` | Triggers the `api/recheck` purge via curl (configured in package.json). |

---

## ☁️ Deployment Reference

To update the `INTERNAL_API_KEY` on the live Cloud Run instance:

```bash
gcloud run services update tldr-shield \
  --region us-central1 \
  --update-env-vars "INTERNAL_API_KEY=ts-admin-d236d37b61a71053279f2f271089b326"
```
