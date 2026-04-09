---
name: extension-reload
description: Post-edit reminder after any extension/ file changes. Determines what reload action is needed based on which file changed.
user-invocable: true
---

# Extension Reload Skill

After editing any file under `extension/`, run this to determine the correct reload action. The wrong reload wastes time or silently leaves old code running.

## Reload decision table

| File changed | Reload action required |
|---|---|
| `content.js` | Reload extension → **refresh the tab** (content scripts don't re-inject on extension reload alone) |
| `background.js` | Reload extension (kills service worker + restarts it) |
| `popup.html` / `popup.js` | Reload extension → close and reopen popup |
| `content.css` | Reload extension → **refresh the tab** |
| `offscreen.html` / `offscreen.js` | Reload extension (offscreen doc is recreated on next PDF scan) |
| `manifest.json` | **Full remove + re-add** (see below) |
| `lib/*.js` / `lib/*.mjs` | Reload extension → refresh the tab if content-facing |

## How to reload the extension

1. Open `chrome://extensions`
2. Find the **TLDR Shield** card
3. Click the circular reload icon (↺)

That's it for most file changes.

## When manifest.json changes require full remove + re-add

Any change to `manifest.json` that adds, removes, or modifies **permissions, host_permissions, content_scripts, or background service_worker** requires a full remove and re-add:

1. Click **Remove** on the TLDR Shield card
2. Click **Load unpacked**
3. Select the `extension/` directory

**Why:** Chrome caches permission grants and content script registrations from the manifest. A simple reload does not re-read these fields.

## background.js — kills active scans

Reloading the extension **terminates the service worker immediately**. Any in-progress scan (SSE stream from the server) is abandoned — the stream stays open server-side until it times out, but the result is never delivered to the badge.

Before reloading the extension:
- Wait for any active scan to finish, OR
- Accept that the in-progress scan will be lost and credits will not be refunded (the server already deducted them before the reload)

## content.js — tab refresh required

After reloading the extension, existing tabs still run the **old** content script. To get the new code:

- Reload (F5) any tab where the badge is visible or where you're testing detection
- New tabs opened after extension reload will automatically get the new content script

## Quick reference

```
Changed extension/content.js?
  → Reload extension → Refresh tab

Changed extension/background.js?
  → Reload extension (new service worker starts automatically)

Changed extension/popup.js or popup.html?
  → Reload extension → Close and reopen the popup

Changed extension/manifest.json?
  → Remove extension → Load unpacked → Select extension/ dir

Changed extension/content.css?
  → Reload extension → Refresh tab

Changed extension/offscreen.js?
  → Reload extension (takes effect on next PDF scan)
```

## Verifying the reload worked

- **background.js**: Open `chrome://extensions` → click "Service Worker" link → check console for startup logs
- **content.js**: Open DevTools on the test tab → Console tab → look for TLDR Shield log output
- **popup.js**: Open popup → DevTools (right-click popup → Inspect) → Console tab
