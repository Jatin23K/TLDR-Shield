# Deployment Configs

## Active deployment: Google Cloud Run

```bash
npm run deploy
# Runs: gcloud run deploy tldr-shield --source . --region us-central1 --project tldr-493003 --allow-unauthenticated
```

The `predeploy` script runs lint → build → golden tests → quick eval before deploying.
Cloud Run uses Application Default Credentials — no service account file needed.

---

## Alternative configs (not currently active)

| File | Platform | Notes |
|------|----------|-------|
| `railway.json` | Railway | Node.js service config |
| `nixpacks.toml` | Railway / Nixpacks | Build config (Node 20, `npm run build && npm start`) |
