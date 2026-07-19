// ─── Post-Processing Pipeline ─────────────────────────────────────────────────
// Extracted from server.ts to reduce monolith size.
// Contains: keyword cross-check, paraphrase detection, citation validation,
// citation sanitization, and confidence reassignment.
//
// These functions run AFTER the LLM returns its analysis but BEFORE the result
// is cached or sent to the client. They are the server-side quality gates.

// ─── Keyword Cross-Check ──────────────────────────────────────────────────────
// Runs keyword matching against the full source text to catch violations the LLM missed.
// Returns a set of pillar keys that were confirmed by keyword evidence.

export function applyConsistencyCrossCheck(pillars: Record<string, any>, sourceText: string): Set<string> {
    const confirmed = new Set<string>();
    const textLower = sourceText.toLowerCase();

    // HIGH_CONFIDENCE: single unambiguous phrase is enough — these don't appear in compliant policies.
    // STANDARD: require 2+ hits to prevent loose single-word matches.
    const HIGH_CONFIDENCE: Record<string, string[]> = {
        ai_training:       ['train our models', 'training data for ai', 'fine-tune our', 'generative ai trained', 'llm trained on', 'used to train ai'],
        data_selling:      [
            'sell your personal data', 'sell user data', 'selling data', 'data broker', 'sell or share your',
            // Meta/Instagram miss audit: the "advertisers and partners" share-language
            // that Meta's PP uses to commercialize data without calling it "selling"
            'advertising partners for their',
            'commercial purposes',
        ],
        content_ownership: [
            'for any purpose',
            'sublicensable',
            'royalty-free',
            'irrevocable',
            'perpetual',
            'derivative works',
        ],
        dark_patterns:     ['class action waiver', 'waive your right to participate', 'binding individual arbitration', 'forced arbitration', 'not exceed $100', 'shortened statute'],
        data_retention:    ['retain indefinitely', 'retain forever', 'stored permanently'],
    };

    const STANDARD: Record<string, string[]> = {
        ai_training:       ['machine learning', 'artificial intelligence', 'ai model', 'train', 'fine-tune'],
        data_selling:      ['trusted partners', 'business partner', 'advertiser', 'third party', 'share your information', 'disclose your', 'advertising partner', 'marketing partner', 'data broker'],
        transparency:      ['at our sole discretion', 'from time to time', 'at any time without notice', 'we may change', 'reserves the right to modify'],
        data_retention:    ['retain', 'retention', 'deletion', 'delete your', 'after account', 'years after', 'post-deletion'],
        content_ownership: ['intellectual property', 'royalty-free', 'worldwide license', 'sublicense', 'perpetual', 'irrevocable', 'derivative'],
        dark_patterns:     ['class action', 'arbitration', 'liability', 'limitation of liability', 'statute of limitations', 'waive', 'individual basis'],
    };

    for (const key of Object.keys(pillars)) {
        // Already confirmed by HIGH_CONFIDENCE — skip standard check for this pillar
        const highHits = (HIGH_CONFIDENCE[key] ?? []).filter(kw => textLower.includes(kw));
        if (highHits.length > 0) {
            // Highly specific phrase found — we can force a violation because it's unambiguous
            if (!pillars[key]?.violation) {
                pillars[key] = { 
                    ...pillars[key], 
                    violation: true, 
                    confidence: 'HIGH',
                    citation: highHits[0] // Set matched phrase as citation so it is grounded
                };
            }
            confirmed.add(key);
            continue;
        }
        // Standard: require 2+ hits (tightened from loose single-word matches)
        const stdHits = (STANDARD[key] ?? []).filter(kw => textLower.includes(kw)).length;
        if (stdHits >= 2) {
            // Fix A: Do NOT force a violation from false to true on standard keywords.
            // Only confirm if the LLM already identified it as a violation.
            if (pillars[key]?.violation) {
                confirmed.add(key);
            }
        }
    }
    return confirmed;
}

