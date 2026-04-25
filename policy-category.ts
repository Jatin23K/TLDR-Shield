/**
 * Policy category classifier + pillar applicability map.
 *
 * The problem this solves: DuckDuckGo correctly has no ads business and no
 * user-content model — so Data Selling and Content Ownership are silent
 * because they DON'T APPLY, not because DDG is hiding something. The UI
 * previously rendered both cases identically as "NOT STATED", making
 * perfectly-compliant privacy-first services look gappy.
 *
 * This module classifies a policy's domain (search / social / messaging /
 * e-commerce / financial / enterprise / developer-tools / other) via
 * keyword signals, then marks each pillar as APPLICABLE or NOT_APPLICABLE.
 * Pillars that don't apply get rendered as a dimmed "N/A" badge instead of
 * "NOT STATED" — honest and un-alarming.
 */

export type PolicyCategory =
    | 'search_engine'
    | 'social_platform'
    | 'messaging_e2e'
    | 'ecommerce'
    | 'financial'
    | 'enterprise_saas'
    | 'developer_tools'
    | 'media_streaming'
    | 'general';

/**
 * Per-category signals. A policy matches a category if any of its signals
 * appear in the normalized URL or document text.
 */
const CATEGORY_SIGNALS: Record<PolicyCategory, { url: RegExp[]; text: RegExp[] }> = {
    search_engine: {
        url: [/\b(?:duckduckgo|startpage|brave\.com\/search|searx|qwant|ecosia|kagi)\b/i],
        text: [/\bsearch\s+engine\b/i, /\bqueries?\s+(?:are\s+)?(?:not\s+)?(?:logged|stored|tracked)/i],
    },
    messaging_e2e: {
        url: [/\b(?:signal|protonmail|tutanota|threema|wire\.com|wickr|session\.org|silence)\b/i],
        text: [/\bend[- ]to[- ]end\s+encrypt/i, /\bzero[- ]knowledge\b/i, /\bcannot\s+(?:read|access|decrypt)\s+your\s+messages/i],
    },
    financial: {
        url: [/\b(?:paypal|stripe|chase|wells ?fargo|coinbase|kraken|robinhood|fidelity|schwab|vanguard|bank|trading|invest|crypto|gambling|casino|betting|forex|brokerage)\b/i],
        text: [/\baccount\s+(?:holder|balance)/i, /\bfdic[- ]insured/i, /\bkyc\s+(?:process|verification)/i, /\banti[- ]money[- ]laundering/i],
    },
    ecommerce: {
        url: [/\b(?:amazon|ebay|etsy|shopify|walmart|alibaba|aliexpress|target|bestbuy)\b/i],
        text: [/\border\s+history/i, /\bshipping\s+address/i, /\bpayment\s+method/i, /\breturns?\s+policy/i],
    },
    social_platform: {
        url: [/\b(?:facebook|meta|instagram|twitter|x\.com|tiktok|snapchat|snap\.com|reddit|linkedin|youtube|pinterest|threads)\b/i],
        text: [/\bpost[s]?\s+content/i, /\bshar(?:e|ing)\s+(?:posts?|content|photos?|videos?)/i, /\bfollow(?:er|ing)s?\b/i, /\bnews\s+feed/i],
    },
    media_streaming: {
        url: [/\b(?:netflix|hulu|disney|spotify|apple ?music|primevideo|hbomax|paramount|peacock|max\.com)\b/i],
        text: [/\bstream(?:ing)?\s+(?:service|content|library)/i, /\bsubscription\s+plan/i, /\bcontent\s+catalog/i],
    },
    enterprise_saas: {
        url: [/\b(?:slack|salesforce|workday|okta|servicenow|atlassian|oracle\.com\/cloud|aws\.amazon|gcp\.google)\b/i],
        text: [/\benterprise\s+customer/i, /\bdata\s+processing\s+agreement/i, /\bsub[- ]processor/i, /\bcorporate\s+account/i, /\bbusiness\s+associate/i],
    },
    developer_tools: {
        url: [/\b(?:github|gitlab|bitbucket|npmjs|pypi|huggingface|vercel|netlify|cloudflare)\b/i],
        text: [/\brepositor(?:y|ies)/i, /\bapi\s+(?:key|token)/i, /\bcommit\s+history/i, /\bpull\s+request/i],
    },
    general: {
        url: [],
        text: [],
    },
};

