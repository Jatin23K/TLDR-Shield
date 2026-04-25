// prominence.ts
// CREDIBILITY FIX #8 — Citation prominence weighting.
//
// A violation buried in line 12,000 under heavy legalese is less "owned" by the
// publisher than one printed in ALL CAPS under a bold section heading. Both
// are legally binding, but prominence tells us how confident we should be that
// the drafter INTENDED this term and that a court would uphold it cleanly.
//
// This module scores a citation 0-100 on prominence signals extracted from the
// surrounding text context. The score adjusts the numeric confidenceScore:
//   high prominence (70+) →  +5 to confidence (signal is loud, uphold-worthy)
//   low prominence  (<30) →  −5 to confidence (buried — possible boilerplate drift)
//
// Signals:
//   +25  citation (or nearby line) is mostly UPPERCASE (ALL-CAPS enforcement clause)
//   +20  citation is near a numbered section heading (e.g. "17.3 ARBITRATION")
//   +20  citation is near a legal heading keyword (ARBITRATION, LIABILITY, LICENSE,
//        RETENTION, ADVERTISING, AI/MACHINE LEARNING, GOVERNING LAW, WARRANTY)
//   +15  citation line starts with a bullet / number / bold marker (standalone)
//   -20  citation length < 40 chars (fragment) — probably pulled out of context
//   -15  citation is deep (>75% through the document) AND no heading signals

export interface ProminenceResult {
    score: number;          // 0-100
    signals: string[];      // human-readable debug tags
}

const HEADING_KEYWORDS = [
    /\barbitration\b/i,
    /\bclass\s+action\b/i,
    /\bliability\b/i,
    /\blimitation\s+of\s+liability\b/i,
    /\blicense\s+grant\b/i,
    /\buser\s+content\b/i,
    /\bcontent\s+license\b/i,
    /\bintellectual\s+property\b/i,
    /\badvertising\b/i,
    /\bretention\b/i,
    /\bdata\s+retention\b/i,
    /\bdeletion\b/i,
    /\bartificial\s+intelligence\b/i,
    /\bmachine\s+learning\b/i,
    /\bai\s+training\b/i,
    /\btraining\s+(?:of\s+)?(?:our\s+)?(?:ai|models)\b/i,
    /\bgoverning\s+law\b/i,
    /\bdispute\s+resolution\b/i,
    /\bwarrant(?:y|ies)\b/i,
    /\bthird[-\s]party\b/i,
    /\badvertising\s+partners?\b/i,
];

// Numbered section heading pattern: "17.", "17.3", "17.3.1", "SECTION 17", "§ 17"
const NUMBERED_HEADING = /(?:^|\n)\s*(?:section\s+)?(?:§\s*)?\d+(?:\.\d+){0,3}\.?\s+[A-Z]/;

/**
 * Score how prominent a citation is within the full document.
 * Returns 0-100 where higher = more prominent (section header, caps, etc.).
 */
export function computeProminence(citation: string, fullText: string): ProminenceResult {
    const signals: string[] = [];
    let score = 50; // neutral baseline

    if (!citation || typeof citation !== 'string' || citation.length < 10) {
        return { score: 30, signals: ['no_citation_or_too_short'] };
    }

    const cit = citation.trim();
    const citLower = cit.toLowerCase();

    // Locate citation in full text (fuzzy — first 80 chars match)
    const probe = cit.substring(0, Math.min(80, cit.length));
    const idx = fullText.toLowerCase().indexOf(probe.toLowerCase());

    // Extract ±400-char context window if found
    let context = cit;
    let position = -1;
    if (idx >= 0) {
        position = idx;
        const start = Math.max(0, idx - 400);
        const end = Math.min(fullText.length, idx + cit.length + 200);
        context = fullText.substring(start, end);
    }

    // Signal 1: UPPERCASE enforcement
    const letters = cit.replace(/[^A-Za-z]/g, '');
    const upperLetters = cit.replace(/[^A-Z]/g, '');
    const upperRatio = letters.length > 0 ? upperLetters.length / letters.length : 0;
    if (upperRatio > 0.6 && letters.length > 20) {
        score += 25;
        signals.push('all_caps');
    }

    // Signal 2: numbered section heading nearby
    if (NUMBERED_HEADING.test(context)) {
        score += 20;
        signals.push('numbered_heading');
    }

    // Signal 3: heading keyword nearby
    const headingHit = HEADING_KEYWORDS.find((rx) => rx.test(context));
    if (headingHit) {
        score += 20;
        signals.push(`heading_keyword:${headingHit.source.substring(0, 24)}`);
    }

    // Signal 4: standalone line (bullet / number / bold marker at line start)
    const lineStart = /(?:^|\n)\s*(?:[\-•*]|\d+[.)]|[A-Z]\.)\s/;
    if (idx >= 0) {
        const preceding = fullText.substring(Math.max(0, idx - 80), idx);
        if (lineStart.test('\n' + preceding + cit.substring(0, 10))) {
            score += 15;
            signals.push('standalone_bullet');
        }
    }

    // Signal 5: fragment penalty
    if (cit.length < 40) {
        score -= 20;
        signals.push('short_fragment');
    }

    // Signal 6: deep-in-doc penalty (no heading signals + buried)
    if (position >= 0 && fullText.length > 0) {
        const depthRatio = position / fullText.length;
        if (depthRatio > 0.75 && !signals.some(s => s.startsWith('heading') || s === 'numbered_heading' || s === 'all_caps')) {
            score -= 15;
            signals.push('buried_deep');
        }
    }

    // Clamp to 0-100
    score = Math.max(0, Math.min(100, score));
    return { score, signals };
}

/**
 * Apply prominence weighting to a pillars object. Mutates p.prominenceScore
 * and nudges p.confidenceScore based on prominence.
 *
 * Safety rails:
 *   - Never flips violation/status
 *   - Never touches NOT_APPLICABLE or NOT_MENTIONED pillars
 *   - Bounded ±5 confidence adjustment
 */
export function applyProminenceWeighting(
    pillars: Record<string, any>,
    fullText: string,
): void {
    if (!pillars || !fullText) return;

    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p) continue;

        const status = (p.status || '').toString().toUpperCase();
        // Only weight pillars with actual claimed evidence.
        if (status === 'NOT_APPLICABLE' || status === 'NOT_MENTIONED') continue;

        const cit = (p.citation || '').toString().trim();
        if (!cit || cit.length < 10) continue;

        const { score, signals } = computeProminence(cit, fullText);
        p.prominenceScore = score;
        p.prominenceSignals = signals;

        // Nudge confidenceScore if present (±5, clamped)
        if (typeof p.confidenceScore === 'number') {
            if (score >= 70) {
                p.confidenceScore = Math.min(100, p.confidenceScore + 5);
            } else if (score < 30) {
                p.confidenceScore = Math.max(0, p.confidenceScore - 5);
            }
        }
    }
}
