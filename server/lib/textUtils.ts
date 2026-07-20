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