// ─── Citation Confidence ──────────────────────────────────────────────────────
// Compute how well a citation is grounded in the source document.
// HIGH   = first 50 chars found verbatim in source text
// MEDIUM = 60%+ of meaningful words from citation found in source
// LOW    = citation cannot be located in source (likely hallucinated)
export function computeCitationConfidence(citation: string, sourceText: string): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (!citation || citation === 'Not addressed in document.' || citation === '[NOT_FOUND]') {
        return 'MEDIUM'; // silence = uncertain, not definitively wrong
    }
    const citLower = citation.toLowerCase().replace(/\s+/g, ' ').trim();
    const srcLower = sourceText.toLowerCase().replace(/\s+/g, ' ');

    // Exact prefix match in source text — citation is verbatim
    const prefix = citLower.slice(0, 50);
    if (prefix.length >= 20 && srcLower.includes(prefix)) return 'HIGH';

    // Word overlap check — most meaningful words from citation present in source
    const citWords = citLower.split(/\s+/).filter(w => w.length > 3);
    if (citWords.length === 0) return 'LOW';
    const matchCount = citWords.filter(w => srcLower.includes(w)).length;
    if (matchCount / citWords.length >= 0.6) return 'MEDIUM';
    return 'LOW';
}

// Override the LLM's self-reported confidence with server-side verified confidence.
// Combines: citation verbatim validation (A1) + cross-check agreement (A2).
//
// violation=true pillar rules:
//   citation HIGH  (verbatim found)                    → HIGH
//   citation MEDIUM + cross-check confirmed            → MEDIUM
//   citation LOW   + cross-check confirmed             → MEDIUM (at least one signal)
//   citation MEDIUM, no cross-check                    → MEDIUM
//   citation LOW,   no cross-check                     → LOW (likely hallucinated)
// violation=false pillar: keep LLM confidence (reflects certainty of absence)
export function updatePillarConfidence(
    pillars: Record<string, any>,
    crossCheckConfirmed: Set<string>,
    sourceText: string
): void {
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p) continue;

        // Fix B: If a pillar is marked as a violation, but has no citation or citation is [NOT_FOUND],
        // demote it to violation: false immediately. No citation = no violation.
        if (p.violation && (!p.citation || p.citation === '[NOT_FOUND]' || p.citation === 'Not addressed in document.')) {
            p.violation = false;
        }

        if (!p.violation) {
            // Non-violated pillars always show MEDIUM — absence of violation needs no citation proof.
            // Overriding any prior value (e.g. LOW set by deterministic fallback) prevents misleading dots.
            p.confidence = 'MEDIUM';
            continue;
        }
        const citConf      = computeCitationConfidence(p.citation ?? '', sourceText);
        const crossChecked = crossCheckConfirmed.has(key);

        if (citConf === 'HIGH') {
            p.confidence = 'HIGH';
        } else if (crossChecked) {
            p.confidence = 'MEDIUM';
        } else if (citConf === 'MEDIUM') {
            p.confidence = 'MEDIUM';
        } else {
            p.confidence = 'LOW';
        }
    }
}

