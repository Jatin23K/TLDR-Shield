/**
 * Single source of truth for Gemini keys, model IDs, and key pools.
 *
 * === KEY POOL ARCHITECTURE ===
 * Keys are split into task-dedicated pools. Each key is from a DIFFERENT
 * Google Cloud project, so each has its own independent rate limit (~10 RPM).
 *
 *   SCAN_KEYS    (keys 1-3)  — reserved for main scan analysis
 *   UTILITY_KEYS (keys 4-6)  — citation grounding, embeddings, eval
 *
 * === PRO MODE ===
 * When GEMINI_PRO_MODE=true AND GEMINI_PRO_KEY is set, deep scans use
 * gemini-2.5-pro via the paid key. Everything else stays on free keys.
 *
 * === ENV CONTRACT ===
 * Required (pool-based, preferred):
 *   GEMINI_SCAN_KEY_1..3         — scan pool (3 keys from 3 different projects)
 *   GEMINI_UTIL_KEY_1..3         — utility pool (3 keys from 3 different projects)
 *
 * Legacy (still honored for backward compatibility):
 *   GEMINI_API_KEYS              — comma-separated pool (splits 50/50 into scan/utility)
 *   GEMINI_API_KEY, GEMINI_API_KEY_2..5  — individual keys (splits 50/50)
 *
 * Model selection:
 *   GEMINI_MODEL_SCAN_PRIMARY    — primary scan model   (default: gemini-2.5-flash)
 *   GEMINI_MODEL_SCAN_FALLBACK   — fallback scan model  (default: gemini-3-flash-preview)
 *   GEMINI_MODEL_UTILITY         — citation/utility model (default: gemini-2.5-flash-lite)
 *   GEMINI_EMBED_MODEL           — embedding model       (default: text-embedding-004)
 *
 * Pro mode:
 *   GEMINI_PRO_MODE              — 'true' to enable (default: false)
 *   GEMINI_PRO_KEY               — paid API key for deep scans
 *   GEMINI_PRO_MODEL             — paid model ID (default: gemini-2.5-pro)
 *
 * Legacy aliases (still work):
 *   GEMINI_MODEL_PRIMARY         — alias for SCAN_PRIMARY
 *   GEMINI_MODEL_CORROBORATOR    — ignored in new architecture (ensemble disabled)
 *   GEMINI_MODEL                 — oldest legacy alias
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function pick(envKey: string, fallback: string): string {
    const v = (process.env[envKey] ?? '').trim();
    return v || fallback;
}

// ─── Key Pools ────────────────────────────────────────────────────────────────

function readPoolKeys(prefix: string, count: number): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= count; i++) {
        const v = (process.env[`${prefix}_${i}`] ?? '').trim();
        if (v) keys.push(v);
    }
    return keys;
}

function readLegacyKeys(): string[] {
    // Try comma-separated pool first
    const pool = (process.env.GEMINI_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (pool.length > 0) return pool;
    // Then try individual keys
    return [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY_4,
        process.env.GEMINI_API_KEY_5,
        process.env.GEMINI_API_KEY_6,
    ].filter((k): k is string => Boolean(k && k.trim())).map(k => k.trim());
}

// Try dedicated pool env vars first; fall back to legacy split
const _scanPoolDirect = readPoolKeys('GEMINI_SCAN_KEY', 3);
const _utilPoolDirect = readPoolKeys('GEMINI_UTIL_KEY', 3);

let SCAN_KEYS: string[];
let UTILITY_KEYS: string[];

if (_scanPoolDirect.length > 0 || _utilPoolDirect.length > 0) {
    // In eval/CI: merge SCAN + UTIL into one big scan pool so all 6 keys
    // are used for scanning. This halves the 429 rate-limit pressure.
    // The UTIL/SCAN separation only matters on the live server where
    // utility tasks (grounding, GDPR emails) need their own key budget.
    const allKeys = [..._scanPoolDirect, ..._utilPoolDirect];
    SCAN_KEYS = allKeys;
    UTILITY_KEYS = allKeys; // utility tasks can use any key in eval
} else {
    // Legacy: use all keys for both pools
    const all = readLegacyKeys();
    SCAN_KEYS = all;
    UTILITY_KEYS = all;
}

// Backward compat: GEMINI_KEYS = all keys combined
export const GEMINI_KEYS = [...new Set([...SCAN_KEYS, ...UTILITY_KEYS])];

export { SCAN_KEYS, UTILITY_KEYS };

// ─── Model IDs ────────────────────────────────────────────────────────────────

// Scan models: PRIMARY tried first across all scan keys, then FALLBACK
export const GEMINI_MODEL_SCAN_PRIMARY = pick(
    'GEMINI_MODEL_SCAN_PRIMARY',
    pick('GEMINI_MODEL_PRIMARY', pick('GEMINI_MODEL', 'gemini-2.5-flash')),
);

export const GEMINI_MODEL_SCAN_FALLBACK = pick(
    'GEMINI_MODEL_SCAN_FALLBACK',
    'gemini-3-flash-preview',
);

// Utility model: citation grounding, lighter tasks
export const GEMINI_MODEL_UTILITY = pick(
    'GEMINI_MODEL_UTILITY',
    'gemini-2.5-flash-lite',
);

// Legacy exports — kept so existing code that reads these doesn't break
export const GEMINI_MODEL_PRIMARY = GEMINI_MODEL_SCAN_PRIMARY;
export const GEMINI_MODEL_CORROBORATOR = pick('GEMINI_MODEL_CORROBORATOR', '');

// Adjudicator: kept for API compat but effectively unused in pool architecture
export const GEMINI_MODEL_ADJUDICATOR = pick('GEMINI_MODEL_ADJUDICATOR', '');

// ─── Pro Mode ─────────────────────────────────────────────────────────────────

export const GEMINI_PRO_MODE = (process.env.GEMINI_PRO_MODE ?? '').toLowerCase() === 'true';
export const GEMINI_PRO_KEY  = (process.env.GEMINI_PRO_KEY ?? '').trim();
export const GEMINI_PRO_MODEL = pick('GEMINI_PRO_MODEL', 'gemini-2.5-pro');

// Runtime validation: PRO_MODE without a key is a config error
// Note: PRO_MODE_ACTIVE is a MUTABLE flag — use setProMode() to toggle at runtime
// without restarting the server. The /api/admin/pro-mode endpoint calls this.
let _proModeActive = GEMINI_PRO_MODE && GEMINI_PRO_KEY.length > 0;
export const PRO_MODE_ACTIVE_INITIAL = _proModeActive;

export function isProModeActive(): boolean { return _proModeActive; }
export function setProMode(enabled: boolean): void {
    if (enabled && !GEMINI_PRO_KEY) {
        throw new Error('Cannot enable pro mode: GEMINI_PRO_KEY is not set in .env');
    }
    _proModeActive = enabled;
}
// Legacy export — evaluates at call time via the getter
export { _proModeActive as PRO_MODE_ACTIVE };

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hasGemini(): boolean {
    return GEMINI_KEYS.length > 0;
}

export function describeConfig(): string {
    const parts = [
        `scan_primary=${GEMINI_MODEL_SCAN_PRIMARY}`,
        `scan_fallback=${GEMINI_MODEL_SCAN_FALLBACK}`,
        `utility=${GEMINI_MODEL_UTILITY}`,
        isProModeActive() ? `pro=${GEMINI_PRO_MODEL} (ON)` : 'pro=OFF',
    ].join(' ');
    return `Gemini (${parts}) — scan_keys=${SCAN_KEYS.length} util_keys=${UTILITY_KEYS.length}`;
}
