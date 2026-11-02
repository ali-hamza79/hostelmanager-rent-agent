import { IDBPTransaction } from 'idb';
import type { DocumentData } from 'firebase/firestore';
import { dbPromise } from '../db/idb';
import type { SyncSettings } from '../types';

export type SyncStoreName = 'tenants' | 'rooms' | 'payments' | 'expenses';
export type SyncAction = 'upsert' | 'delete';
export type SyncQueueItem = {
  id: string;
  action: SyncAction;
  store: SyncStoreName;
  payload: Record<string, unknown> & { id: string };
  createdAt: string;
  sequence: number;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  failed?: boolean;
  lastErrorCode?: string;
};

export type SyncState = {
  status: 'offline' | 'synced' | 'syncing' | 'error';
  pending: number;
  failed: number;
  error?: string;
};

const collectionNames: Record<SyncStoreName, string> = {
  rooms: 'Rooms',
  tenants: 'Tenants',
  payments: 'Payments',
  expenses: 'Expenses',
};

let state: SyncState = {
  status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'synced',
  pending: 0,
  failed: 0,
};
const listeners = new Set<() => void>();
let processing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let sequenceSeed = Date.now() * 1000;

function publish(next: Partial<SyncState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getSyncState() {
  return state;
}

export function subscribeSyncState(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getSyncSettings(): Promise<SyncSettings | null> {
  const db = await dbPromise;
  const encrypted = await db.get('meta', 'syncSettingsEncrypted');
  if (encrypted?.ciphertext && encrypted?.iv) {
    const keyEntry = await db.get('meta', 'syncSettingsCryptoKey');
    const key = keyEntry?.value as CryptoKey | undefined;
    if (!key) throw new Error('Saved sync settings are locked on this device. Clear and re-enter the Firebase configuration.');
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(encrypted.iv as number[]) },
        key,
        Uint8Array.from(atob(encrypted.ciphertext as string), (character) => character.charCodeAt(0)),
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as SyncSettings;
    } catch {
      throw new Error('Saved sync settings could not be decrypted. Clear and re-enter the Firebase configuration.');
    }
  }

  const legacy = await db.get('meta', 'syncSettings');
  const settings = legacy?.value as SyncSettings | undefined;
  if (settings) {
    await saveSyncSettings(settings);
    await db.delete('meta', 'syncSettings');
  }
  return settings ?? null;
}

export async function saveSyncSettings(settings: SyncSettings, triggerProcessing = true) {
  const db = await dbPromise;
  let keyEntry = await db.get('meta', 'syncSettingsCryptoKey');
  let key = keyEntry?.value as CryptoKey | undefined;
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await db.put('meta', { key: 'syncSettingsCryptoKey', value: key });
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(settings)),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  await db.put('meta', { key: 'syncSettingsEncrypted', iv: Array.from(iv), ciphertext: encoded });
  await db.delete('meta', 'syncSettings');
  if (!settings.enabled) {
    publish({ status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'synced', error: undefined });
    return;
  }
  if (triggerProcessing) notifySyncQueueChanged();
}

export async function enqueueSync(
  action: SyncAction,
  store: SyncStoreName,
  payload: Record<string, unknown> & { id: string },
  tx?: IDBPTransaction<any, any, 'readwrite'>,
  triggerProcessing = true,
) {
  const item: SyncQueueItem = {
    id: crypto.randomUUID(),
    action,
    store,
    payload,
    createdAt: new Date().toISOString(),
    sequence: ++sequenceSeed,
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
  };
  if (tx) {
    await tx.objectStore('syncQueue').put(item);
  } else {
    const db = await dbPromise;
    await db.put('syncQueue', item);
  }
  if (triggerProcessing) notifySyncQueueChanged();
}

export function notifySyncQueueChanged() {
  void updatePendingCount().then(() => processSyncQueue()).catch((error: unknown) => {
    publish({
      status: 'error',
      error: error instanceof Error ? error.message : 'Could not update the sync queue.',
    });
  });
}

export async function retrySyncQueueNow() {
  const db = await dbPromise;
  const queue = await db.getAll('syncQueue') as SyncQueueItem[];
  queue.sort((a, b) => a.sequence - b.sequence);
  const first = queue.find((item) => item.failed) ?? queue[0];
  if (first) {
    await db.put('syncQueue', {
      ...first,
      failed: false,
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
    });
  }
  await processSyncQueue();
}

export async function listSyncFailures() {
  const db = await dbPromise;
  return (await db.getAll('syncQueue') as SyncQueueItem[])
    .filter((item) => item.failed)
    .sort((a, b) => a.sequence - b.sequence);
}

