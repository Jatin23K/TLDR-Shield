// ─── Deterministic Fallback ───────────────────────────────────────────────────
// Extracted from server.ts to reduce monolith size.
// When the LLM completely fails (all keys exhausted, timeout, parse failure),
// this module provides a regex-based best-effort analysis.
// It must err conservative (flag more) — a false positive on fallback is
// preferable to silently missing a real violation.

import { PILLAR_KEYS, calculateScoreAndRating } from '../shared/scoring.js';

// Derived from PILLAR_KEYS — dark_patterns excluded here because it is feature-flagged
// and may not be present in every scan's prompt. Update PILLAR_KEYS to update this.
const FALLBACK_PILLAR_KEYS = PILLAR_KEYS.filter(k => k !== 'dark_patterns');

export function extractEvidenceSnippet(sourceText: string, patterns: RegExp[]): string {
    const text = sourceText.replace(/\s+/g, ' ').trim();
    for (const p of patterns) {
        const match = p.exec(text);
        if (!match || typeof match.index !== 'number') continue;
        const idx = match.index;
        // Expand to nearby sentence boundaries where possible.
        const leftDot = text.lastIndexOf('.', idx);
        const leftSemi = text.lastIndexOf(';', idx);
        const leftBreak = Math.max(leftDot, leftSemi);
        const start = leftBreak >= 0 ? leftBreak + 1 : Math.max(0, idx - 180);

        const after = text.slice(idx);
        const rightDotRel = after.indexOf('.');
        const rightSemiRel = after.indexOf(';');
        const rightBreakRel = [rightDotRel, rightSemiRel].filter(v => v >= 0).sort((a, b) => a - b)[0];
        const end = rightBreakRel !== undefined ? Math.min(text.length, idx + rightBreakRel + 1) : Math.min(text.length, idx + 220);

        const snippet = text.slice(start, end).trim();
        if (snippet.length >= 24) return snippet.slice(0, 300);
    }
    return 'Not addressed in document.';
}

