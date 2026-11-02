import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSyncSettings, getSyncState, retrySyncQueueNow, subscribeSyncState } from '../services/sync';

type Props = {
  compact?: boolean;
};

export function SyncPill({ compact = false }: Props) {
  const state = useSyncExternalStore(subscribeSyncState, getSyncState, getSyncState);
  const [cloudEnabled, setCloudEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getSyncSettings().then((settings) => {
        if (active) setCloudEnabled(Boolean(settings?.enabled));
      }).catch(() => {
        if (active) setCloudEnabled(false);
      });
    };
    refresh();
    const unsubscribe = subscribeSyncState(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const status = compact && state.status === 'synced' && !cloudEnabled ? 'offline' : state.status;
  const label = compact && status === 'synced'
    ? 'Cloud Synced'
    : status === 'offline'
    ? 'Offline'
    : status === 'syncing'
      ? 'Syncing...'
      : status === 'error'
        ? 'Sync Error / Retry'
        : 'Synced';
  const queueSummary = `${state.pending} pending change${state.pending === 1 ? '' : 's'}`
    + (state.failed ? `, ${state.failed} failed` : '');

  return (
    <button
      type="button"
      className={`sync-pill ${status}${compact ? ' compact' : ''}`}
      title={state.error || queueSummary}
      role="status"
      aria-live="polite"
      aria-label={`${label}. ${queueSummary}${status === 'error' ? '. Activate to retry synchronization.' : ''}`}
      onClick={() => { if (status === 'error') void retrySyncQueueNow(); }}
    >
      <span className="sync-dot" aria-hidden="true" />
      {label}
      {state.pending > 0 && <span className="sync-count">{state.pending}</span>}
    </button>
  );
}