// ─── Paraphrase Detection ─────────────────────────────────────────────────────
// LLMs frequently write "The policy states..." or "There is no mention of..." instead of
// copy-pasting verbatim text. These can't be found on the page → no highlight.
// Sanitizing to 'Not addressed in document.' keeps the UI honest.
// Paraphrase patterns are split into two buckets based on specificity risk:
//   STRICT   — may match anywhere in the citation (very specific phrasings
//              that do NOT legitimately appear in real policy clauses).
//   LEADING  — only match in the first 80 chars of the citation (generic
//              negation words that CAN appear mid-sentence in real clauses,
//              e.g. "we may share data with partners, but this does not
//              include sensitive personal data"). Restricting to the opening
//              prevents false demotions on complex RISKY policies whose real
//              quotes contain negation mid-sentence.
export const PARAPHRASE_PATTERNS_STRICT = [
    // Anchored third-person descriptors — LLM writing ABOUT the policy.
    /^the policy\b/i,
    /^the terms of service\b/i,
    /^the terms\b/i,
    /^the document\b/i,
    /^the agreement\b/i,
    /^the platform\b/i,
    /^the service\b/i,
    /^the tos\b/i,
    /^this policy\b/i,
    /^this document\b/i,
    /^this agreement\b/i,
    /^there is no\b/i,
    /^there are no\b/i,
    /^no mention\b/i,
    /^no explicit\b/i,
    /^no specific\b/i,
    // Structural paraphrase indicators that identify LLM-narration shape.
    /\bprovided terms of service\b/i,
    /\bin the provided\b/i,
    /\bmention of .{0,40} in the\b/i,
    /\bin the terms of service\b/i,
    /\bin the document\b/i,
    // Specific absence-description shapes. "the policy does not contain" etc.
    // These are very unlikely to appear verbatim in a real policy.
    /\b(?:policy|document|text|terms?) (?:does|do) not (?:contain|include|mention|address|discuss|state|specify|cover)\b/i,
    /\bis silent on\b/i,
    /\bthe absence of\b/i,
    /\b(?:missing|lacks|lacking) (?:any |explicit |specific )?(?:language|clause|provision|mention|statement)\b/i,
    /\bno (?:explicit )?(?:language|clause|mention|statement|provision|reference)\s+(?:regarding|about|on|for)\b/i,
];
// Leading-only patterns — match only in first 80 chars of citation. Generic
// negation verbs that legitimately appear mid-sentence in real policy text.
export const PARAPHRASE_PATTERNS_LEADING = [
    /\bdoes not contain\b/i,
    /\bdoes not include\b/i,
    /\bdoes not mention\b/i,
    /\bdoes not address\b/i,
    /\bdoes not discuss\b/i,
    /\bdoes not state\b/i,
    /\bdoes not specify\b/i,
    /\bdoes not explicitly (?:state|mention|address|include)\b/i,
    /\bis not addressed\b/i,
    /\bnot addressed\b/i,
    /\bnot (?:explicitly )?mentioned\b/i,
    /\bnot (?:explicitly )?stated\b/i,
    /\bnot (?:explicitly )?specified\b/i,
];
// Back-compat: retained for callers that test against the combined list.
// New classification logic uses isParaphraseCitation() which is positional.
export const PARAPHRASE_PATTERNS = [...PARAPHRASE_PATTERNS_STRICT, ...PARAPHRASE_PATTERNS_LEADING];

export function isParaphraseCitation(citation: string): boolean {
    if (!citation) return false;
    const trimmed = citation.trim();
    if (PARAPHRASE_PATTERNS_STRICT.some(re => re.test(trimmed))) return true;
    const head = trimmed.slice(0, 80);
    if (PARAPHRASE_PATTERNS_LEADING.some(re => re.test(head))) return true;
    return false;
}

// Strip "The policy states that [X], indicating Y" → "[X]"
// Keeps the verbatim core when LLM wraps a real quote in a paraphrase sentence.
const VIOLATION_PREFIX_RE = /^(?:the (?:terms?(?: of service)?|policy|document|agreement|x user agreement|platform)\s+(?:also\s+)?(?:states?|says?|notes?|requires?|provides?|includes?|limits?|caps?|restricts?|grants?|gives?)\s+(?:that\s+)?["'"\u201c\u2018]?|this (?:policy|license|agreement|means?)\s+(?:states?|says?|provides?|requires?|means?)\s+(?:that\s+)?["'"\u201c\u2018]?)/i;
const VIOLATION_SUFFIX_RE = /[,;]\s+(?:indicating|suggesting|implying|potentially|which means|and may be|and could be|making it|this means|and is)[^.]*\.?\s*$/i;

