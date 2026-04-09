# TLDR Shield — Implementation Plans

---

## Multi-Agent Plans

### A1: Parallel Pillar Analysis
- 6 agents × 6 pillars analyzed simultaneously
- Major refactor of `analyzeChunk`
- **Do after:** core product is stable

### A2: Parallel Eval Tiers
- Quick + deep tiers run simultaneously instead of sequentially
- Zero effort to implement
- **Do:** next session

### A3: Parallel Golden Tests
- 5 agents × 5 test cases run in parallel
- **Do:** next session

### A4: Multi-Model Ensemble
- 2 models with a judge agent to reconcile results
- **Sprint:** future sprint

---

## Agent SDK Plans

### U1: Policy Monitor Agent
- Re-scans URLs on a schedule, notifies user if rating changes
- Daily Cloud Run job
- **Sprint:** future sprint

### U2: Interactive Explainer
- Chat interface to discuss scan results
- Low build cost
- **Sprint:** next sprint

### U3: Eval Regression CI
- Auto-runs eval suite on every PR
- GitHub Actions
- **Sprint:** next sprint

---

## Scheduling Plans

### SC1: NIM Key Health Check
- Runs every 6 hours
- GitHub Actions
- **Do:** next session

### SC2: Daily Golden Test Suite
- Runs at 6am daily
- GitHub Actions
- **Do:** next session

### SC3: Weekly Dependency Audit
- Runs every Monday
- Read-only audit, no auto-fixes
- GitHub Actions

### SC4: Weekly Scan Analytics
- Runs every Monday morning
- Firestore query for scan volume, rating distribution, cache hit rate
- GitHub Actions

---

## MCP Plans

### M1: Firestore MCP
- Integrate when available or needed for direct DB inspection

### M2: GitHub MCP
- Integrate when collaborating with others on the repo

### M3: Playwright (already installed)
- Create an extension-testing skill next session to automate Chrome Extension UI tests
