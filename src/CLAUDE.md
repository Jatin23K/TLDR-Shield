# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Component: React Web App

Single-page React 19 app — landing page + scan history dashboard. Built by Vite, served by the Express backend in dev (Vite middleware mode on `:3000`).

## Commands

```bash
npm run dev      # Start full-stack dev server (Express + Vite HMR on :3000)
npm run build    # Vite production build → dist/
npm run lint     # TypeScript type-check only (no emit)
```

## Files

| File | Role |
|------|------|
| `src/App.tsx` | Entire app — landing page, scan history dashboard, all UI components |
| `src/firebase.ts` | Firebase client init, `signIn`/`signOut` helpers, `handleFirestoreError` utility |
| `src/main.tsx` | React entry point, mounts `<App />` |
| `src/index.css` | Tailwind base + global styles |
| `index.html` | Vite entry HTML |

## Architecture

`App.tsx` is a single large file containing all UI. The two logical pages are controlled by a `Page` state (`'landing' | 'history'`):

- **Landing** — hero, feature cards, pricing, install CTA
- **History** — real-time Firestore subscription showing the current user's scans, with delete and detail expansion

**Auth flow**: Firebase Google sign-in via popup (`signInWithPopup`). After sign-in, the web app broadcasts `STORE_AUTH` to the Chrome extension (via `window.postMessage` → content script → `chrome.runtime.sendMessage`) so the extension can attach Bearer tokens to backend calls.

**Scan history** — subscribes to `/scans` collection filtered by `uid` + ordered by `createdAt desc` using `onSnapshot` (live updates). Each record shows rating badge, score ring, TLDR, tier, and expandable pillar breakdown.

## Design System

All three rating states share the same token shape in the `rating` constant at the top of `App.tsx`:

```ts
rating.SAFE  → emerald-500 palette
rating.OKAY  → amber-500 palette
rating.RISKY → rose-500 palette
```

`ScoreRing` is an inline SVG circle that animates `stroke-dashoffset` from 0 to the filled amount. Color is derived from the rating.

Animations use `motion/react` (Framer Motion). Use `<AnimatePresence>` around conditional elements; use `<motion.div>` with `initial / animate / exit` for transitions.

Icons are from `lucide-react` — import only what is used.

## Firebase (client-side)

`src/firebase.ts` initialises the Firebase app from `firebase-applet-config.json` (checked in, non-secret). Exports:

- `auth` — Firebase Auth instance
- `db` — Firestore instance (uses `firestoreDatabaseId` from config, not `(default)`)
- `signIn()` — Google popup sign-in
- `signOut()` — sign-out
- `handleFirestoreError()` — removed (was unused dead code)

The Firestore database ID is **not** `(default)` — always use the `db` export from `firebase.ts`, never call `getFirestore()` directly.

## TypeScript

`tsconfig.json` targets ES2022, strict mode. Path alias `@/` maps to the project root. The lint command (`npm run lint`) only type-checks — it does not emit files.
