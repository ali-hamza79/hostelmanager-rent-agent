import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { FirebaseWebConfig, SyncSettings } from '../types';
import {
  forceFullSync,
  getSyncSettings,
  listSyncFailures,
  retrySyncFailure,
  saveSyncSettings,
  subscribeSyncState,
} from '../services/sync';
import type { SyncQueueItem } from '../services/sync';
import { downloadBackup, restoreBackupFile } from '../services/backup';
import { defaultFirebaseConfig, resolveFirebaseWebConfig } from '../firebaseConfig';

type SettingsProps = {
  hostelName: string;
  hostelAddress: string;
  accountEmail: string | null;
  accountLoading: boolean;
  accountError: string;
  onSaveProfile: (name: string, address: string) => Promise<void>;
  onEraseAll: () => Promise<void>;
  onDataReload: () => Promise<void>;
  onExportReport: (month: string) => void;
  onOpenSignIn: () => void;
  onSignOut: () => Promise<void>;
};

export function Settings({
  hostelName,
  hostelAddress,
  accountEmail,
  accountLoading,
  accountError,
  onSaveProfile,
  onEraseAll,
  onDataReload,
  onExportReport,
  onOpenSignIn,
  onSignOut,
}: SettingsProps) {
  const [name, setName] = useState(hostelName);
  const [address, setAddress] = useState(hostelAddress);
  const [config, setConfig] = useState<FirebaseWebConfig>(defaultFirebaseConfig);
  const [enabled, setEnabled] = useState(false);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState<0 | 15 | 30 | 60>(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [failedItems, setFailedItems] = useState<SyncQueueItem[]>([]);
  const [reportMonth, setReportMonth] = useState(new Date().toISOString().slice(0, 7));
  const backupInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const settings = await getSyncSettings();
        const failures = await listSyncFailures();
        if (!active) return;
        setFailedItems(failures);
        if (settings) {
          setConfig(resolveFirebaseWebConfig(settings.firebaseConfig));
          setEnabled(settings.enabled);
          setSessionTimeoutMinutes(settings.sessionTimeoutMinutes ?? 30);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load cloud settings.');
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSyncState(() => {
      void listSyncFailures().then((items) => {
        if (active) setFailedItems(items);
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not refresh failed sync items.');
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const persistSettings = async (syncEnabled: boolean, firebaseConfig = config, timeout = sessionTimeoutMinutes) => {
    const settings: SyncSettings = { enabled: syncEnabled, firebaseConfig, sessionTimeoutMinutes: timeout };
    await saveSyncSettings(settings);
    setEnabled(syncEnabled);
  };

  const toggleSync = async (checked: boolean) => {
    setError('');
    try {
      await persistSettings(checked);
      setMessage(checked
        ? 'Sync preference saved. Sign in on the account screen to start uploading.'
        : 'Cloud sync disabled. Local data and queued changes are preserved.');
    } catch {
      setError('Could not save this sync preference.');
      setEnabled(!checked);
    }
  };

  const runFullSync = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await forceFullSync();
      setMessage('Full sync completed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Full sync failed.');
    } finally {
      setBusy(false);
    }
  };

  const retryFailure = async (item: SyncQueueItem) => {
    setBusy(true);
    setError('');
    try {
      await retrySyncFailure(item.id);
      setFailedItems(await listSyncFailures());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not retry this sync item.');
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await onSaveProfile(name, address);
      setMessage('Hostel profile saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the hostel profile.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await onSignOut();
      setMessage('Signed out. Your offline data remains on this device.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not sign out of Google.');
    } finally {
      setBusy(false);
    }
  };

  const eraseData = async () => {
    const first = window.confirm('Erase all hostel data from this device? This cannot be undone.');
    if (!first) return;
    const second = window.confirm('Confirm again: all locally stored tenants, rooms, payments, expenses, and sync queue entries will be deleted.');
    if (!second) return;
    setBusy(true);
    try {
      await onEraseAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not erase local data.');
    } finally {
      setBusy(false);
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!window.confirm('Restore this backup? Current local records will be replaced. Cloud settings are preserved, and no data is uploaded automatically.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await restoreBackupFile(file);
      await onDataReload();
      setMessage('Backup restored. Use Force Full Sync if you want to reconcile these records with Firebase.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restore this backup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen-space">
      <h1>Settings</h1>
      <div className="panel form-panel">
        <h3>Hostel profile</h3>
        <div className="field-grid">
          <label><span>Hostel name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
          <label><span>Address</span><input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={250} /></label>
        </div>
        <button className="primary-btn" onClick={() => void saveProfile()} disabled={busy}>Save profile</button>
      </div>

      <div className="panel form-panel">
        <div>
          <h3>Cloud Sync Settings</h3>
          <p className="muted-copy">Optional Firebase sync. IndexedDB remains the primary store and works offline.</p>
        </div>
        <section className="account-section" aria-labelledby="account-section-title">
          <h4 id="account-section-title">Account</h4>
          {accountLoading ? (
            <p className="muted-copy" role="status">Checking Google account…</p>
          ) : accountEmail ? (
            <div className="row-actions">
              <span className="status-chip success"><span aria-hidden="true">✓</span> Signed in as: {accountEmail}</span>
              <button type="button" className="ghost-btn" onClick={() => void signOut()} disabled={busy}>Sign Out</button>
            </div>
          ) : (
            <div className="row-actions">
              <p className="muted-copy">Sign in to sync your hostel records across devices.</p>
              <button type="button" className="primary-btn" onClick={onOpenSignIn}>Sign In to Sync</button>
            </div>
          )}
          {accountError && <p className="sync-error" role="alert">{accountError}</p>}
        </section>
        <p className="muted-copy">Firebase settings are provided by the app configuration. To connect a different Firebase project, open the sign-in screen and expand “Advanced: Configure custom Firebase backend”. Custom settings are encrypted in this browser's IndexedDB.</p>
        <label className="sync-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => void toggleSync(event.target.checked)} disabled={busy} />
          <span>Enable cloud sync</span>
        </label>
        <div className="row-actions">
          <button className="ghost-btn" onClick={() => void runFullSync()} disabled={busy || !enabled}>Force Full Sync</button>
        </div>
        {failedItems.length > 0 && (
          <section aria-labelledby="sync-failures-title">
            <h4 id="sync-failures-title">Sync items needing attention ({failedItems.length})</h4>
            <ul className="list-stack tight">
              {failedItems.map((item) => (
                <li key={item.id}>
                  <span>{item.store.slice(0, -1)} · {item.payload.id}: {item.lastError}</span>
                  <button type="button" className="ghost-btn" onClick={() => void retryFailure(item)} disabled={busy}>Retry</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <label><span>Automatic session lock</span>
          <select value={sessionTimeoutMinutes} onChange={(event) => {
            const timeout = Number(event.target.value) as 0 | 15 | 30 | 60;
            setSessionTimeoutMinutes(timeout);
            void persistSettings(enabled, config, timeout).catch(() => setError('Could not save the session timeout setting.'));
          }}>
            <option value={0}>Disabled</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option>
          </select>
        </label>
        <p className="muted-copy">After the selected idle period, the app returns to the front screen. This is a privacy lock, not a substitute for your device lock screen.</p>
        {message && <p className="sync-message">{message}</p>}
        {error && <p className="sync-error" role="alert">{error}</p>}
      </div>

      <div className="panel">
        <h3>Offline backup and reports</h3>
        <p className="muted-copy">Backups include local profile and records, but exclude Firebase credentials. Restore replaces local records and clears pending sync operations.</p>
        <div className="row-actions">
          <button type="button" className="ghost-btn" onClick={() => void downloadBackup().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not create a backup.'))} disabled={busy}>Download JSON backup</button>
          <button type="button" className="ghost-btn" onClick={() => backupInput.current?.click()} disabled={busy}>Restore JSON backup</button>
          <input ref={backupInput} type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} hidden />
        </div>
        <label><span>Financial report month</span>
          <input type="month" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} />
        </label>
        <button type="button" className="primary-btn" onClick={() => onExportReport(reportMonth)} disabled={!reportMonth}>Export monthly CSV</button>
      </div>

      <div className="panel">
        <h3>Danger zone</h3>
        <button className="danger-btn" onClick={() => void eraseData()} disabled={busy}>Erase all local data</button>
      </div>
    </div>
  );
}
