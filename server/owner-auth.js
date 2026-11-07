import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function firebaseAuth() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured.');
  const app = getApps().find((candidate) => candidate.name === 'rent-order-owner')
    ?? initializeApp({ projectId }, 'rent-order-owner');
  return getAuth(app);
}

export function createRequireOwner({
  ownerUid,
  projectId,
  verifyToken = (token) => firebaseAuth().verifyIdToken(token),
} = {}) {
  return async function requireOwnerMiddleware(req, res, next) {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) return res.status(401).json({ error: 'Owner sign-in required.' });

    const expectedOwnerUid = ownerUid === undefined ? process.env.OWNER_UID : ownerUid;
    const expectedProjectId = projectId === undefined ? process.env.FIREBASE_PROJECT_ID : projectId;
    if (!expectedOwnerUid || !expectedProjectId) {
      return res.status(503).json({ error: 'Owner authentication is not configured on the server.' });
    }

    try {
      const decoded = await verifyToken(match[1]);
      if (decoded.uid !== expectedOwnerUid) {
        return res.status(403).json({ error: 'This account is not the configured hostel owner.' });
      }
      req.ownerUid = decoded.uid;
      return next();
    } catch {
      return res.status(401).json({ error: 'Owner sign-in token is invalid or expired.' });
    }
  };
}

export async function requireOwner(req, res, next) {
  return createRequireOwner()(req, res, next);
}
