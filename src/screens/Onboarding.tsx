import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type { FirebaseWebConfig, HostelMeta } from '../types';
import { hostelSchema } from '../schemas';
import { forceFullSync, getSyncSettings, saveSyncSettings } from '../services/sync';
import { saveMeta } from '../db/repo';
import { defaultFirebaseConfig, isFirebaseWebConfigComplete, resolveFirebaseWebConfig } from '../firebaseConfig';
import { SyncPill } from '../components/SyncPill';
import { resolveAuthDestination, type AuthDestination } from './authRouting';

type Props = {
  existingProfile: HostelMeta | null;
  onComplete: (profile: HostelMeta) => Promise<void>;
  onBack?: () => void;
};

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="20" height="20">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" transform="translate(0 5)" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94a11.05 11.05 0 0 1-4.8 7.24l7.73 5.99c4.51-4.17 7.11-10.31 7.11-17.7Z" />
      <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19Z" transform="translate(0 5)" />
      <path fill="#34A853" d="M24 48c6.47 0 11.91-2.13 15.87-5.8l-7.73-5.99c-2.14 1.44-4.88 2.29-8.14 2.29-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" transform="translate(0 -5)" />
    </svg>
  );
}

export function Onboarding({ existingProfile, onComplete, onBack }: Props) {
  const [name, setName] = useState(existingProfile?.name ?? '');
  const [address, setAddress] = useState(existingProfile?.address ?? '');
  const [config, setConfig] = useState<FirebaseWebConfig>(defaultFirebaseConfig);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authDestination, setAuthDestination] = useState<AuthDestination | 'checking'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [advancedConfigOpen, setAdvancedConfigOpen] = useState(false);
  const [showOfflineSetup, setShowOfflineSetup] = useState(false);
  const onCompleteRef = useRef(onComplete);
  const handledAuthUidRef = useRef<string | null>(null);
  const authStateHandlerRef = useRef<(user: User | null) => Promise<void>>(async () => undefined);

  onCompleteRef.current = onComplete;

  const handleAuthState = async (user: User | null) => {
    if (!user) {
      handledAuthUidRef.current = null;
      setAuthUser(null);
      setAuthDestination(resolveAuthDestination(false, false, false));
      return;
    }
    if (handledAuthUidRef.current === user.uid) return;
    handledAuthUidRef.current = user.uid;
    setAuthUser(user);
    setAuthDestination('checking');
    setShowOfflineSetup(true);
    setName((current) => current.trim() || existingProfile?.name || user.displayName || '');
    setAddress((current) => current.trim() || existingProfile?.address || '');
    sessionStorage.removeItem('hostel-google-redirect-pending');

    try {
      const { getCloudHostelProfile } = await import('../services/firebase');
      const profile = await getCloudHostelProfile(user);
      const destination = resolveAuthDestination(true, Boolean(profile), Boolean(profile));
      if (destination === 'dashboard' && profile) {
        await saveMeta(profile);
        await onCompleteRef.current(profile);
        return;
      }
      setAuthDestination(destination);
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : 'Could not load your cloud hostel profile. Check your connection and try again.');
      setAuthDestination(resolveAuthDestination(true, false, false));
    }
  };
  authStateHandlerRef.current = handleAuthState;

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const settings = await getSyncSettings();
        if (active) setConfig(resolveFirebaseWebConfig(settings?.firebaseConfig));

        const [{ getFirebaseServices }, { onAuthStateChanged, getRedirectResult }] = await Promise.all([
          import('../services/firebase'),
          import('firebase/auth'),
        ]);
        const { auth } = await getFirebaseServices();
        if (!active) return;
        unsubscribe = onAuthStateChanged(auth, (user) => {
          if (active) void authStateHandlerRef.current(user);
        });
        const redirect = await getRedirectResult(auth);
        if (active && redirect?.user) await authStateHandlerRef.current(redirect.user);
        if (active) sessionStorage.removeItem('hostel-google-redirect-pending');
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error
          ? reason.message
          : 'Saved cloud settings could not be opened. Check the Firebase configuration.');
        if (!unsubscribe) setAuthDestination('login');
      }
    })();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const connectGoogle = async () => {
    setError('');
    setMessage('');
    if (!isFirebaseWebConfigComplete(config)) {
      setAdvancedConfigOpen(true);
      setError('Google sign-in needs Firebase Web app settings. Configure the app with VITE_FIREBASE_* values or enter your project details below.');
      return;
    }

    setBusy(true);
    try {
      await saveSyncSettings({ enabled: false, firebaseConfig: config });
      sessionStorage.setItem('hostel-google-redirect-pending', 'true');
      const { signInToFirebase } = await import('../services/firebase');
      const user = await signInToFirebase();
      if (!user) {
        setMessage('Continuing Google sign-in in your browser. Return here when authentication completes.');
      } else {
        await authStateHandlerRef.current(user);
      }
    } catch (reason) {
      sessionStorage.removeItem('hostel-google-redirect-pending');
      setError(reason instanceof Error
        ? reason.message
        : 'Google sign-in could not start. Check the Firebase Web app configuration, Google provider, and authorized domain.');
    } finally {
      setBusy(false);
    }
  };

  const saveCustomConfig = async () => {
    setError('');
    setMessage('');
    if (!isFirebaseWebConfigComplete(config)) {
      setError('Enter the API key, auth domain, project ID, and app ID to save this backend.');
      return;
    }
    setBusy(true);
    try {
      await saveSyncSettings({ enabled: false, firebaseConfig: config });
      setMessage('Custom Firebase backend saved securely on this device.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the custom Firebase backend.');
    } finally {
      setBusy(false);
    }
  };

  const saveHostelProfile = async (syncToCloud: boolean) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const trimmedName = name.trim();
      const trimmedAddress = address.trim();
      if (!trimmedName || !trimmedAddress) {
        setError('Please enter both hostel name and address before continuing.');
        return;
      }
      const parsed = hostelSchema.parse({ name: trimmedName, address: trimmedAddress });
      const profile: HostelMeta = {
        name: parsed.name,
        address: parsed.address,
        createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
      };

      if (syncToCloud && authUser) {
        const { saveCloudHostelProfile } = await import('../services/firebase');
        await saveCloudHostelProfile(authUser, profile);
      }
      await saveMeta(profile);
      if (syncToCloud && authUser) {
        const currentSettings = await getSyncSettings();
        await saveSyncSettings({
          enabled: true,
          firebaseConfig: config,
          sessionTimeoutMinutes: currentSettings?.sessionTimeoutMinutes,
        }, false);
        await forceFullSync();
      }
      await onComplete(profile);
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : 'Could not save the hostel profile. Please check the details and try again.');
    } finally {
      setBusy(false);
    }
  };

  const skipToOffline = () => {
    setError('');
    setMessage('');
    if (existingProfile && onBack) {
      onBack();
      return;
    }
    setShowOfflineSetup(true);
  };

  if (authDestination === 'checking') {
    return <div className="loading-screen" role="status">Checking your sign-in…</div>;
  }

  if (authDestination === 'setup' && authUser) {
    return (
      <div className="landing-page">
        <section className="landing-card panel">
          <div className="landing-status"><SyncPill compact /></div>
          <div className="landing-heading">
            <div className="brand-mark" aria-hidden="true">H</div>
            <h1>Set up your hostel</h1>
            <p className="muted-copy">
              {`Signed in with Google${authUser.email ? ` as ${authUser.email}` : ''}. `}
              {existingProfile
                ? 'Save this hostel to your account to sync it across devices.'
                : 'No hostel profile was found for this account. Add its details to continue.'}
            </p>
          </div>
          <div className="field-grid">
            <label><span>Hostel name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="organization" /></label>
            <label><span>Address</span><input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={250} autoComplete="street-address" /></label>
          </div>
          <button type="button" className="primary-btn" onClick={() => void saveHostelProfile(true)} disabled={busy}>
            {busy ? 'Saving…' : 'Save hostel and open dashboard'}
          </button>
          <button type="button" className="offline-link" onClick={() => void saveHostelProfile(false)} disabled={busy}>
            Continue offline instead
          </button>
          {error && <p className="sync-error" role="alert">{error}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="landing-page">
      <section className="landing-card panel">
        <div className="landing-status"><SyncPill compact /></div>
        <div className="landing-heading">
          <div className="brand-mark" aria-hidden="true">H</div>
          <h1>Welcome to Hostel Manager</h1>
          <p className="muted-copy">Sign in to securely sync your hostel records across devices.</p>
        </div>

        <button type="button" className="google-btn" onClick={() => void connectGoogle()} disabled={busy}>
          <GoogleMark />
          <span>{busy ? 'Please wait…' : 'Continue with Google'}</span>
        </button>

        <button type="button" className="offline-link" onClick={skipToOffline} disabled={busy}>
          Skip for now (Offline Mode)
        </button>

        {showOfflineSetup && (
          <div className="landing-setup">
            <h2>Set up your hostel for offline use</h2>
            <p className="muted-copy">These details stay on this device. A hostel name and address are required before opening the dashboard.</p>
            <div className="field-grid">
              <label><span>Hostel name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="organization" /></label>
              <label><span>Address</span><input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={250} autoComplete="street-address" /></label>
            </div>
            <button type="button" className="primary-btn" onClick={() => void saveHostelProfile(false)} disabled={busy}>
              {busy ? 'Please wait…' : 'Continue offline'}
            </button>
          </div>
        )}

        {existingProfile && onBack && <button type="button" className="ghost-btn" onClick={onBack} disabled={busy}>Back to Hostel Manager</button>}

        <div className="advanced-config">
          <button
            type="button"
            className="advanced-config-toggle"
            aria-expanded={advancedConfigOpen}
            onClick={() => setAdvancedConfigOpen((open) => !open)}
          >
            <span>Advanced: Configure custom Firebase backend</span>
            <span aria-hidden="true">{advancedConfigOpen ? '▲' : '▼'}</span>
          </button>
          {advancedConfigOpen && (
            <div className="advanced-config-fields">
              <p className="muted-copy">These are public Firebase Web app settings, not private keys. Build-time app settings are used when no custom configuration is saved.</p>
              <div className="field-grid">
                <label><span>Firebase API key</span><input value={config.apiKey} onChange={(event) => setConfig({ ...config, apiKey: event.target.value })} autoComplete="off" /></label>
                <label><span>Auth domain</span><input value={config.authDomain} onChange={(event) => setConfig({ ...config, authDomain: event.target.value })} placeholder="your-project.firebaseapp.com" autoComplete="off" /></label>
                <label><span>Project ID</span><input value={config.projectId} onChange={(event) => setConfig({ ...config, projectId: event.target.value })} autoComplete="off" /></label>
                <label><span>App ID</span><input value={config.appId} onChange={(event) => setConfig({ ...config, appId: event.target.value })} autoComplete="off" /></label>
              </div>
              <button type="button" className="ghost-btn" onClick={() => void saveCustomConfig()} disabled={busy}>Save custom backend</button>
            </div>
          )}
        </div>

        {message && <p className="sync-message" role="status">{message}</p>}
        {error && <p className="sync-error" role="alert">{error}</p>}
        <small className="privacy-note">By signing in, you agree to our <a href="/privacy">Privacy Policy</a>.</small>
      </section>
    </div>
  );
}
