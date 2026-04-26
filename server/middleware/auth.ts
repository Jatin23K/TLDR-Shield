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
    // 1. Check for Master Admin Key Header (Automation/Maintenance)
    const internalKey = req.headers['x-internal-key'];
    const masterKey = process.env.INTERNAL_API_KEY;
    
    if (masterKey && internalKey === masterKey) {
        (req as any).uid = 'SYSTEM_ADMIN';
        (req as any).isAdmin = true;
        return next();
    }

    // 2. Fallback to Firebase User Auth
    const authHeader = (req.headers.authorization ?? '').toString();
    if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
    }
    const token = authHeader.slice(7).trim();

    try {
        const { getAuth } = await import('firebase-admin/auth');
        const { getFirestore } = await import('firebase-admin/firestore');
        
        const decoded = await getAuth().verifyIdToken(token);
        const uid = decoded.uid;
        (req as any).uid = uid;

        // 3. Check Firestore for ADMIN role
        const db = getFirestore();
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data();
        
        const isEmailAdmin = decoded.email === process.env.ADMIN_EMAIL;
        const hasAdminRole = userData?.role === 'ADMIN';

        (req as any).isAdmin = isEmailAdmin && hasAdminRole;
        
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    }
}

