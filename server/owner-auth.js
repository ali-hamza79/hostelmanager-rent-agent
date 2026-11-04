import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function firebaseAuth() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured.');
  const app = getApps().find((candidate) => candidate.name === 'rent-order-owner')
    ?? initializeApp({ projectId }, 'rent-order-owner');
  return getAuth(app);
}

export async function requireOwner(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return res.status(401).json({ error: 'Owner sign-in required.' });

  const ownerUid = process.env.OWNER_UID;
  if (!ownerUid || !process.env.FIREBASE_PROJECT_ID) {
    return res.status(503).json({ error: 'Owner authentication is not configured on the server.' });
  }

  try {
    const decoded = await firebaseAuth().verifyIdToken(match[1]);
    if (decoded.uid !== ownerUid) return res.status(403).json({ error: 'This account is not the configured hostel owner.' });
    req.ownerUid = decoded.uid;
    return next();
  } catch {
    return res.status(401).json({ error: 'Owner sign-in token is invalid or expired.' });
  }
}
