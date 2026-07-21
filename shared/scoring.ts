/**
 * SINGLE SOURCE OF TRUTH for pillar scoring constants and functions.
 *
 * Imported by:
 *   - server.ts         (production scoring)
 *   - eval/runEval.ts   (eval harness scoring)
 *
 * If you change values here, BOTH consumers get the update automatically.
 * No manual sync needed.
 */

// ─── Pillar Keys ──────────────────────────────────────────────────────────────
export const PILLAR_KEYS = [
    'ai_training',
    'data_selling',
    'transparency',
    'data_retention',
    'content_ownership',
    'dark_patterns',
] as const;

export type PillarKey = (typeof PILLAR_KEYS)[number];

// ─── Per-Pillar Score Penalties ───────────────────────────────────────────────
//   full = HIGH/MEDIUM confidence deduction
//   low  = LOW confidence deduction (half rate — penalises hallucination less)
export const PILLAR_PENALTY: Record<string, { full: number; low: number }> = {
    ai_training:       { full: 15, low:  8 },
    data_selling:      { full: 15, low:  8 },
    data_retention:    { full: 15, low:  8 },
    content_ownership: { full: 15, low:  8 },
    dark_patterns:     { full: 20, low: 10 }, // elevated: removes legal rights
    transparency:      { full: 10, low:  5 }, // self-contradictory only
};

// ─── Score Calculation ────────────────────────────────────────────────────────
/**
 * Compute score, rating, and deductions from pillar violation flags.
 *
 * This is the CANONICAL scoring function used by both the production server
 * and the eval harness. Do NOT create parallel implementations.
 */
export function calculateScoreAndRating(
    pillars: Record<string, any>,
    tier: 'quick' | 'deep' = 'deep',
    textLength: number = 5000,
): { score: number; rating: 'SAFE' | 'OKAY' | 'RISKY'; deductions: any[] } {
    let score = 100;
    const deductions: any[] = [];
    const activeKeys = Object.keys(pillars).filter((k) => pillars[k]?.violation);

    for (const key of activeKeys) {
        // Fix #7: transparency is informational-only — the pillar appears in results
        // but never contributes to the score. Keyword/regex detection of "self-
        // contradictory language" is too unreliable for automated scoring.
        if (key === 'transparency') {
            deductions.push({ reason: 'Transparency flag (informational — not scored)', points: 0 });
            continue;
        }
        const penalty = PILLAR_PENALTY[key] ?? { full: 30, low: 15 };
        const confidence = (pillars[key]?.confidence ?? 'MEDIUM').toUpperCase();
        if (confidence === 'LOW') {
            // LOW confidence = violation found but citation unverifiable (paraphrased/missing).
            // Apply reduced penalty (penalty.low) instead of 0 — the LLM saw something real,
            // the citation just couldn't be grounded verbatim. Half-penalty prevents 100/100 SAFE
            // on documents that clearly contain violations.
            const lowPoints = penalty.low ?? Math.floor(penalty.full / 2);
            score -= lowPoints;
            deductions.push({ reason: `Low-confidence flag in ${key.replace(/_/g, ' ')} (reduced penalty)`, points: lowPoints });
            continue;
        }
        const points = penalty.full;
        const reason = `Flagged risk in ${key.replace(/_/g, ' ')}`;
        score -= points;
        deductions.push({ reason, points });
    }

    // Floor at 5 — 0/100 looks like a broken/errored result to users.
    score = Math.max(5, Math.min(100, score));

    // Score-based rating bands (score is the single source of truth)
    let rating: 'SAFE' | 'OKAY' | 'RISKY' = 'SAFE';
    if (score < 50) {
        rating = 'RISKY';
    } else if (score < 90) {
        rating = 'OKAY';
    } else {
        rating = 'SAFE';
    }

    return { score, rating, deductions };
}

/**
 * Compute score from pillar flags only (simplified version for eval).
 * Returns null if pillars is invalid.
 */
export function computeScoreFromPillars(pillars: Record<string, any> | null | undefined): number | null {
    if (!pillars || typeof pillars !== 'object') return null;
    const { score } = calculateScoreAndRating(pillars);
    return score;
}
