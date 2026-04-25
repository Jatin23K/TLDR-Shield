# TLDR Shield — Chrome Web Store Listing

## Store Metadata

**Extension Name:** TLDR Shield

**Short Description (132 chars max):**
> Stop blindly agreeing to Terms of Service. Get instant SAFE/OKAY/RISKY ratings with AI-powered privacy analysis.

**Category:** Productivity

**Language:** English

---

## Full Description (up to 16,000 chars)

```
TLDR Shield reads Terms of Service and Privacy Policies so you don't have to.

Every time you sign up for a new app, you're asked to agree to a wall of legal text. Nobody reads it — but TLDR Shield does.

── HOW IT WORKS ──────────────────────────────────────────

1. Install the extension
2. Visit any Terms of Service, Privacy Policy, or Cookie Policy page
3. A badge automatically appears — click "Scan This Page"
4. Get your verdict in seconds: SAFE ✅ / OKAY ⚠️ / RISKY 🔴

── WHAT IT CHECKS ────────────────────────────────────────

TLDR Shield analyzes every policy against 6 privacy pillars:

🤖 AI Training — Does the service train AI models on your data without a clear opt-out?
💰 Data Selling — Is your personal data sold or shared with advertisers and data brokers?
🔍 Transparency — Is the policy deliberately vague, contradictory, or designed to confuse?
🗑️ Data Retention — How long is your data kept after you delete your account?
©️ Content Rights — Does the company claim overly broad intellectual property rights over what you create?
⚠️ Dark Patterns — Are there forced arbitration clauses, class-action waivers, or liability caps buried in the fine print?

── TWO SCAN MODES ────────────────────────────────────────

⚡ Quick Scan (10 credits) — Instant SAFE/OKAY/RISKY badge with a plain-English summary. Results in ~3 seconds.

🔬 Deep Scan (20 credits) — Full pillar-by-pillar breakdown with verbatim citations pulled directly from the document. Results in ~15 seconds.

── WHAT MAKES TLDR SHIELD DIFFERENT ─────────────────────

✦ Verbatim citations — We show you the exact sentence from the policy that triggered each flag, not a paraphrase.

✦ Confidence indicators — Each pillar shows HIGH / MEDIUM / LOW confidence based on how strongly grounded the citation is.

✦ ELI5 mode — Toggle "Plain English" to get explanations in simple language instead of legal quotes.

✦ Dark patterns detection — Finds class-action waivers, forced arbitration clauses, and shortened statute of limitations buried in ToS.

✦ GDPR email generator — For RISKY policies, generate a pre-written "Right to Erasure" email to send to the company.

✦ Batch scan — Scan all legal links on a page at once (Privacy Policy + Terms + Cookie Policy together).

✦ Policy change alerts — Set a watch on any policy and get notified when it changes.

✦ PDF support — Works on PDF privacy policies, not just web pages.

✦ Offline quick scans — Basic quick scans work locally without an internet connection using on-device AI.

✦ Chrome Side Panel — See full scan results in a persistent side panel while you browse.

── FREE TIER ─────────────────────────────────────────────

Every account gets 400 free credits per month (auto-reset on the 1st).
• Quick scan = 10 credits
• Deep scan = 20 credits
• GDPR email = 5 credits

400 credits = 40 quick scans or 20 deep scans per month. More than enough for everyday use.

── PRIVACY PROMISE ───────────────────────────────────────

We never read your browsing history. We only analyze text from pages you explicitly trigger a scan on. Scan results are cached anonymously — no personal data is attached to the cache. We do not sell your data.

Sign in with Google to save your scan history and manage credits across devices.

── EXAMPLE RESULTS ───────────────────────────────────────

🔴 Twitter/X — RISKY (28/100)
AI training without simple opt-out, broad content license "for any purpose", data shared with advertising partners.

🟡 Spotify — OKAY (62/100)
Shares listening data with advertising partners. No AI training on your playlists. Clear deletion timeline.

✅ Signal — SAFE (100/100)
No data collection. No data selling. No AI training. You own everything you send.
```

---

## Store Screenshots (1280×800 or 640×400)

### Screenshot 1 — Extension Badge on a Privacy Policy Page
- Show: Chrome browser with Twitter Privacy Policy open, TLDR Shield badge visible in bottom-right corner showing **🔴 RISKY 28/100**
- Caption: "Instant rating on any Terms of Service or Privacy Policy"

### Screenshot 2 — Deep Scan Pillar Breakdown in Side Panel
- Show: Chrome side panel open with full deep scan result — 6 pillar rows, confidence dots, verbatim citations
- Caption: "Full pillar breakdown with verbatim citations from the document"

### Screenshot 3 — Extension Popup
- Show: Popup open with Quick/Deep card picker, credit balance, ELI5 and Dark Patterns toggles
- Caption: "Choose Quick (3s) or Deep (15s) scan with optional plain-English mode"

### Screenshot 4 — Dashboard Scan History
- Show: React dashboard at tldr-shield.run.app showing scan history with SAFE/OKAY/RISKY badges, search/filter bar, pillar chips
- Caption: "Full scan history with search, filter, and pillar violation chips"

### Screenshot 5 — GDPR Email Generator
- Show: Side panel showing "Generate Opt-Out Email" flow after a RISKY scan of LinkedIn
- Caption: "One-click GDPR Right to Erasure email for risky services"

---

## Promotional Tile (440×280)

Text overlay: **"Read the fine print. Instantly."**
Sub-text: **SAFE · OKAY · RISKY**
Background: Dark gradient with shield icon

---

## Permissions Justification

| Permission | Reason |
|---|---|
| `activeTab` | Read the current page's text when you trigger a scan |
| `storage` | Store your auth token, preferences (ELI5, Dark Patterns), and API URL |
| `scripting` | Inject the badge into the page after a scan completes |
| `offscreen` | Extract text from PDF privacy policies using pdf.js |
| `sidePanel` | Show full scan results in Chrome's built-in side panel |
| `alarms` | Schedule policy change re-checks (once per day per watched URL) |
| `https://*/*` | Send page text to our analysis server; needed to work on any ToS page |

---

## Privacy Policy URL

`https://tldr-shield-292798741977.us-central1.run.app/privacy`

> **Note:** Create a `/privacy` route on the Express server, or host a static privacy policy page. Required by Chrome Web Store.

---

## Support URL

`https://github.com/Jatin23K/TLDR-Shield/issues`

---

## Homepage URL

`https://tldr-shield-292798741977.us-central1.run.app`

---

## Submission Checklist

- [ ] Privacy policy page created and live at `/privacy`
- [ ] Store screenshots taken (5 required, 1280×800)
- [ ] Promotional tile created (440×280)
- [ ] Developer account verified at `chrome.google.com/webstore/devconsole` ($5 one-time fee)
- [ ] Extension ZIP created: `zip -r tldr-shield-extension.zip extension/` (exclude `node_modules`, `.git`, `eval/`, `src/`, `dist/`)
- [ ] Manifest `version` bumped if needed (currently `2.0.0`)
- [ ] Single-purpose description added (Chrome requires a clear statement of single purpose)
- [ ] Review Chrome Web Store policies for AI-powered extensions
- [ ] Submit for review (typically 1–3 business days)

---

## Single-Purpose Statement (required by Chrome)

> TLDR Shield's single purpose is to analyze Terms of Service and Privacy Policy pages and provide users with a privacy risk rating (SAFE/OKAY/RISKY) with supporting evidence from the document text.
