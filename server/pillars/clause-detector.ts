/**
 * Deterministic clause detector — fires BEFORE trust in the LLM.
 *
 * The problem this solves: both Gemini models can miss clauses that are
 * objectively present. The ensemble helps but shares training-data blind
 * spots. Regex cross-check previously only ran to CONFIRM LLM flags,
 * never to SURFACE new violations the LLM missed.
 *
 * This module scans the full text for high-precision clause patterns. If
 * a pattern matches and the pillar isn't already flagged, the pillar is
 * flagged with HIGH confidence using the matched clause as verbatim
 * citation — the LLM cannot "miss" something regex can prove is there.
 *
 * Design rule: patterns must be HIGH PRECISION. A false positive here
 * flags a clean policy as RISKY — catastrophic for credibility. When in
 * doubt, make the pattern narrower, not wider.
 */

interface ClauseHit {
    pattern: RegExp;
    quote: string;        // the matched text + surrounding sentence context
}

/**
 * Per-pillar clause patterns. Every pattern here should match ONLY when
 * the violation is objectively present. "Forced arbitration" = always a
 * dark pattern. "We use AI" = not necessarily training-on-user-data.
 */
const CLAUSE_PATTERNS: Record<string, RegExp[]> = {
    ai_training: [
        // "use your content to train our AI models"
        /\b(?:use|using|uses)\s+(?:your|user|customer)\s+(?:content|data|information|posts?|uploads?)\s+[^.]{0,80}?(?:to\s+train|for\s+training|to\s+improve|to\s+develop)\s+[^.]{0,40}?(?:ai|a\.i\.|artificial intelligence|machine learning|ml model|model|algorithm|generative)/i,
        // "your content may be used to train"
        /\b(?:your|user|customer)\s+(?:content|data|submissions?)\s+(?:may|will|can|shall)\s+be\s+used\s+[^.]{0,40}?(?:to\s+train|for\s+training|for\s+ai|for\s+model)/i,
        // "we train our models on user data"
        /\bwe\s+train\s+(?:our\s+)?(?:ai\s+|ml\s+)?models?\s+(?:on|using|with)\s+(?:your|user|customer)\s+(?:content|data|information)/i,
    ],
    data_selling: [
        // "sell your personal information" / "sell personal data"
        /\b(?:sell|sells|selling|sold)\s+(?:your|user|customer|consumer)?\s*(?:personal\s+)?(?:data|information|content)\s+(?:to|for)/i,
        // "share with advertisers" / "share data with third parties for ads"
        /\bshare\s+(?:your|user|personal|customer)\s+(?:data|information|identifiers?)\s+with\s+[^.]{0,60}?(?:advertis|marketing\s+partners?|third[- ]part|measurement\s+partners?|data\s+brokers?)/i,
        // CCPA-style: "disclose personal information for monetary consideration"
        /\bdisclose\s+(?:personal|user)\s+information\s+[^.]{0,40}?(?:for\s+(?:monetary|valuable)\s+consideration|in\s+exchange\s+for)/i,
    ],
    content_ownership: [
        // The classic: "non-exclusive, worldwide, royalty-free, sublicensable"
        /\bnon[- ]exclusive[^.]{0,80}?(?:worldwide|sub[- ]?licens|royalty[- ]free|transferable|perpetual)/i,
        // "perpetual license to your content"
        /\bperpetual[^.]{0,30}?(?:licen[sc]e|right)\s+to\s+(?:your|user)\s+content/i,
        // "we may modify, distribute, display your content"
        /\b(?:right|licen[sc]e)\s+to\s+(?:modify|adapt|translate|publicly\s+display|publicly\s+perform|distribute|reproduce)[^.]{0,80}?(?:your|user)\s+content[^.]{0,60}?(?:for\s+any\s+purpose|commercial)/i,
    ],
    dark_patterns: [
        // "class action waiver" in any form
        /\bclass\s+action\s+waiver\b/i,
        /\bwaive[rs]?[^.]{0,30}?(?:right\s+to\s+)?class\s+action/i,
        /\bindividually\s+and\s+not\s+as\s+part\s+of\s+(?:a|any)\s+class/i,
        // "mandatory arbitration" / "binding arbitration required"
        /\b(?:mandatory|binding|compulsory|required)\s+arbitration\b/i,
        /\barbitration\s+(?:is\s+)?(?:mandatory|binding|required|compulsory)/i,
        // "$XX liability cap" or "limit of liability $XX"
        /(?:\$\d{1,3}(?:,\d{3})*|\$\s*\d{1,5})\s+(?:total\s+)?(?:liability\s+cap|limit(?:ation)?\s+of\s+liability|maximum\s+liability)/i,
        /(?:liability\s+(?:is\s+)?(?:limited|capped)\s+(?:to|at))\s+\$\d{1,5}/i,
        // Shortened statute: "must bring claim within X days/months" (< 1 year)
        /\b(?:must\s+(?:bring|file|assert)|claims?\s+must\s+be\s+(?:brought|filed))\s+[^.]{0,40}?within\s+(?:30|60|90|120|180|six|6)\s+(?:days?|months?)/i,
    ],
    data_retention: [
        // "retain indefinitely" / "keep forever"
        /\bretain(?:ed|s)?\s+(?:your\s+|user\s+)?(?:data|information|content)\s+(?:indefinitely|permanently|forever|in perpetuity)/i,
        /\b(?:keep|store)\s+[^.]{0,40}?(?:indefinitely|permanently|forever)/i,
        // "no deletion timeline" — very rare as explicit clause
        /\b(?:do\s+not|don[''']t|does\s+not)\s+(?:have\s+)?(?:a\s+)?(?:data\s+)?(?:deletion|retention)\s+(?:timeline|schedule|period|policy)/i,
    ],
    transparency: [
        // Self-contradictory: "we do not share except when we share"
        /\bwe\s+do\s+not\s+(?:share|sell|disclose)[^.]{0,80}?(?:except|unless|however|provided that)\s+[^.]{0,100}?(?:share|sell|disclose|provide|transfer)/i,
    ],
};

/**
 * Extract a sentence-level quote around a regex match.
 */
function extractClauseQuote(text: string, pattern: RegExp): string {
    const m = text.match(pattern);
    if (!m || m.index === undefined) return '';
    const idx = m.index;
    const sentStart = Math.max(
        text.lastIndexOf('.', idx - 1) + 1,
        text.lastIndexOf('\n', idx - 1) + 1,
        0,
    );
    const dotIdx = text.indexOf('.', idx + m[0].length);
    const sentEnd = dotIdx === -1 ? Math.min(text.length, idx + 200) : dotIdx + 1;
    return text.slice(sentStart, sentEnd).trim().replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Scan text for high-precision clause patterns per pillar. Returns a map
 * of pillar → first matching clause (or null if no pattern matched).
 */
export function detectClauses(text: string): Record<string, ClauseHit | null> {
    const hits: Record<string, ClauseHit | null> = {};
    for (const [pillar, patterns] of Object.entries(CLAUSE_PATTERNS)) {
        hits[pillar] = null;
        for (const pattern of patterns) {
            if (pattern.test(text)) {
                const quote = extractClauseQuote(text, pattern);
                if (quote.length >= 20) {
                    hits[pillar] = { pattern, quote };
                    break;
                }
            }
        }
    }
    return hits;
}

/**
 * Apply deterministic clause detection as a final recall-lift pass.
 *
 * For each pillar where the pipeline ended up CLEAN (violation=false,
 * status != VIOLATES) but a high-precision pattern fires in the source,
 * flag the pillar with HIGH confidence using the matched clause as
 * verbatim citation. This is the "LLM can't skip what regex can prove"
 * guarantee.
 *
 * Does not override existing violations — regex is additive, never
 * contradictory (the LLM finding something extra is fine; denial-veto
 * remains authoritative for explicit denials).
 */
export function applyClauseDetector(
    pillars: Record<string, any>,
    fullText: string,
): number {
    const hits = detectClauses(fullText);
    let promoted = 0;
    for (const [pillar, hit] of Object.entries(hits)) {
        if (!hit) continue;
        const p = pillars[pillar];
        if (!p) continue;
        // Skip if pillar is authoritatively denied (regex veto found explicit denial)
        const status = (p.status || '').toString().toUpperCase();
        if (status === 'EXPLICITLY_DENIES') continue;
        // Skip if already flagged
        if (p.violation) continue;
        // Promote to violation with the regex-matched clause as evidence
        pillars[pillar] = {
            violation: true,
            citation: hit.quote,
            confidence: 'HIGH',
            status: 'VIOLATES',
        };
        promoted++;
    }
    return promoted;
}
