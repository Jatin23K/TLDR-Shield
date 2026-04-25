/**
 * Gemini API Key Quota Checker
 *
 * Probes every key in GEMINI_API_KEYS against both GEMINI_MODEL_PRIMARY and
 * GEMINI_MODEL_CORROBORATOR with a single minimal request (1 input +
 * 1 output token). Parses 429 error details to distinguish:
 *   - RPM throttle (requests-per-minute ceiling hit — recovers in 60s)
 *   - RPD exhaustion (requests-per-day exhausted — recovers at 00:00 PT)
 *
 * Output: a clean grid showing each key's status per model so you can see
 * at a glance how much headroom is left for each model today.
 *
 * Cost: 10 requests total (5 keys × 2 models), each using ~5 tokens.
 * Won't meaningfully impact your daily budget.
 *
 * Run: npm run check:gemini
 */

import dotenv from 'dotenv';
dotenv.config();

import { GEMINI_KEYS, GEMINI_BASE, GEMINI_MODEL_PRIMARY, GEMINI_MODEL_CORROBORATOR } from './geminiConfig.js';

const BASE = GEMINI_BASE;
const TIMEOUT = 15_000;

// Probe whichever two models the config selects. These are the ones the scan
// pipeline actually uses, so this check reflects real available headroom.
const MODELS = [
    { id: GEMINI_MODEL_PRIMARY,      label: `PRIMARY (${GEMINI_MODEL_PRIMARY})` },
    { id: GEMINI_MODEL_CORROBORATOR, label: `CORROBORATOR (${GEMINI_MODEL_CORROBORATOR})` },
] as const;

const KEYS = GEMINI_KEYS
    .map((key, i) => ({ label: `KEY_${i + 1}`, key }))
    .filter(k => k.key.length > 10);

type ProbeResult =
    | { kind: 'ok';   ms: number }
    | { kind: 'rpm';  detail: string; ms: number }   // per-minute throttle (retry soon)
    | { kind: 'rpd';  detail: string; ms: number }   // per-day exhausted (retry tomorrow)
    | { kind: 'invalid_key';   ms: number }
    | { kind: 'not_found';     ms: number }          // model unavailable on this key
    | { kind: 'other'; status: number; detail: string; ms: number };

/**
 * Makes one minimal probe call. Returns a parsed result — on 429 it inspects
 * the error body for quota metadata so we can tell RPM from RPD.
 */
async function probe(apiKey: string, modelId: string): Promise<ProbeResult> {
    const url = `${BASE}/models/${modelId}:generateContent?key=${apiKey}`;
    const body = {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1 },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const ms = Date.now() - t0;

        if (res.ok) return { kind: 'ok', ms };

        const text = await res.text().catch(() => '');
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

        if (res.status === 401 || res.status === 403) return { kind: 'invalid_key', ms };
        if (res.status === 404) return { kind: 'not_found', ms };

        if (res.status === 429) {
            // Gemini 429 response includes details[].violations[].quotaId, which
            // names the exact quota bucket that's full. RPD buckets contain
            // "PerDay"; RPM buckets contain "PerMinute".
            const details: any[] = parsed?.error?.details ?? [];
            let quotaHit = '';
            for (const d of details) {
                const violations = d?.violations ?? [];
                for (const v of violations) {
                    if (v?.quotaId) { quotaHit = String(v.quotaId); break; }
                }
                if (quotaHit) break;
            }
            const isRpd = /PerDay|perday/i.test(quotaHit) || /day/i.test(parsed?.error?.message ?? '');
            const isRpm = /PerMinute|perminute/i.test(quotaHit) || /minute/i.test(parsed?.error?.message ?? '');
            if (isRpd && !isRpm) return { kind: 'rpd', detail: quotaHit || parsed?.error?.message || '', ms };
            if (isRpm && !isRpd) return { kind: 'rpm', detail: quotaHit || parsed?.error?.message || '', ms };
            // Ambiguous — default to RPM since daily cap is rarer and per-minute is common
            return { kind: 'rpm', detail: quotaHit || parsed?.error?.message || '429', ms };
        }

        return { kind: 'other', status: res.status, detail: parsed?.error?.message ?? text.slice(0, 120), ms };
    } catch (err: any) {
        clearTimeout(timer);
        const ms = Date.now() - t0;
        if (err?.name === 'AbortError') return { kind: 'other', status: 408, detail: 'timeout', ms };
        return { kind: 'other', status: 0, detail: err?.message ?? 'network error', ms };
    }
}