export function buildDeterministicDeepFallback(
    sourceText: string,
    darkPatternsEnabled: boolean,
    failureReason: string,
): any {
    const patterns: Record<string, RegExp[]> = {
        ai_training: [
            /\b(train(?:ing)?|fine[-\s]?tune|machine learning|artificial intelligence|AI models?)\b.{0,120}\b(user|your|customer)\b.{0,120}\b(data|content|interactions|prompts|uploads)\b/i,
            /\b(user|your|customer)\b.{0,120}\b(data|content|interactions|prompts|uploads)\b.{0,120}\b(train(?:ing)?|improve)\b.{0,80}\b(machine learning|AI|models?)\b/i,
        ],
        data_selling: [
            /\b(sell|selling|share|sharing|disclose|disclosing)\b.{0,140}\b(data|information|content)\b.{0,140}\b(advertis|partner|third[-\s]?part|affiliate|commercial)\b/i,
            /\b(advertising partners?|analytics partners?|third[-\s]?party)\b/i,
            /\b(use|using)\b.{0,80}\bdata\b.{0,80}\b(personalization|advertising|measurement|commercial)\b/i,
        ],
        transparency: [
            /\b(including but not limited to|from time to time|at our sole discretion|for any purpose)\b/i,
            /\bwe may collect other information\b/i,
        ],
        data_retention: [
            /\bretain(?:ed|ing)?\b.{0,120}\b(indefinite|indefinitely|forever|perpetual)\b/i,
            /\bretain(?:ed|ing)?\b.{0,120}\b\d+\s*(year|years)\b/i,
            /\bafter (?:account )?deletion\b.{0,120}\b(month|months|year|years)\b/i,
        ],
        content_ownership: [
            /\blicense\b.{0,180}\b(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free)\b/i,
            /\b(worldwide|perpetual|irrevocable|sublicensable|transferable|royalty[-\s\u2010-\u2015]?free)\b.{0,180}\blicense\b/i,
            /\b(create|prepare|preparation of|modify)\b.{0,80}\bderivative works\b/i,
            /\bfor any purpose\b/i,
        ],
        dark_patterns: [
            /\b(class action waiver|waive.*class action)\b/i,
            /\b(binding individual arbitration|forced arbitration)\b/i,
            /\bliability\b.{0,30}\$\s?\d{1,4}\b/i,
            /\bstatute of limitations\b.{0,60}\b(1|one)\s*year\b/i,
        ],
    };

    // Fix #17: In a DEGRADED (fallback) scan, we never actually read the document
    // with the LLM. Regex-only hits are circumstantial — always mark LOW so Fix #4's
    // "LOW = zero penalty" rule prevents double-counting on a best-effort scan.
    const pillars: Record<string, any> = {};
    for (const key of FALLBACK_PILLAR_KEYS) {
        const citation = extractEvidenceSnippet(sourceText, patterns[key] ?? []);
        const violation = citation !== 'Not addressed in document.';
        pillars[key] = {
            violation,
            citation,
            confidence: 'LOW', // Fix #17: degraded fallback is never high-trust
        };
    }

    if (darkPatternsEnabled) {
        const citation = extractEvidenceSnippet(sourceText, patterns.dark_patterns ?? []);
        const violation = citation !== 'Not addressed in document.';
        pillars.dark_patterns = {
            violation,
            citation,
            confidence: 'LOW', // Fix #17
        };
    }

    const activeKeys = Object.keys(pillars).filter((k) => pillars[k]?.violation);

    // ── FALLBACK SCORING: treat the two cases very differently ───────────────
    // Case A — violations FOUND by regex: use normal scoring (these are real red flags)
    // Case B — NO violations found: do NOT apply silence penalties.
    //   The LLM failed, so we never actually read the document. Punishing it with
    //   -12 × 6 = -72 for "silence" would wrongly make a clean policy like DuckDuckGo
    //   score the same as Twitter (which had real, LLM-confirmed violations).
    //   Instead: start at a neutral "benefit of the doubt" baseline and boost it
    //   if the text contains explicit privacy-protective language.
    let score: number;
    let rating: 'SAFE' | 'OKAY' | 'RISKY';
    let deductions: any[];
    let tldr: string;

    if (activeKeys.length > 0) {
        // Real violations detected by regex → normal scoring
        const calc = calculateScoreAndRating(pillars, 'deep');
        score = calc.score;
        rating = calc.rating;
        deductions = calc.deductions;
        tldr = `AI analysis was partially unavailable. Regex patterns detected potential risks in: ${activeKeys.join(', ')}. Manual review recommended.`;
    } else {
        // No violations detected → give benefit of the doubt
        // Check for explicit positive privacy signals (e.g. "we don't sell data")
        const POSITIVE_SIGNALS = [
            /we (don't|do not|never) (sell|share|track|collect|disclose)\b/i,
            /never sell.{0,50}(data|information|personal)/i,
            /do not (track|sell|share) your/i,
            /not (sell|share|disclose).{0,50}(third part|advertis)/i,
            /privacy (is|by design|first|focused)/i,
            /we (collect|use) (minimal|as little|only what)/i,
            /we don't collect personal/i,
        ];
        const hasPositiveSignals = POSITIVE_SIGNALS.some(p => p.test(sourceText));

        // Score: 75 if policy is explicitly privacy-protective, 60 if just clean/neutral
        // Neither is SAFE — the LLM didn't confirm it, so we stay at OKAY.
        score = hasPositiveSignals ? 75 : 60;
        rating = 'OKAY';
        deductions = [{ reason: 'AI analysis unavailable — fallback scan found no violations but full audit could not be completed', points: hasPositiveSignals ? 25 : 40 }];
        tldr = hasPositiveSignals
            ? 'No high-risk clauses detected. This policy contains explicit privacy protections ("we don\'t sell/track you"). AI deep-analysis was unavailable — full confidence requires a manual re-scan.'
            : 'AI analysis was unavailable. No explicit violation patterns were found in the text. This is an automated fallback — re-scan for a full AI verdict.';
    }

    return {
        rating,
        score,
        tldr,
        pillars,
        deductions,
        degraded: true,
        fallbackReason: failureReason.slice(0, 200),
    };
}
