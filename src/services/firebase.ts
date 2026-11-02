import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, writeBatch } from 'firebase/firestore';
import { getSyncSettings } from './sync';
import { appCheckSiteKey, isFirebaseWebConfigComplete, resolveFirebaseWebConfig } from '../firebaseConfig';
import type { HostelMeta } from '../types';
import { hostelSchema } from '../schemas';

const APP_NAME = 'hostel-manager-cloud';
let appCheckInstance: AppCheck | null = null;

function getErrorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }
  return '';
}

export function getFirebaseAuthErrorMessage(error: unknown) {
  const code = getErrorCode(error);
  if (!code && error instanceof Error) return error.message;
  switch (code) {
    case 'auth/unauthorized-domain':
      return `This website is not authorized for Google sign-in. In Firebase Console, open Authentication → Settings → Authorized domains and add ${window.location.hostname}.`;
    case 'auth/operation-not-allowed':
      return 'Google sign-in is disabled for this Firebase project. Enable Google under Authentication → Sign-in method.';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid':
      return 'The Firebase API key is invalid. Check the VITE_FIREBASE_API_KEY build setting or the advanced backend configuration.';
    case 'auth/popup-blocked':
      return 'The browser blocked the sign-in popup. Allow popups for this site and try again.';
    case 'auth/popup-closed-by-user':
      return 'The sign-in window was closed before Google sign-in finished.';
    case 'auth/network-request-failed':
      return 'Firebase could not reach its sign-in service. Check your internet connection, then try again.';
    case 'auth/invalid-oauth-client-id':
    case 'auth/unauthorized-client':
      return 'Google OAuth is not configured for this Firebase project. Check the Google provider settings in Firebase Authentication.';
    default:
      return code
        ? `Google sign-in failed (${code}). Check the Firebase Web app configuration, Google provider, and authorized domain.`
        : 'Google sign-in could not start. Check the Firebase Web app configuration, Google provider, and authorized domain.';
  }
}

async function getConfiguredApp(): Promise<FirebaseApp> {
  const settings = await getSyncSettings();
  const config = resolveFirebaseWebConfig(settings?.firebaseConfig);
  if (!isFirebaseWebConfigComplete(config)) {
    throw new Error('Firebase is not configured. Set the VITE_FIREBASE_* build variables or open Advanced: Configure custom Firebase backend.');
  }

  const normalizedConfig = {
    apiKey: config.apiKey.trim(),
    authDomain: config.authDomain.trim(),
    projectId: config.projectId.trim(),
    appId: config.appId.trim(),
  };
  const existingApp = getApps().find((app) => app.name === APP_NAME);
  if (existingApp) {
    const matchesConfig = existingApp.options.apiKey === normalizedConfig.apiKey
      && existingApp.options.projectId === normalizedConfig.projectId
      && existingApp.options.appId === normalizedConfig.appId;
    if (!matchesConfig) {
      throw new Error('Firebase settings changed after initialization. Reload this page and try signing in again.');
    }
  }
  const app = existingApp ?? initializeApp(normalizedConfig, APP_NAME);
  if (appCheckSiteKey && !appCheckInstance) {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

export async function getFirebaseServices() {
  const app = await getConfiguredApp();
  const auth = getAuth(app);
  await setPersistence(auth, indexedDBLocalPersistence);
  return { app, auth, firestore: getFirestore(app) };
}

export async function getFirebaseUser(): Promise<User | null> {
  try {
    const { auth } = await getFirebaseServices();
    const result = await getRedirectResult(auth);
    return result?.user ?? auth.currentUser;
  } catch (error) {
    throw new Error(getFirebaseAuthErrorMessage(error));
  }
}

export async function getCloudHostelProfile(user: User): Promise<HostelMeta | null> {
  const { auth, firestore } = await getFirebaseServices();
  if (auth.currentUser?.uid !== user.uid) {
    throw new Error('Your Google sign-in session changed. Sign in again to load the hostel profile.');
  }
  const [userSnapshot, hostelSnapshot] = await Promise.all([
    getDoc(doc(firestore, 'users', user.uid)),
    getDoc(doc(firestore, 'hostels', user.uid)),
  ]);
  if (!userSnapshot.exists() || !hostelSnapshot.exists()) return null;

  const userData = userSnapshot.data();
  const hostelData = hostelSnapshot.data();
  if (userData.uid !== user.uid || userData.hostelId !== user.uid || hostelData.ownerId !== user.uid) {
    return null;
  }

  const profile = hostelSchema.safeParse({ name: hostelData.name, address: hostelData.address });
  if (!profile.success) {
    throw new Error('The saved cloud hostel profile is incomplete. Contact your administrator or use offline setup.');
  }
  return {
    ...profile.data,
    createdAt: new Date().toISOString(),
  };
}

export async function saveCloudHostelProfile(user: User, profile: HostelMeta): Promise<void> {
  const { auth, firestore } = await getFirebaseServices();
  if (auth.currentUser?.uid !== user.uid) {
    throw new Error('Your Google sign-in session changed. Sign in again before saving the hostel profile.');
  }

  const { uid, email } = user;
  const userRef = doc(firestore, 'users', uid);
  const hostelRef = doc(firestore, 'hostels', uid);
  const batch = writeBatch(firestore);
  batch.set(userRef, { uid, email: email ?? '', hostelId: uid }, { merge: true });
  batch.set(hostelRef, {
    name: profile.name,
    address: profile.address,
    ownerId: uid,
  }, { merge: true });
  await batch.commit();
}

export async function signInToFirebase(): Promise<User | null> {
  try {
    const { auth } = await getFirebaseServices();
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;

    if (standalone) {
      await signInWithRedirect(auth, provider);
      return null;
    }

    try {
      return (await signInWithPopup(auth, provider)).user;
    } catch (error) {
      if (getErrorCode(error) !== 'auth/popup-blocked') throw error;
      await signInWithRedirect(auth, provider);
      return null;
    }
  } catch (error) {
    throw new Error(getFirebaseAuthErrorMessage(error));
  }
}

export async function signOutFromFirebase() {
  try {
    const { auth } = await getFirebaseServices();
    await signOut(auth);
  } catch (error) {
    throw new Error(getFirebaseAuthErrorMessage(error));
  }
}
