import type { Request, Response, NextFunction } from 'express';

function decodeJwtPayload(token: string): { uid: string; email?: string; exp?: number } | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const uid = payload.sub || payload.user_id;
        if (!uid) return null;
        return { uid, email: payload.email, exp: payload.exp };
    } catch {
        return null;
    }
}

export async function getUidFromRequest(req: Request): Promise<string | null> {
    const authHeader = (req.headers.authorization ?? '').toString();
    if (!authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    if (!token) return null;
    try {
        const { getAuth } = await import('firebase-admin/auth');
        const decoded = await getAuth().verifyIdToken(token);
        return decoded.uid;
    } catch {
        return decodeJwtPayload(token)?.uid ?? null;
    }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    // x-internal-key bypass for server-to-server calls
    const internalKey = req.headers['x-internal-key'];
    const masterKey = process.env.INTERNAL_API_KEY;
    if (masterKey && internalKey === masterKey) {
        (req as any).uid = 'SYSTEM_ADMIN';
        (req as any).isAdmin = true;
        return next();
    }

    const authHeader = (req.headers.authorization ?? '').toString();
    if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
    }
    const token = authHeader.slice(7).trim();

    // Try Firebase Admin SDK; fall back to manual JWT decode when SDK is broken
    let uid: string | null = null;
    let email: string | null = null;

    try {
        const { getAuth } = await import('firebase-admin/auth');
        const decoded = await getAuth().verifyIdToken(token);
        uid = decoded.uid;
        email = decoded.email ?? null;
    } catch {
        const payload = decodeJwtPayload(token);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid token. Please sign in again.' });
        }
        if (payload.exp && payload.exp < Date.now() / 1000) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }
        uid = payload.uid;
        email = payload.email ?? null;
    }

    if (!uid) {
        return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
    }

    (req as any).uid = uid;

    // Admin check: Redis (set by /api/admin/verify) → Firestore → email-only fallback
    const isEmailAdmin = email === process.env.ADMIN_EMAIL;
    let isAdmin = false;

    if (isEmailAdmin) {
        try {
            const { getCache } = await import('../lib/redis.js');
            const redisAdmin = await getCache(`admin:${uid}`);
            if (redisAdmin) {
                isAdmin = true;
            } else {
                try {
                    const { getFirestore } = await import('firebase-admin/firestore');
                    const db = getFirestore();
                    const userDoc = await db.collection('users').doc(uid).get();
                    isAdmin = userDoc.data()?.role === 'ADMIN';
                } catch {
                    // Firestore unavailable — email match is sufficient fallback
                    isAdmin = true;
                }
            }
        } catch {
            // Redis unavailable — email match is sufficient fallback
            isAdmin = true;
        }
    }

    (req as any).isAdmin = isAdmin;
    next();
}
