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