function formatCell(r: ProbeResult): string {
    switch (r.kind) {
        case 'ok':          return `\x1b[32m✅ OK\x1b[0m (${r.ms}ms)`;
        case 'rpm':         return `\x1b[33m⏱  RPM throttle\x1b[0m — retry in 60s`;
        case 'rpd':         return `\x1b[31m🛑 RPD EXHAUSTED\x1b[0m — resets 00:00 PT`;
        case 'invalid_key': return `\x1b[31m✗ INVALID KEY\x1b[0m`;
        case 'not_found':   return `\x1b[90m— model not available\x1b[0m`;
        case 'other':       return `\x1b[31m✗ HTTP ${r.status}\x1b[0m ${r.detail.slice(0, 40)}`;
    }
}

(async () => {
    console.log('\nGemini Quota Checker');
    console.log('═'.repeat(70));

    if (KEYS.length === 0) {
        console.error('No Gemini keys found in .env. Set GEMINI_API_KEYS=key1,key2,... (or legacy GEMINI_API_KEY_1..5).');
        process.exit(1);
    }

    console.log(`Probing ${KEYS.length} key(s) against ${MODELS.length} model(s)...\n`);

    // Fire all probes in parallel — single request per (key, model) combo
    // so burning ~10 requests doesn't meaningfully move the needle.
    const grid = await Promise.all(
        KEYS.map(async ({ label, key }) => {
            const results = await Promise.all(MODELS.map(m => probe(key, m.id)));
            return { label, results };
        })
    );

    // Header
    const keyCol = 8;
    const modelCol = 44;
    const header = 'Key'.padEnd(keyCol) + MODELS.map(m => m.label.padEnd(modelCol)).join('');
    console.log(header);
    console.log('─'.repeat(keyCol + modelCol * MODELS.length));

    // Rows
    for (const row of grid) {
        const line = row.label.padEnd(keyCol) +
            row.results.map(r => formatCell(r).padEnd(modelCol + 10 /* ansi codes */)).join('');
        console.log(line);
    }

    // Summary
    console.log('\n' + '═'.repeat(70));
    for (const [idx, model] of MODELS.entries()) {
        const results = grid.map(g => g.results[idx]);
        const ok = results.filter(r => r.kind === 'ok').length;
        const rpm = results.filter(r => r.kind === 'rpm').length;
        const rpd = results.filter(r => r.kind === 'rpd').length;
        const bad = results.length - ok - rpm - rpd;
        const health = ok === results.length ? '✅' : rpd > 0 ? '🛑' : rpm > 0 ? '⏱' : '⚠️';
        console.log(`${health} ${model.label.padEnd(18)} — ${ok} healthy, ${rpm} RPM-throttled, ${rpd} RPD-exhausted, ${bad} other`);
    }

    const anyRpd = grid.some(g => g.results.some(r => r.kind === 'rpd'));
    if (anyRpd) {
        // Compute hours until midnight Pacific Time from now
        const now = new Date();
        // PDT = UTC-7 in April 2026 (daylight saving active)
        const ptOffsetHours = 7;
        const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
        const ptHours = (utcHours - ptOffsetHours + 24) % 24;
        const hoursUntilReset = (24 - ptHours).toFixed(1);
        console.log(`\n⏰ RPD resets in ~${hoursUntilReset}h (midnight PT / 12:30 PM IST).`);
    }
    if (grid.every(g => g.results.every(r => r.kind === 'ok'))) {
        console.log('\nAll keys healthy across both models. You have full daily headroom.');
    }
    console.log();
})();
