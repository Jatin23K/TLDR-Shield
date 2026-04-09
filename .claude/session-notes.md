# Session Handoff Notes

## Status

- Setup complete: CLAUDE.md, rules, permissions, skills, MCP (GitHub MCP connected via `@modelcontextprotocol/server-github`)
- Backend NOT deployed to Cloud Run yet
- No production URL exists yet — `APP_URL` is absent from `.env`

## Blocked Until Backend Deployed

- `DEFAULT_API_URL` fix in `popup.js` and `background.js` — both hardcoded to `''`
- Extension non-functional for fresh installs (users must manually paste URL)

## First Tasks Tonight

1. Install gcloud CLI: `winget install Google.CloudSDK`
2. Deploy backend to Cloud Run: `gcloud run deploy`
3. Get production URL from `gcloud run services list`
4. Fix `DEFAULT_API_URL` in `extension/popup.js` and `extension/background.js`
5. Fix footer links in `src/App.tsx` (currently placeholder `<span>` elements)
6. Push all changes to GitHub

## Known Issues from Audit

- Chrome Web Store link is not real yet — placeholder href
- Footer links are `<span>` elements, not real anchors
- `INTERNAL_API_KEY` is unset in production Cloud Run config
- `@google/genai` is an unused dependency in `package.json`
