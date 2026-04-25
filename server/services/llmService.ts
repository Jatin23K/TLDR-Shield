// ── Gemini LLM Service [Portfolio Architecture] ──
// DESIGN PHILOSOPHY:
// This service handles high-concurrency LLM requests by implementing:
// 1. DYNAMIC KEY ROTATION: Retries across a pool of API keys to bypass individual rate limits.
// 2. ENSEMBLE MERGING (The "Judge" Pattern): For deep scans, we run 1.5 Pro and 1.5 Flash
//    in parallel. We perform a conservative 'Union Merge'—if either model flags a 
//    violation, it is kept. This maximizes recall for legal compliance.
// 3. LOAD LANES: Real-time user scans (High Priority) are routed to Lane 1 (Keys 1-3).
//    Background tasks (Watcher/Benchmark) are routed to Lane 2 (Keys 4-6).

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function callGemini(
    systemPrompt: string,
    userText: string,
    maxTokens: number,
    timeoutMs: number,
    modelId: string,
    keyPool: string[]
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
    if (!keyPool || keyPool.length === 0) throw new Error('No Gemini keys configured');

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };

    let lastError: any = null;

    // PRIORITY-BASED FAILOVER:
    // We iterate through the pool in the exact order provided.
    // The caller passes [Lane1_Keys, Lane2_Keys] for scans, 
    // or [Lane2_Keys, Lane1_Keys] for utilities.
    for (let attempt = 0; attempt < keyPool.length; attempt++) {
        const apiKey = keyPool[attempt];
        const url = `${GEMINI_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`Gemini key ${attempt} returned ${res.status}`);
                continue;
            }

            if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);

            const json: any = await res.json();
            const parts = json?.candidates?.[0]?.content?.parts ?? [];
            const textPart = parts.filter((p: any) => !p.thought).pop();
            const content = textPart?.text ?? '';
            
            return {
                content: content || '{}',
                inputTokens: json?.usageMetadata?.promptTokenCount ?? 0,
                outputTokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
            };
        } catch (err: any) {
            clearTimeout(timeout);
            lastError = err;
            continue;
        }
    }
    throw lastError;
}

export async function callGeminiEnsemble(
    systemPrompt: string,
    userText: string,
    maxTokens: number,
    timeoutMs: number,
    primaryModel: string,
    corroboratorModel: string,
    keyPool: string[]
): Promise<any> {
    if (!corroboratorModel || corroboratorModel === primaryModel) {
        return { ...await callGemini(systemPrompt, userText, maxTokens, timeoutMs, primaryModel, keyPool), ensemble: false };
    }

    const [pSettled, cSettled] = await Promise.allSettled([
        callGemini(systemPrompt, userText, maxTokens, timeoutMs, primaryModel, keyPool),
        callGemini(systemPrompt, userText, maxTokens, timeoutMs, corroboratorModel, keyPool),
    ]);

    const primary = pSettled.status === 'fulfilled' ? pSettled.value : null;
    const corroborator = cSettled.status === 'fulfilled' ? cSettled.value : null;

    if (!primary && !corroborator) throw (pSettled as any).reason || (cSettled as any).reason;
    if (!corroborator) return { ...primary, ensemble: false };
    if (!primary) return { ...corroborator, ensemble: false };

    // Merge logic: Pillar-by-pillar union of violations
    const pJSON = extractJSON(primary.content);
    const cJSON = extractJSON(corroborator.content);

    if (!pJSON || !cJSON || !pJSON.pillars || !cJSON.pillars) {
        return { ...primary, ensemble: false };
    }

    const mergedPillars: Record<string, any> = { ...pJSON.pillars };
    const confOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };

    for (const key of Object.keys(cJSON.pillars)) {
        const p = pJSON.pillars[key];
        const c = cJSON.pillars[key];
        if (!c) continue;

        if (!p || (c.violation && !p.violation)) {
            // Corroborator found a violation the primary missed
            mergedPillars[key] = c;
        } else if (p.violation && c.violation) {
            // Both found violation, take the one with higher confidence
            const pConf = confOrder[p.confidence as keyof typeof confOrder] || 0;
            const cConf = confOrder[c.confidence as keyof typeof confOrder] || 0;
            if (cConf > pConf) mergedPillars[key] = c;
        }
    }

    return {
        content: JSON.stringify({ ...pJSON, pillars: mergedPillars }),
        inputTokens: primary.inputTokens + corroborator.inputTokens,
        outputTokens: primary.outputTokens + corroborator.outputTokens,
        ensemble: true,
    };
}

function extractJSON(text: string): any {
    try {
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    } catch {
        return null;
    }
}