export async function retrySyncFailure(id: string) {
  const db = await dbPromise;
  const item = await db.get('syncQueue', id) as SyncQueueItem | undefined;
  if (!item) throw new Error('The failed sync item no longer exists.');
  await db.put('syncQueue', {
    ...item,
    failed: false,
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
  });
  await processSyncQueue();
}

async function updatePendingCount() {
  const db = await dbPromise;
  const queue = await db.getAll('syncQueue') as SyncQueueItem[];
  publish({ pending: queue.length, failed: queue.filter((item) => item.failed).length });
}

function payloadTimestamp(payload: Record<string, unknown>, fallback: string) {
  const value = typeof payload.updatedAt === 'string'
    ? payload.updatedAt
    : typeof payload.createdAt === 'string'
      ? payload.createdAt
      : fallback;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const fallbackTime = Date.parse(fallback);
  return Number.isNaN(fallbackTime) ? 0 : fallbackTime;
}

function remoteTimestamp(data: DocumentData, fallback?: Date) {
  const stamp = typeof data.updatedAt === 'string'
    ? data.updatedAt
    : typeof data.createdAt === 'string'
      ? data.createdAt
      : fallback?.toISOString();
  const parsed = stamp ? Date.parse(stamp) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function applyRemote(store: SyncStoreName, id: string, data: DocumentData) {
  const db = await dbPromise;
  await db.put(store, { ...data, id });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hostel-sync-updated'));
}

async function requireEnabledSettings() {
  let settings: SyncSettings | null;
  try {
    settings = await getSyncSettings();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Saved cloud settings could not be opened.');
  }
  if (!settings?.enabled) throw new Error('Cloud sync is turned off in Settings.');
  return settings;
}

async function remoteRef(store: SyncStoreName, id: string) {
  const [{ getFirebaseServices }, { doc }] = await Promise.all([
    import('./firebase'),
    import('firebase/firestore'),
  ]);
  const { auth, firestore } = await getFirebaseServices();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to Firebase in Settings to synchronize records.');
  return doc(firestore, 'hostels', user.uid, collectionNames[store], id);
}

async function processItem(item: SyncQueueItem) {
  const { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, where } =
    await import('firebase/firestore');
  const ref = await remoteRef(item.store, item.payload.id);
  const remote = await getDoc(ref);
  if (remote.exists()) {
    const remoteData = remote.data();
    const cloudTime = remoteTimestamp(remoteData);
    const localTime = payloadTimestamp(item.payload, item.createdAt);
    if (cloudTime > localTime) {
      await applyRemote(item.store, item.payload.id, remoteData);
      return;
    }
  }

  if (item.action === 'delete') {
    if (remote.exists()) {
      const current = remote.data();
      await setDoc(ref, {
        ...current,
        updatedAt: item.payload.updatedAt ?? new Date().toISOString(),
        deletedAt: item.payload.deletedAt ?? new Date().toISOString(),
      });
    }
    return;
  }

  const data = Object.fromEntries(
    Object.entries(item.payload).filter(([key, value]) => key !== 'id' && value !== undefined),
  );
  if (item.store === 'tenants') {
    const { auth, firestore } = await (await import('./firebase')).getFirebaseServices();
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in to Firebase in Settings to synchronize records.');
    const tenantId = item.payload.id;
    const nextFloor = String(data.floor);
    const nextRoomName = String(data.room);
    const nextRoom = `${nextFloor}_${nextRoomName}`;
    const oldTenantData = remote.exists() ? remote.data() : null;
    const oldRoom = oldTenantData?.status === 'Active' && !oldTenantData.deletedAt
      ? `${String(oldTenantData.floor)}_${String(oldTenantData.room)}`
      : null;
    const findRoomRef = async (floor: string, roomName: string) => {
      const roomQuery = query(
        collection(firestore, 'hostels', user.uid, 'Rooms'),
        where('floor', '==', floor),
        where('room', '==', roomName),
      );
      const rooms = await getDocs(roomQuery);
      if (rooms.docs.length > 1) {
        const duplicateError = new Error('Multiple cloud rooms have the same floor and room labels.') as Error & { code?: string };
        duplicateError.code = 'failed-precondition';
        throw duplicateError;
      }
      return rooms.docs[0]?.ref ?? doc(firestore, 'hostels', user.uid, 'Rooms', `${floor}_${roomName}`);
    };
    const newRoomRef = await findRoomRef(nextFloor, nextRoomName);
    const previousRoomRef = oldTenantData
      ? await findRoomRef(String(oldTenantData.floor), String(oldTenantData.room))
      : null;
    const legacyOccupants = new Map<string, string[]>();
    const roomsToSeed = new Map<string, { floor: string; room: string }>([
      [nextRoom, { floor: nextFloor, room: nextRoomName }],
    ]);
    if (oldRoom && oldTenantData) {
      roomsToSeed.set(oldRoom, { floor: String(oldTenantData.floor), room: String(oldTenantData.room) });
    }
    for (const [roomKey, roomLabels] of roomsToSeed) {
      const tenantQuery = query(
        collection(firestore, 'hostels', user.uid, 'Tenants'),
        where('floor', '==', roomLabels.floor),
        where('room', '==', roomLabels.room),
        where('status', '==', 'Active'),
      );
      const snapshot = await getDocs(tenantQuery);
      legacyOccupants.set(roomKey, snapshot.docs
        .filter((entry) => !entry.data().deletedAt)
        .map((entry) => entry.id));
    }
    const oldRoomRef = oldRoom && oldRoom !== nextRoom
      ? previousRoomRef
      : null;
    const outcome = await runTransaction(firestore, async (transaction) => {
      const currentTenant = await transaction.get(ref);
      if (currentTenant.exists() && remoteTimestamp(currentTenant.data()) > payloadTimestamp(item.payload, item.createdAt)) {
        return { stale: true, data: currentTenant.data() };
      }
      const newRoomSnapshot = await transaction.get(newRoomRef);
      const oldRoomSnapshot = oldRoomRef ? await transaction.get(oldRoomRef) : null;
      if (!newRoomSnapshot.exists() || newRoomSnapshot.data().deletedAt) {
        throw new Error('Register this room before assigning an active tenant.');
      }
      const active = data.status === 'Active' && !data.deletedAt;
      const nextRoomData = newRoomSnapshot.data();
      let nextOccupants = Array.isArray(nextRoomData.occupiedTenantIds)
        ? [...nextRoomData.occupiedTenantIds as string[]]
        : [...(legacyOccupants.get(nextRoom) ?? [])];
      const wasInTarget = nextOccupants.includes(tenantId);
      const previousTenant = currentTenant.exists() ? currentTenant.data() : null;
      const previousActive = previousTenant?.status === 'Active' && !previousTenant.deletedAt;
      const previousRoom = previousActive
        ? `${String(previousTenant.floor)}_${String(previousTenant.room)}`
        : null;
      if (active && !wasInTarget && nextOccupants.length >= Number(nextRoomData.capacity)) {
        const capacityError = new Error('This room has reached its registered bed capacity.') as Error & { code?: string };
        capacityError.code = 'failed-precondition';
        throw capacityError;
      }
      if (oldRoomSnapshot?.exists() && previousRoom && previousRoom !== nextRoom) {
        const oldData = oldRoomSnapshot.data();
        const oldOccupants = Array.isArray(oldData.occupiedTenantIds)
          ? [...oldData.occupiedTenantIds as string[]]
          : [...(legacyOccupants.get(previousRoom) ?? [])];
        await transaction.set(oldRoomRef!, {
          occupiedTenantIds: oldOccupants.filter((id) => id !== tenantId),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } else if (previousRoom === nextRoom && !active) {
        nextOccupants = nextOccupants.filter((id) => id !== tenantId);
      }
      if (active && !wasInTarget) nextOccupants.push(tenantId);
      if (active || wasInTarget || previousRoom === nextRoom) {
        await transaction.set(newRoomRef, {
          occupiedTenantIds: nextOccupants,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
      await transaction.set(ref, data);
      return { stale: false, data: null };
    });
    if (outcome.stale && outcome.data) await applyRemote(item.store, tenantId, outcome.data);
    return;
  }
  if (item.store === 'rooms') {
    await setDoc(ref, data, { merge: true });
    return;
  }
  await setDoc(ref, data);
}

function scheduleRetry(delayMs: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void processSyncQueue();
  }, delayMs);
}

export async function processSyncQueue() {
  if (processing) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    publish({ status: 'offline' });
    return;
  }

  let settings: SyncSettings | null;
  try {
    settings = await getSyncSettings();
  } catch (error) {
    publish({
      status: 'error',
      error: error instanceof Error ? error.message : 'Saved cloud settings could not be opened.',
    });
    await updatePendingCount();
    return;
  }
  if (!settings?.enabled) {
    publish({ status: 'offline' });
    await updatePendingCount();
    return;
  }

  processing = true;
  publish({ status: 'syncing', error: undefined });
  try {
    const db = await dbPromise;
    while (true) {
      const currentSettings = await getSyncSettings();
      if (!currentSettings?.enabled) {
        publish({ status: 'offline' });
        return;
      }
      const queue = (await db.getAll('syncQueue')) as SyncQueueItem[];
      queue.sort((a, b) => a.sequence - b.sequence);
      publish({ pending: queue.length, failed: queue.filter((entry) => entry.failed).length });
      const item = queue.find((entry) => !entry.failed);
      if (!item) {
        const failures = queue.filter((entry) => entry.failed).length;
        publish({
          status: failures ? 'error' : 'synced',
          pending: queue.length,
          failed: failures,
          error: failures ? `${failures} sync item${failures === 1 ? '' : 's'} need attention in Settings.` : undefined,
        });
        return;
      }

      const dueAt = Date.parse(item.nextAttemptAt);
      if (!Number.isNaN(dueAt) && dueAt > Date.now()) {
        publish({ status: 'error', error: item.lastError || 'A sync item is waiting to retry.' });
        scheduleRetry(dueAt - Date.now());
        return;
      }

      try {
        await processItem(item);
        await db.delete('syncQueue', item.id);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '').toLowerCase()
          : '';
        const message = error instanceof Error ? error.message : 'Cloud sync failed.';
        const permanent = code.includes('permission-denied')
          || code.includes('invalid-argument')
          || code.includes('failed-precondition')
          || /PERMISSION_DENIED|INVALID_ARGUMENT/.test(message);
        if (permanent) {
          await db.put('syncQueue', {
            ...item,
            failed: true,
            lastErrorCode: code || (message.includes('PERMISSION_DENIED') ? 'permission-denied' : 'invalid-argument'),
            lastError: code.includes('failed-precondition')
              ? 'This room is full or unavailable. Change the tenant assignment or increase room capacity before retrying.'
              : code.includes('permission-denied') || message.includes('PERMISSION_DENIED')
              ? 'Firestore rejected this record. Check the record fields and security rules.'
              : 'Firestore rejected this record as invalid. Check its fields and limits.',
          });
          await updatePendingCount();
          continue;
        }
        const attempts = item.attempts + 1;
        const delay = Math.min(60_000 * 2 ** (attempts - 1), 60 * 60_000);
        await db.put('syncQueue', {
          ...item,
          attempts,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          lastError: message,
        });
        publish({ status: 'error', error: message });
        scheduleRetry(delay);
        return;
      }
    }
  } finally {
    processing = false;
    await updatePendingCount();
  }
}

export async function forceFullSync() {
  await requireEnabledSettings();
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Connect to the internet before starting a full sync.');
  }
  publish({ status: 'syncing', error: undefined });
  await processSyncQueue();
  const db = await dbPromise;
  const pending = await db.getAll('syncQueue') as SyncQueueItem[];
  if (pending.length) throw new Error('Pending changes must sync successfully before a full sync can continue.');

  const { getFirebaseServices } = await import('./firebase');
  const { collection, getDocs } = await import('firebase/firestore');
  const { auth, firestore } = await getFirebaseServices();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to Firebase in Settings before starting a full sync.');

  for (const store of Object.keys(collectionNames) as SyncStoreName[]) {
    const localRecords = await db.getAll(store) as Array<Record<string, unknown> & { id: string }>;
    const remoteSnapshot = await getDocs(collection(firestore, 'hostels', user.uid, collectionNames[store]));
    const remoteRecords = new Map(remoteSnapshot.docs.map((snapshot) => [
      snapshot.id,
      {
        data: snapshot.data(),
        timestamp: remoteTimestamp(snapshot.data()),
      },
    ]));
    const localIds = new Set(localRecords.map((record) => record.id));

    for (const local of localRecords) {
      const cloud = remoteRecords.get(local.id);
      if (!cloud) {
        await enqueueSync('upsert', store, local, undefined, false);
        continue;
      }
      const localTime = payloadTimestamp(local, '');
      if (cloud.timestamp > localTime) {
        await applyRemote(store, local.id, cloud.data);
      } else {
        await enqueueSync('upsert', store, local, undefined, false);
      }
    }

    for (const [id, cloud] of remoteRecords) {
      if (!localIds.has(id)) await applyRemote(store, id, cloud.data);
    }
  }

  window.dispatchEvent(new CustomEvent('hostel-sync-updated'));
  await processSyncQueue();
}

if (typeof window !== 'undefined') {
window.addEventListener('online', () => notifySyncQueueChanged());
  window.addEventListener('offline', () => publish({ status: 'offline' }));
}
