import type { Firestore } from 'firebase-admin/firestore';

const FREE_CREDITS = 400;

export type CreditResult = {
    ok: boolean;
    creditsLeft: number;
    error?: string;
    reason?: 'insufficient' | 'unavailable';
};

function getCurrentMonth(): string {
    return new Date().toISOString().slice(0, 7);
}

export async function checkAndDeductCredits(
    firestoreDb: Firestore | null,
    uid: string,
    cost: number,
    allowUnmetered: boolean = false
): Promise<CreditResult> {
    if (!firestoreDb) {
        if (allowUnmetered) return { ok: true, creditsLeft: -1 };
        return {
            ok: false,
            creditsLeft: 0,
            reason: 'unavailable',
            error: 'Credit service is temporarily unavailable.',
        };
    }

    const currentMonth = getCurrentMonth();
    const userRef = firestoreDb.collection('users').doc(uid);

    try {
        return await firestoreDb.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            let credits = FREE_CREDITS;
            let lastResetMonth = '';

            if (snap.exists) {
                const d = snap.data()!;
                credits = typeof d.credits === 'number' ? d.credits : FREE_CREDITS;
                lastResetMonth = d.lastResetMonth ?? '';
            }

            if (lastResetMonth !== currentMonth) {
                credits = FREE_CREDITS;
                lastResetMonth = currentMonth;
            }

            if (credits < cost) {
                return {
                    ok: false,
                    creditsLeft: credits,
                    reason: 'insufficient',
                    error: `Insufficient credits. Need ${cost}, have ${credits}.`,
                };
            }

            const newCredits = credits - cost;
            tx.set(userRef, { uid, credits: newCredits, lastResetMonth }, { merge: true });
            return { ok: true, creditsLeft: newCredits };
        });
    } catch (err: any) {
        console.error('[CreditService] Transaction failed:', err?.message);
        if (allowUnmetered) return { ok: true, creditsLeft: -1 };
        return { ok: false, creditsLeft: 0, reason: 'unavailable' };
    }
}

export async function refundCredits(firestoreDb: Firestore | null, uid: string, amount: number): Promise<number | null> {
    if (!firestoreDb || amount <= 0) return null;
    const currentMonth = getCurrentMonth();
    const userRef = firestoreDb.collection('users').doc(uid);

    try {
        return await firestoreDb.runTransaction(async (tx) => {
            const snap = await tx.get(userRef);
            let credits = FREE_CREDITS;
            let lastResetMonth = '';

            if (snap.exists) {
                const d = snap.data()!;
                credits = typeof d.credits === 'number' ? d.credits : FREE_CREDITS;
                lastResetMonth = d.lastResetMonth ?? '';
            }

            if (lastResetMonth !== currentMonth) {
                credits = FREE_CREDITS;
                lastResetMonth = currentMonth;
            }

            const newCredits = credits + amount;
            tx.set(userRef, { uid, credits: newCredits, lastResetMonth }, { merge: true });
            return newCredits;
        });
    } catch {
        return null;
    }
}
export async function getUserCredits(
    firestoreDb: Firestore | null,
    uid: string
): Promise<number> {
    if (!firestoreDb) return -1;
    const userRef = firestoreDb.collection('users').doc(uid);
    try {
        const snap = await userRef.get();
        if (!snap.exists) return FREE_CREDITS;
        const d = snap.data()!;
        const currentMonth = getCurrentMonth();
        if (d.lastResetMonth !== currentMonth) return FREE_CREDITS;
        return typeof d.credits === 'number' ? d.credits : FREE_CREDITS;
    } catch {
        return -1;
    }
}
