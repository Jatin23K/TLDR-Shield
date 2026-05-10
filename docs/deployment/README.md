# Deployment Configs

## Active deployment: Render

Service: `tldr-shield`
URL: `https://tldr-shield.onrender.com`

Render auto-deploys on every push to `master` via Docker.
All environment variables are set in the Render dashboard.

---

## Alternative configs (not currently active)

| File | Platform | Notes |
|------|----------|-------|
| `railway.json` | Railway | Node.js service config |
| `nixpacks.toml` | Railway / Nixpacks | Build config (Node 20, `npm run build && npm start`) |
