import type { Request, Response, NextFunction } from 'express';

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
        return null;
    }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const uid = await getUidFromRequest(req);
    if (!uid) {
        return res.status(401).json({ error: 'Unauthorized. Please sign in to scan.' });
    }
    (req as any).uid = uid;
    next();
}