/**
 * Per-category pillar applicability. NOT_APPLICABLE means the pillar cannot
 * meaningfully apply to this kind of service and silence on it is expected.
 *
 * Default (general) = all pillars applicable. Specific categories only mark
 * pillars N/A when the category structurally cannot implicate that pillar.
 */
const APPLICABILITY: Record<PolicyCategory, Set<string>> = {
    // Search engines: no user-content model, no meaningful IP in search queries
    search_engine: new Set(['content_ownership']),
    // E2E messaging: provider cannot read content → cannot train AI / sell / license content
    messaging_e2e: new Set(['content_ownership', 'ai_training', 'data_selling']),
    // Financial: B2C banks rarely have user-content licensing; arbitration is common
    //   (we keep dark_patterns applicable — arbitration IS still a user-rights concern there)
    financial: new Set(['content_ownership', 'ai_training']),
    // Enterprise B2B: consumer dark-patterns (class waivers / $100 liability caps)
    //   aren't aimed at end users; DPAs handle user rights differently
    enterprise_saas: new Set(['dark_patterns']),
    // Developer tools: limited user-content model beyond repos (already scoped)
    developer_tools: new Set([]),
    // Ecommerce, social, streaming, general: all pillars applicable
    ecommerce: new Set([]),
    social_platform: new Set([]),
    media_streaming: new Set([]),
    general: new Set([]),
};

/**
 * Classify a policy into a category using URL + text signals.
 * URL hits beat text hits (more specific). First category with any signal wins.
 */
export function classifyPolicy(url: string | null | undefined, text: string): PolicyCategory {
    const urlStr = (url || '').toLowerCase();
    const textStr = text.slice(0, 20000); // classification only needs head of doc

    // Pass 1: URL signals (high precision)
    for (const [category, { url: urlPatterns }] of Object.entries(CATEGORY_SIGNALS)) {
        if (category === 'general') continue;
        if (urlPatterns.some(re => re.test(urlStr))) {
            return category as PolicyCategory;
        }
    }

    // Pass 2: text signals (need at least 2 hits to avoid false positives)
    const scores: Array<[PolicyCategory, number]> = [];
    for (const [category, { text: textPatterns }] of Object.entries(CATEGORY_SIGNALS)) {
        if (category === 'general') continue;
        const hits = textPatterns.filter(re => re.test(textStr)).length;
        if (hits >= 2) scores.push([category as PolicyCategory, hits]);
    }
    if (scores.length > 0) {
        scores.sort((a, b) => b[1] - a[1]);
        return scores[0][0];
    }

    return 'general';
}

/**
 * Mark pillars as NOT_APPLICABLE for the given category. Sets `applicable: false`
 * and `status: 'NOT_APPLICABLE'` on pillars that structurally cannot apply.
 *
 * Only overrides status when the pillar is currently silent (no violation, no
 * meaningful citation) — never masks an actual finding.
 */
export function applyCategoryScoping(
    pillars: Record<string, any>,
    category: PolicyCategory,
): number {
    const naSet = APPLICABILITY[category] || new Set<string>();
    let marked = 0;
    for (const key of naSet) {
        const p = pillars[key];
        if (!p) continue;
        // Safety: never mask a real violation. If LLM or regex found something
        // concerning, category-scoping must not silence it.
        if (p.violation) continue;
        const cit = (p.citation || '').toString().trim();
        const hasRealCitation = cit && !/^(?:\[not_found\]|not addressed|not mentioned|n\/a|\s*)$/i.test(cit)
            && !/^this practice is not /i.test(cit);
        if (hasRealCitation) continue; // real denial citation — leave as EXPLICITLY_DENIES
        // Mark as not applicable
        pillars[key] = {
            ...p,
            violation: false,
            applicable: false,
            status: 'NOT_APPLICABLE',
            citation: p.citation || `Not applicable to ${categoryLabel(category)}.`,
        };
        marked++;
    }
    return marked;
}

export function categoryLabel(category: PolicyCategory): string {
    const LABELS: Record<PolicyCategory, string> = {
        search_engine:    'search engines',
        social_platform:  'social platforms',
        messaging_e2e:    'end-to-end messaging services',
        ecommerce:        'ecommerce',
        financial:        'financial services',
        enterprise_saas:  'enterprise SaaS',
        developer_tools:  'developer tools',
        media_streaming:  'streaming services',
        general:          'this service',
    };
    return LABELS[category];
}
