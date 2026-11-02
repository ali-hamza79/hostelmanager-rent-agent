import type { FirebaseWebConfig } from './types';

export const defaultFirebaseConfig: FirebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() || 'AIzaSyB-IIf3YFO9m35HLUrO2Oinz-0ULcXm4lA',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || 'hostelmanager-79bab.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() || 'hostelmanager-79bab',
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() || '1:952825706845:web:b0bfa1b71aa12c3459d0b4',
};

export const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY?.trim() ?? '';

export function isFirebaseWebConfigComplete(
  config: FirebaseWebConfig | null | undefined,
): config is FirebaseWebConfig {
  return Boolean(
    config?.apiKey.trim()
    && config.authDomain.trim()
    && config.projectId.trim()
    && config.appId.trim(),
  );
}

export function resolveFirebaseWebConfig(savedConfig?: FirebaseWebConfig | null): FirebaseWebConfig {
  return isFirebaseWebConfigComplete(savedConfig) ? savedConfig : defaultFirebaseConfig;
}