export function stripViolationWrapper(citation: string): string {
    const cleaned = citation.replace(VIOLATION_PREFIX_RE, '').replace(VIOLATION_SUFFIX_RE, '').replace(/["'"\u201d\u2019]+$/, '').trim();
    return cleaned.length >= 20 ? cleaned : citation;
}

// Fix #9: minimum trustworthy citation length. Short fragments ("data is
// collected", "you agree") are ambiguous and often appear verbatim in many
// clauses unrelated to the pillar. Require ≥25 chars of verbatim overlap.
export const MIN_CITATION_CHARS = 25;
export const MIN_CITATION_WORDS = 5;

// Fix #18: word-level contiguous-match validator.
function normalizeForMatch(s: string): string {
    return s.toLowerCase().replace(/[""''`]/g, '"').replace(/[^\w\s"]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function citationGroundedInSource(citation: string, sourceText: string): boolean {
    if (!citation || citation === 'Not addressed in document.') return false;
    const cit = normalizeForMatch(citation);
    const src = normalizeForMatch(sourceText);
    if (cit.length < MIN_CITATION_CHARS) return false;
    // Fast path: whole citation (or first 60 chars) is a direct substring.
    const head = cit.slice(0, Math.min(cit.length, 60));
    if (head.length >= MIN_CITATION_CHARS && src.includes(head)) return true;
    // Slower path: any 5 consecutive words from the citation appear in source.
    const words = cit.split(' ').filter(w => w.length > 0);
    if (words.length < MIN_CITATION_WORDS) return false;
    for (let i = 0; i <= words.length - MIN_CITATION_WORDS; i++) {
        const window = words.slice(i, i + MIN_CITATION_WORDS).join(' ');
        if (window.length >= 18 && src.includes(window)) return true;
    }
    return false;
}

// Verify citations exist in source text.
export async function verifyCitations(citations: string[], sourceText: string, _signal: AbortSignal): Promise<string[]> {
    if (!citations?.length || !sourceText) return citations;
    const verified: string[] = [];
    for (const citation of citations.slice(0, 5)) { // max 5 citations
        if (citationGroundedInSource(citation, sourceText)) {
            verified.push(citation);
            continue;
        }
        console.log(`[TLDR Shield] Citation not found in source — removing: "${citation.slice(0, 60)}…"`);
    }
    return verified;
}

/**
 * Fix #2 + #11: Single source of truth for "is this pillar citation trustworthy?"
 * Combines: paraphrase check + verbatim grounding + length minimum.
 * Returns a label we can use to decide confidence / deduction.
 */
export type CitationTrust = 'GROUNDED' | 'PARAPHRASE' | 'TOO_SHORT' | 'NOT_FOUND' | 'ABSENT';

export function classifyCitation(citation: string | undefined, sourceText: string): CitationTrust {
    if (!citation || citation === 'Not addressed in document.' || citation.trim().length === 0) return 'ABSENT';
    const trimmed = citation.trim();
    if (isParaphraseCitation(trimmed)) return 'PARAPHRASE';
    if (trimmed.length < MIN_CITATION_CHARS) return 'TOO_SHORT';
    if (!citationGroundedInSource(trimmed, sourceText)) return 'NOT_FOUND';
    return 'GROUNDED';
}

// ─── Citation Sanitization ────────────────────────────────────────────────────
export function sanitizeCitations(pillars: Record<string, any>): void {
    if (!pillars) return;
    for (const key of Object.keys(pillars)) {
        const p = pillars[key];
        if (!p?.citation || p.citation === 'Not addressed in document.') continue;
        if (p.violation) {
            // For VIOLATION pillars: strip paraphrase wrappers to expose verbatim core
            const stripped = stripViolationWrapper(p.citation.trim());
            p.citation = stripped;
            continue;
        }
        // For CLEAR pillars: replace outright paraphrases with sentinel
        const c = p.citation.trim();
        if (PARAPHRASE_PATTERNS.some(re => re.test(c))) {
            p.citation = 'Not addressed in document.';
        }
    }
}
