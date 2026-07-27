import type { Firestore } from 'firebase-admin/firestore';

const SHARED_CACHE_COLLECTION = 'shared_cache';
const SHARED_CACHE_TTL_MS: Record<string, number> = {
    quick: 48 * 60 * 60 * 1000,
    deep: 7 * 24 * 60 * 60 * 1000,
};

let _Timestamp: any = null;
let _FieldValue: any = null;

async function getFirestoreHelpers() {
    if (!_Timestamp) {
        const m = await import('firebase-admin/firestore');
        _Timestamp = m.Timestamp;
        _FieldValue = m.FieldValue;
    }
    return { Timestamp: _Timestamp, FieldValue: _FieldValue };
}

export async function getSharedCache(firestoreDb: Firestore | null, hash: string): Promise<any | null> {
    if (!firestoreDb) return null;
    try {
        const doc = await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).get();
        if (!doc.exists) return null;
        const data = doc.data()!;
        if (data.expiresAt.toMillis() < Date.now()) return null;
        return { ...data.result, _scannedAt: data.scannedAt?.toMillis?.() ?? Date.now() };
    } catch {
        return null;
    }
}

export async function setSharedCache(
    firestoreDb: Firestore | null,
    hash: string,
    result: any,
    tier: string,
    sourceUrlHash?: string | null
): Promise<void> {
    if (!firestoreDb) return;
    try {
        const { Timestamp, FieldValue } = await getFirestoreHelpers();
        const ttl = SHARED_CACHE_TTL_MS[tier] ?? SHARED_CACHE_TTL_MS.quick;
        await firestoreDb.collection(SHARED_CACHE_COLLECTION).doc(hash).set({
            result,
            tier,
            ...(sourceUrlHash ? { sourceUrlHash } : {}),
            scannedAt: Timestamp.now(),
            expiresAt: Timestamp.fromMillis(Date.now() + ttl),
            scanCount: FieldValue.increment(1),
        }, { merge: true });
        console.log(`[DatabaseService] shared_cache written: ${hash} (tier=${tier})`);
    } catch (err: any) {
        console.warn(`[DatabaseService] Cache write failed for hash=${hash}: ${err?.message}`);
    }
}

export async function saveScanRecord(
    firestoreDb: Firestore | null,
    uid: string,
    result: any,
    meta: any
): Promise<void> {
    if (!firestoreDb) return;
    try {
        const { Timestamp } = await getFirestoreHelpers();
        await firestoreDb.collection('scans').add({
            uid,
            url: meta.url,
            rating: result?.rating || 'RISKY',
            score: result?.score || 0,
            tldr: result?.tldr || '',
            pillars: result?.pillars || {},
            tier: meta.tier,
            model: meta.modelId,
            cached: meta.cached,
            latencyMs: meta.latencyMs,
            requestId: meta.requestId,
            createdAt: Timestamp.now(),
        });
    } catch (err: any) {
        console.warn(`[DatabaseService] Scan record failed: ${err?.message}`);
    }
}
export async function saveReport(
    firestoreDb: Firestore | null,
    uid: string,
    data: any
): Promise<void> {
    if (!firestoreDb) return;
    try {
        const { Timestamp } = await getFirestoreHelpers();
        await firestoreDb.collection('reports').add({
            uid,
            url: data.url,
            rating: data.rating,
            score: data.score,
            pillars: data.pillars,
            requestId: data.requestId,
            comment: data.comment,
            userAgent: data.userAgent,
            createdAt: Timestamp.now(),
        });
    } catch (err: any) {
        console.warn(`[DatabaseService] Report save failed: ${err?.message}`);
    }
}
