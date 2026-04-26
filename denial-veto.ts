/**
 * applyDenialVeto — explicit denial override for pillar violations.
 *
 * When a policy explicitly states "we do NOT sell / track / train AI", that
 * absolute denial overrides any LLM flag or keyword-based promotion.
 *
 * Rules:
 * - Only absolute denials veto ("we do not", "we never", "will not", "does not").
 * - Opt-out language ("you may opt out of") does NOT veto — it confirms the
 *   practice IS happening, just with an opt-out.
 * - Each denial phrase is mapped to the specific pillar it refutes.
 *
 * Extended (Fix #5): now covers all six pillars so a clean policy like
 * DuckDuckGo or Signal reliably hard-locks every pillar to SAFE.
 */

const DENIAL_PATTERNS: Record<string, RegExp[]> = {
    data_selling: [
        /we do not sell\b/i,
        /we never sell\b/i,
        /we do not share.*(?:personal|user)\s*(?:data|information)/i,
        /we never share.*(?:personal|user)\s*(?:data|information)/i,
        /(?:personal|user)\s*(?:data|information).*(?:is not|are not|will not be)\s*sold/i,
        /does not sell\b/i,
        /will not sell\b/i,
        /not.*sell or share.*(?:personal|user)/i,
        /we don't sell\b/i,
        /we don't share.*(?:personal|user)\s*(?:data|information)/i,
        /no personal (?:data|information) (?:is|are) (?:shared|sold)/i,
    ],
    ai_training: [
        /do not use.*(?:data|content|information).*(?:to train|for training|for ai|for machine learning)/i,
        /never use.*(?:data|content).*(?:to train|for training)/i,
        /(?:data|content|information).*(?:is not|will not be|are not)\s*used.*(?:to train|for training|for ai)/i,
        /will not.*(?:train|use.*for ai|use.*for machine learning)/i,
        /(?:do not|does not|will not).*train.*(?:ai|artificial intelligence|machine learning|model)/i,
        /not.*used to train/i,
        /we don't use.*(?:data|content).*(?:to train|for training)/i,
        /we do not train (?:ai|ml|our models)/i,
    ],
    // Fix #5 additions ────────────────────────────────────────────────────────
    data_retention: [
        /data (?:is|are) deleted within (\d+) days/i,   // explicit timeline ≤1yr
        /deleted within \d+ (?:days?|weeks?|months?) of account (?:deletion|closure|termination)/i,
        /we do not retain (?:personal|user)?\s*(?:data|information) after/i,
        /we never retain.*(?:indefinitely|permanently)/i,
        /no personal (?:data|information) is retained after/i,
        /retain.*only.*(?:necessary|required) (?:to|for)/i,  // GDPR-standard retention
        // DuckDuckGo-style retention denials ─────────────────────────────────
        /limits?\s+(?:data\s+)?retention\s+to\s+(?:the\s+)?(?:duration|time|period)\s+necessary/i,
        /(?:retain|keep|store).*(?:only\s+)?(?:as\s+long\s+as|for\s+as\s+long\s+as|for\s+the\s+time)\s+necessary/i,
        /(?:data|information)\s+(?:is|are|will be)\s+retained\s+(?:only\s+)?(?:for|as long as)\s+(?:as long as\s+)?necessary/i,
        /we (?:do not|don't) (?:keep|store|retain).*(?:longer than|beyond what is) necessary/i,
        /(?:minimum|shortest) (?:retention|storage) period/i,
    ],
    content_ownership: [
        /you retain (?:full )?ownership/i,
        /you own (?:all )?(?:your )?content/i,
        /we (?:do not|don't) claim (?:any )?(?:intellectual property|ownership|rights) (?:over|to)/i,
        /we claim no (?:intellectual property|ownership|rights)/i,
        /(?:your content|user content).*remains? (?:your|yours)/i,
        /license.*only.*(?:to display|to operate|to provide).*(?:service|you)/i,
    ],
    dark_patterns: [
        /we (?:will )?never waive your right to (?:participate in )?class action/i,
        /(?:you may|users may) (?:participate|join) (?:in )?class action/i,
        /no (?:mandatory |binding |forced )?arbitration/i,
        /our liability is limited only by applicable law/i,
        /we (?:do not|don't) (?:impose|require) (?:forced |binding |mandatory )?arbitration/i,
        /(?:no|without) (?:liability|damages) caps? (?:below|under) (?:applicable|statutory)/i,
    ],
    transparency: [
        /written in plain (?:english|language)/i,
        /(?:easy|clear) to (?:read|understand)/i,
        /we (?:aim|strive) to be (?:transparent|clear|honest)/i,
        /this policy is (?:clear|transparent|written in plain)/i,
        // Note: transparency is ONLY a violation if SELF-CONTRADICTORY (same doc
        // contradicts itself). Mere vagueness is not. A clean policy doesn't need
        // an explicit "we are transparent" claim to pass this pillar.
    ],
};

/**
 * Extract a sentence-sized snippet containing a regex match.
 * Returns ~200 chars of surrounding context so the UI can show a real
 * verbatim quote instead of generic "Not addressed in document."
 */
function extractDenialQuote(fullText: string, pattern: RegExp): string {
    const m = fullText.match(pattern);
    if (!m || m.index === undefined) return '';
    const idx = m.index;
    const start = Math.max(0, fullText.lastIndexOf('.', idx - 1) + 1);
    const endDot = fullText.indexOf('.', idx + m[0].length);
    const end = endDot === -1 ? Math.min(fullText.length, idx + 200) : endDot + 1;
    return fullText.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Apply veto: if an explicit denial for a pillar is found in the full text,
 * override any LLM-flagged violation to CLEAR with HIGH confidence.
 *
 * Additionally: always set `status` ('VIOLATES' | 'EXPLICITLY_DENIES' |
 * 'NOT_MENTIONED') on every pillar so the UI can render three-state honestly
 * instead of lumping denials and silence together as generic "OKAY".
 */
export function applyDenialVeto(pillars: Record<string, any>, fullText: string): void {
    for (const [pillarKey, patterns] of Object.entries(DENIAL_PATTERNS)) {
        const p = pillars[pillarKey];
        if (!p) continue;

        let matchedPattern: RegExp | null = null;
        for (const re of patterns) {
            if (re.test(fullText)) { matchedPattern = re; break; }
        }

        if (matchedPattern) {
            const quote = extractDenialQuote(fullText, matchedPattern);
            // Conditional denial detection: "we do not sell ... except with partners"
            // is a scoped denial, not an absolute one. Downgrade confidence to MEDIUM
            // so it still clears the violation but doesn't hard-lock to HIGH trust.
            const CONDITIONAL_MARKERS = /\b(?:except(?:\s+when)?|unless|however|provided\s+that|other\s+than|notwithstanding|subject\s+to|only\s+when|but\s+(?:not|we|may)|in\s+certain\s+cases|under\s+some\s+circumstances)\b/i;
            const isConditional = quote ? CONDITIONAL_MARKERS.test(quote) : false;

            p.violation = false;
            p.confidence = isConditional ? 'MEDIUM' : 'HIGH';
            p.status = 'EXPLICITLY_DENIES';
            if (isConditional) p.conditionalDenial = true;
            if (quote) p.citation = quote;
        } else if (p.violation) {
            p.status = 'VIOLATES';
        } else {
            p.status = 'NOT_MENTIONED';
        }
    }

    // Pillars not covered by DENIAL_PATTERNS still need a status.
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p) continue;
        if (!p.status) {
            p.status = p.violation ? 'VIOLATES' : 'NOT_MENTIONED';
        }
    }
}

/**
 * Phrases that indicate a citation is ABSENT, not real content.
 * These must never count as "the pillar is addressed."
 */
const NULL_CITATIONS = [
    '[not_found]',
    'not addressed in document.',
    'not addressed',
    'not mentioned',
    'not explicitly mentioned',
    'not specified',
    'not stated',
    'n/a',
    '',
];

function isNullCitation(citation: string | undefined | null): boolean {
    if (!citation) return true;
    const c = citation.toString().trim().toLowerCase();
    if (!c) return true;
    if (NULL_CITATIONS.includes(c)) return true;
    // Short paraphrases like "This practice is not explicitly mentioned in the document."
    if (/^this practice is not (?:explicitly )?(?:mentioned|addressed|stated)/i.test(c)) return true;
    return false;
}

/**
 * Derive pillar status from what the LLM actually cited, not from what it
 * claimed independently. This kills the "DuckDuckGo problem" where the LLM
 * writes a real quote as citation but still labels status NOT_MENTIONED.
 *
 * Rule table (applied AFTER applyDenialVeto so explicit denials win):
 *   null citation + violation=false   →  NOT_MENTIONED
 *   null citation + violation=true    →  VIOLATES (LLM flagged without evidence)
 *   real citation + violation=true    →  VIOLATES
 *   real citation + violation=false   →  EXPLICITLY_DENIES (the LLM read it and cleared it)
 *
 * Only overrides when the current status contradicts the citation. Preserves
 * EXPLICITLY_DENIES set by regex denial-veto even if the citation got stripped.
 */
export function deriveStatusFromCitation(pillars: Record<string, any>): void {
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p) continue;
        const currentStatus = (p.status || '').toString().toUpperCase();
        // Preserve explicit denials (regex veto) and N/A (category scoping) —
        // both are authoritative signals stronger than citation inference.
        if (currentStatus === 'EXPLICITLY_DENIES') continue;
        if (currentStatus === 'NOT_APPLICABLE') continue;

        const hasRealCitation = !isNullCitation(p.citation);
        if (hasRealCitation && !p.violation) {
            p.status = 'EXPLICITLY_DENIES';
        } else if (hasRealCitation && p.violation) {
            p.status = 'VIOLATES';
        } else if (!hasRealCitation && p.violation) {
            p.status = 'VIOLATES';
        } else {
            p.status = 'NOT_MENTIONED';
        }
    }
}

/**
 * Count how many pillars have explicit denials present in the text.
 * Used as a "policy is broadly clean" signal — e.g. DuckDuckGo hits all 6.
 */
export function countExplicitDenials(fullText: string): number {
    let count = 0;
    for (const patterns of Object.values(DENIAL_PATTERNS)) {
        if (patterns.some(re => re.test(fullText))) count++;
    }
    return count;
}
