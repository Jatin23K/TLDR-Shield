import nlp from 'compromise';

export function chunkText(text: string, CHUNK_SIZE: number, CHUNK_OVERLAP: number, MAX_CHUNKS: number): string[] {
    if (text.length <= CHUNK_SIZE * 1.2) return [text];

    const doc = nlp(text);
    const sentences = doc.sentences().out('array');
    const chunks: string[] = [];
    let current = '';
    let tailSentences: string[] = [];

    for (let i = 0; i < sentences.length && chunks.length < MAX_CHUNKS; i++) {
        const sentence = sentences[i];
        if ((current + ' ' + sentence).length > CHUNK_SIZE && current.length > 0) {
            chunks.push(current.trim());
            let overlapText = '';
            for (let j = tailSentences.length - 1; j >= 0; j--) {
                const candidate = tailSentences[j] + ' ' + overlapText;
                if (candidate.length > CHUNK_OVERLAP) break;
                overlapText = candidate;
            }
            current = overlapText + ' ' + sentence;
            tailSentences = [];
        } else {
            current = current ? current + ' ' + sentence : sentence;
        }
        tailSentences.push(sentence);
        while (tailSentences.join(' ').length > CHUNK_OVERLAP * 1.5 && tailSentences.length > 1) {
            tailSentences.shift();
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.slice(0, MAX_CHUNKS);
}

const STOPWORDS = new Set([
    'that', 'with', 'this', 'from', 'your', 'their', 'have', 'will', 'been',
    'they', 'were', 'when', 'also', 'than', 'then', 'into', 'more', 'about',
    'which', 'such', 'other', 'these', 'those', 'shall', 'under', 'upon',
    'including', 'without', 'within', 'whether', 'however', 'each', 'only',
]);

export function findVerbatimInChunk(citation: string, chunkText: string): string {
    if (!citation || citation === 'Not addressed in document.' || citation === '[NOT_FOUND]' || !chunkText) {
        return citation;
    }

    // Fast path: citation is already verbatim (first 50 chars appear in source)
    const citLower = citation.toLowerCase().replace(/\s+/g, ' ').trim();
    const srcLower = chunkText.toLowerCase().replace(/\s+/g, ' ');
    const prefix = citLower.slice(0, 50);
    if (prefix.length >= 20 && srcLower.includes(prefix)) return citation;

    // 1. Extract key terms: 4+ chars, non-stopword, max 6
    const keyTerms = citation
        .toLowerCase()
        .split(/\s+/)
        .map(w => w.replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length >= 4 && !STOPWORDS.has(w))
        .slice(0, 6);

    if (keyTerms.length < 2) return citation;

    // 2. Find positions of each key term in the chunk
    const termPositions: number[][] = keyTerms.map(term => {
        const positions: number[] = [];
        let idx = srcLower.indexOf(term);
        while (idx !== -1) {
            positions.push(idx);
            idx = srcLower.indexOf(term, idx + 1);
        }
        return positions;
    });

    // 3. Find anchor position where 2+ terms co-occur within ±150 chars
    let bestPos = -1;
    let bestCount = 0;
    for (let t = 0; t < termPositions.length; t++) {
        for (const pos of termPositions[t]) {
            const count = termPositions.filter(tp => tp.some(p => Math.abs(p - pos) <= 150)).length;
            if (count > bestCount) {
                bestCount = count;
                bestPos = pos;
            }
        }
    }

    if (bestCount < 2 || bestPos === -1) return citation;

    // 4. Expand to sentence boundaries (raw window: -100 to +300 chars)
    const rawStart = Math.max(0, bestPos - 100);
    const rawEnd   = Math.min(chunkText.length, bestPos + 300);
    let snippet    = chunkText.slice(rawStart, rawEnd);

    // Trim to nearest sentence start (capital letter after punctuation)
    const capMatch = snippet.match(/(?:^|[.!?;]\s{1,2})([A-Z"])/);
    if (capMatch && capMatch.index !== undefined) {
        const offset = capMatch.index + (capMatch[0].length - 1);
        snippet = snippet.slice(offset);
    }

    // Cap at 60 words
    const words = snippet.split(/\s+/);
    if (words.length > 60) snippet = words.slice(0, 60).join(' ');

    // 5. Only return if it's a meaningful improvement
    return snippet.trim().length >= 30 ? snippet.trim() : citation;
}

export function extractJSON(text: string): any {
    try {
        // Depth-counter or regex based JSON extraction
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    } catch {
        return null;
    }
}

// ─── Per-pillar keyword patterns for citation backfill ───────────────────────
// When the LLM returns [NOT_FOUND] for a SAFE pillar, we search the full raw
// document text for the most relevant sentence using these weighted keywords.
// Sentences are scored by keyword hits; the highest-scoring sentence is used
// as the citation verbatim — no LLM call, no hallucination risk.
const PILLAR_KEYWORDS: Record<string, { high: string[]; low: string[] }> = {
    ai_training: {
        // Require explicit AI/ML training language — NOT generic "model" or "improve"
        high: [
            'train.{0,20}(?:model|ai|data)',   // "train our models", "training data"
            'machine learning',
            'artificial intelligence',
            'fine.?tun',                        // fine-tune, fine-tuned
            'large language model',
            'generative ai',
            'neural network',
            'training data',
        ],
        low: [],   // no generic words — "model", "improve", "recommend" cause false positives
    },
    data_selling: {
        // Require explicit third-party commercial data sharing — NOT generic "partner"
        high: [
            'sell.{0,20}(?:data|information|personal)',
            'third.?part.{0,20}(?:advertis|commercial|marketing)',
            'data broker',
            'marketing partner',
            'advertis.{0,20}partner',
            'share.{0,30}personal.{0,30}third',
        ],
        low: [],   // "share", "partner", "affiliate" alone are too generic
    },
    transparency: {
        // Transparency language is relatively unique — keep compound phrases only
        high: [
            'privacy policy',
            'simple and clear',
            'easy to understand',
            'plain.{0,10}language',
            'worked hard to make',
            'transparent',
        ],
        low: ['clear', 'inform'],
    },
    data_retention: {
        // Must see an explicit retention PERIOD — NOT just "delete your account"
        high: [
            'retain.{0,20}(?:data|information|personal)',
            '(?:data|information).{0,20}retain',
            'retention period',
            '(?:days|months|years).{0,30}(?:after|follow).{0,30}(?:delet|terminat|clos)',
            'how long.{0,30}(?:keep|store|retain|held)',
            '(?:keep|store|held).{0,20}(?:data|information).{0,30}(?:days|months|years)',
            'after.{0,30}account.{0,30}(?:delet|clos).{0,30}(?:days|months|years)',
        ],
        low: [],   // "delete", "account", "terminat" alone match account-deletion sentences
    },
    content_ownership: {
        high: [
            'sublicens',
            'royalty.free.{0,20}licen',
            'worldwide.{0,20}licen',
            'licen.{0,30}content',
            'intellectual property.{0,20}content',
            'rights.{0,20}(?:your )?content',
        ],
        low: ['license', 'licence'],
    },
    dark_patterns: {
        high: [
            'arbitrat',
            'class action',
            'waiv.{0,20}right',
            'liabilit.{0,20}(?:cap|limit|shall not exceed)',
            'statute of limitation',
            '(?:individual|binding).{0,20}arbitrat',
            'dispute.{0,20}(?:resolut|individual)',
        ],
        low: ['claim', 'court'],
    },
};

/**
 * POST-SCAN CITATION BACKFILL
 *
 * For every SAFE pillar whose citation is '[NOT_FOUND]', scan the full raw
 * document text to find the most relevant sentence verbatim.
 *
 * Why: The LLM only sees individual chunks. If the relevant clause was in a
 * chunk the model didn't receive for that pillar, it returns [NOT_FOUND] even
 * though the clause exists in the full document. This function fixes that
 * deterministically — same text always produces the same citation.
 *
 * Rules:
 * - Only runs on SAFE pillars (violation: false) with [NOT_FOUND] citations.
 * - Never changes violation flag or confidence — only updates citation text.
 * - Only updates if a sentence scores above the minimum threshold.
 */
export function backfillSafeCitations(pillars: Record<string, any>, fullText: string): void {
    if (!fullText || !pillars) return;

    // Split full document into sentences using a simple but robust split
    const sentences = fullText
        .replace(/([.!?;])\s+/g, '$1\n')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length >= 30 && s.length <= 600);

    for (const [pillarKey, pillar] of Object.entries(pillars)) {
        if (!pillar) continue;
        // Only backfill SAFE pillars with a [NOT_FOUND] or empty citation
        const cit = (pillar.citation || '').trim();
        if (pillar.violation === true) continue;
        if (cit !== '[NOT_FOUND]' && cit !== '' && cit !== 'Not addressed in document.') continue;

        const kw = PILLAR_KEYWORDS[pillarKey];
        if (!kw) continue;

        let bestSentence = '';
        let bestScore = 0;
        const textLower = fullText.toLowerCase();

        for (const sentence of sentences) {
            const sLower = sentence.toLowerCase();
            let score = 0;

            // High-value keywords score 3 points each
            for (const hw of kw.high) {
                if (new RegExp(hw, 'i').test(sLower)) score += 3;
            }
            // Low-value keywords score 1 point each
            for (const lw of kw.low) {
                if (new RegExp(lw, 'i').test(sLower)) score += 1;
            }

            if (score > bestScore) {
                bestScore = score;
                bestSentence = sentence;
            }
        }

        // Only use if score is meaningful — requires at least 2 high-value keyword hits
        // (threshold 6 = two 3-point high-value matches). Single vague keyword matches
        // are rejected to prevent false-positive citations like "delete your account"
        // appearing under data_retention, or third-party sentences under ai_training.
        if (bestScore >= 6 && bestSentence.length >= 30) {
            // Cap at 60 words to stay within citation display limits
            const words = bestSentence.split(/\s+/);
            pillar.citation = words.length > 60
                ? words.slice(0, 60).join(' ') + '...'
                : bestSentence;
        }
        // If no good match found, leave as [NOT_FOUND] — never manufacture a citation
    }
}

// ─── Hard Violation Patterns ─────────────────────────────────────────────────
// Used by detectHardViolations() as a deterministic safety net. Each pattern
// is a compound regex with near-zero false positive rate in legal documents.
// 'negatable: true' patterns are skipped if the matching sentence contains
// strong negation words ("do not sell", "will never train", etc.).
interface ViolationPattern {
    pattern: RegExp;
    negatable: boolean;
}

const HARD_VIOLATION_PATTERNS: Record<string, ViolationPattern[]> = {
    ai_training: [
        // "train our AI/ML models", "training our machine learning models"
        { pattern: /\btrain(?:ing|s)?\s+(?:our\s+)?(?:ai|ml|machine[\s-]learning|language[\s-])?\s*models?\b/i, negatable: true },
        // "fine-tune" or "fine tuning" — almost always model training in ToS context
        { pattern: /\bfine[\s-]tun/i, negatable: true },
        // "machine learning" near "train"
        { pattern: /\bmachine[\s-]learning\b.{0,120}\btrain/i, negatable: true },
        { pattern: /\btrain.{0,120}\bmachine[\s-]learning\b/i, negatable: true },
        // "generative AI" or "large language model" — inherently AI training territory
        { pattern: /\bgenerative\s+ai\b/i, negatable: true },
        { pattern: /\blarge\s+language\s+model\b/i, negatable: true },
        // "content/data used to train model"
        { pattern: /(?:content|data|input)s?\b.{0,100}\btrain(?:ing|s)?\b.{0,80}\bmodel\b/i, negatable: true },
        { pattern: /\bai\s+model\b.{0,100}\btrain/i, negatable: true },
    ],
    data_selling: [
        // Explicit selling of data
        { pattern: /\bsell(?:ing|s)?\s+(?:your\s+|user\s+|personal\s+)?(?:data|information|details)\b/i, negatable: true },
        { pattern: /\bsold\b.{0,60}\b(?:data|information|personal)\b/i, negatable: true },
        // Third-party advertisers or marketing partners receiving personal data
        { pattern: /\bthird[\s-]part(?:y|ies)\b.{0,80}\b(?:advertis(?:ing|ers?)|marketing(?:[\s-]partner)?|commercial)\b/i, negatable: true },
        { pattern: /\b(?:share|disclose|provide)\b.{0,100}\bpersonal\b.{0,100}\b(?:advertis|marketing[\s-]partner|third[\s-]party)\b/i, negatable: true },
        // "data broker" — unambiguously bad in any context
        { pattern: /\bdata\s+broker\b/i, negatable: false },
        // "monetize user data/information"
        { pattern: /\bmonetiz(?:e|es|ing|ation)\b.{0,80}\b(?:data|information|content)\b/i, negatable: true },
    ],
    data_retention: [
        // Explicit multi-year retention after account deletion
        { pattern: /\b(?:retain|keep|store|held|maintain)\b.{0,100}\b(?:data|information|personal)\b.{0,80}\b(?:[2-9]|[1-9]\d+)\s*years?\b/i, negatable: false },
        // "X months/years after deletion/termination"
        { pattern: /\b(?:[2-9]|[1-9]\d+)\s*(?:months?|years?)\b.{0,120}\b(?:after|following)\b.{0,80}\b(?:delet|terminat|clos|cancell)/i, negatable: false },
        // "retain for up to X years"
        { pattern: /\bretain(?:ing|s)?\b.{0,80}\bup\s+to\b.{0,80}\b\d+\s*(?:months?|years?)/i, negatable: false },
    ],
    content_ownership: [
        // "sublicensable" — grants company right to sublicense YOUR content to others
        { pattern: /\bsub[\s-]?licens(?:e|able|ing|ed|es)?\b/i, negatable: false },
        // Perpetual + irrevocable license — rights that can never be taken back
        { pattern: /\bperpetual\b.{0,80}\birrevocable\b.{0,80}\blicen/i, negatable: false },
        { pattern: /\birrevocable\b.{0,80}\bperpetual\b.{0,80}\blicen/i, negatable: false },
        // Royalty-free license granting derivative works or commercial distribution
        { pattern: /\broyalty[\s-]free\b.{0,120}\b(?:sublicens|creat(?:e|ing)\s+derivative|distribut\w+\s+commerc)/i, negatable: false },
        // License "for any purpose" — beyond operating the service
        { pattern: /\blicen(?:se|ce)\b.{0,120}\bfor\s+any\s+purpose\b/i, negatable: false },
        { pattern: /\bfor\s+any\s+purpose\b.{0,120}\blicen(?:se|ce)\b/i, negatable: false },
    ],
    dark_patterns: [
        // "class action" — virtually always a waiver in ToS context
        { pattern: /\bclass\s+action\b/i, negatable: false },
        // Class representative/member waiver pattern
        { pattern: /\bclass\s+(?:representative|member)\b.{0,150}\b(?:waiv|not\s+bring|cannot\s+bring|may\s+not\s+bring)/i, negatable: false },
        // Mandatory/binding arbitration
        { pattern: /\b(?:mandatory|binding|compulsory)\s+arbitrat/i, negatable: false },
        { pattern: /\bagree(?:s|d|ing)?\s+to\s+(?:binding\s+)?arbitrat/i, negatable: false },
        // Statute of limitations shortened
        { pattern: /\bstatute\s+of\s+limitation/i, negatable: false },
        // Liability cap with dollar amount — e.g. "shall not exceed $100"
        { pattern: /\bliabilit\w*\b.{0,80}\b(?:shall\s+not\s+exceed|is\s+limited\s+to|will\s+not\s+exceed|capped?\s+at)\b.{0,120}\b(?:\$\s*\d+|\d+\s*(?:dollars?|usd))\b/i, negatable: false },
        // "individual basis" waiver (class/collective/representative action prohibited)
        { pattern: /\bindividual\s+basis\b.{0,200}\b(?:class|collective|representative)\b/i, negatable: false },
    ],
};

/**
 * Returns true if a sentence contains negation words that invert a violation.
 * Used to avoid false positives like "we do NOT sell your data".
 */
function hasStrongNegation(sentence: string): boolean {
    return /\b(?:do(?:es)?|did|will|shall|have|has|had|can|could|may|might|should|would|must|are|is|was|were|am)\s+not\b|\b(?:don't|doesn't|didn't|won't|shan't|haven't|hasn't|hadn't|can't|couldn't|shouldn't|wouldn't|mustn't|aren't|isn't|wasn't|weren't)\b|\bnever\b|\bnot\s+(?:sell|share|train|use|disclose|transfer|collect|store)\b/i.test(sentence);
}

/**
 * DETERMINISTIC VIOLATION BACKSTOP
 *
 * Runs AFTER the LLM chunked analysis. Scans the FULL document text for hard
 * violation indicators that the LLM may have missed due to chunking boundaries.
 *
 * Only upgrades SAFE → RISKY, never downgrades. Uses compound regex patterns
 * with near-zero false positive rate — terms like "sublicensable", "class action",
 * "binding arbitration" are unambiguous violation signals in any legal document.
 *
 * When a missed violation is detected:
 *   - violation = true
 *   - confidence = 'HIGH'
 *   - citation = the exact verbatim sentence from the document
 *
 * This makes the system universal: same document → same result, regardless of
 * how the LLM happened to chunk it on this particular scan.
 */
export function detectHardViolations(fullText: string, pillars: Record<string, any>): void {
    if (!fullText || !pillars) return;

    // Split into sentences for targeted, contextual matching
    const sentences = fullText
        .replace(/([.!?])\s+(?=[A-Z\u201C\u2018"])/g, '$1\n')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length >= 20 && s.length <= 1000);

    for (const [pillarKey, pillar] of Object.entries(pillars)) {
        // Only run on pillars the LLM marked as SAFE or MEDIUM — never downgrade
        if (!pillar || pillar.violation === true) continue;

        const patterns = HARD_VIOLATION_PATTERNS[pillarKey];
        if (!patterns || patterns.length === 0) continue;

        let upgradeFound = false;
        for (const { pattern, negatable } of patterns) {
            if (upgradeFound) break;

            for (const sentence of sentences) {
                if (!pattern.test(sentence)) continue;
                if (negatable && hasStrongNegation(sentence)) continue;

                // Found a hard violation the LLM missed — upgrade pillar
                pillar.violation = true;
                pillar.confidence = 'HIGH';
                const words = sentence.split(/\s+/);
                pillar.citation = words.length > 60
                    ? words.slice(0, 60).join(' ') + '...'
                    : sentence;
                upgradeFound = true;
                console.log(`[TLDR Shield] detectHardViolations: upgraded ${pillarKey} SAFE→RISKY via pattern "${pattern.source.slice(0, 60)}"`);
                break;
            }
        }
    }
}

/**
 * COOKIE BOILERPLATE STRIPPER
 *
 * Removes cookie consent banner content from extracted page text before
 * sending to the LLM. Cookie banners (OneTrust, Cookiebot, etc.) often contain
 * data-sharing language ("user browsing data shared with advertisers") that
 * belongs to the cookie policy — not the Terms of Service — and causes false
 * positive data_selling citations.
 *
 * Method: splits text into paragraphs, removes any paragraph matching 2+
 * known cookie consent indicators. This is surgical — it only removes confirmed
 * cookie content, not any ToS text that happens to mention cookies.
 */
export function stripCookieBoilerplate(text: string): string {
    if (!text) return text;

    const cookieIndicators: RegExp[] = [
        /targeting\s+cookies/i,
        /strictly\s+necessary\s+cookies/i,
        /functional\s+cookies/i,
        /performance\s+cookies/i,
        /accept\s+all\s+cookies/i,
        /reject\s+all\s+cookies/i,
        /cookie\s+preferences/i,
        /universal\s+advertising\s+identifier/i,
        /consent\s+management\s+platform/i,
        /\bonetrust\b/i,
        /\bcookiebot\b/i,
        /vendors?\s+may\s+rely\s+on\s+your\s+consent/i,
    ];

    // Paragraphs with 2+ cookie indicators are cookie banner content, not ToS
    const paragraphs = text.split(/\n{2,}/);
    const cleaned = paragraphs.filter(para => {
        const hits = cookieIndicators.filter(rx => rx.test(para)).length;
        return hits < 2;
    });

    const result = cleaned.join('\n\n');
    if (result.length < text.length - 200) {
        console.log(`[TLDR Shield] stripCookieBoilerplate: removed ~${text.length - result.length} chars of cookie banner text`);
    }
    return result;
}
