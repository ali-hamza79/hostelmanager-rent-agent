import { IDBPTransaction } from 'idb';
import type { DocumentData } from 'firebase/firestore';
import { dbPromise } from '../db/idb';
import type { SyncSettings } from '../types';
import {
  chooseCanonicalCloudRoom,
  DUPLICATE_CLOUD_ROOM_SYNC_ERROR,
  LEGACY_ROOM_SYNC_ERROR,
  reconcileRoomOccupants,
} from './roomOccupancy';

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

export async function repairLegacyDemoSyncItems(db: Awaited<typeof dbPromise>) {
  const tx = db.transaction(['tenants', 'syncQueue'], 'readwrite');
  const tenantStore = tx.objectStore('tenants');
  const queueStore = tx.objectStore('syncQueue');
  const [tenants, queue] = await Promise.all([tenantStore.getAll(), queueStore.getAll()]) as [
    Array<Record<string, unknown> & { id: string }>,
    SyncQueueItem[],
  ];
  const repairedTenantIds = new Set<string>();
  const now = new Date().toISOString();

  for (const item of queue) {
    if (item.store === 'tenants'
      && item.payload.id.startsWith('demo-')
      && item.payload.mess === 'Standard Mess') {
      repairedTenantIds.add(item.payload.id);
    }
  }

  for (const tenant of tenants) {
    if (tenant.id.startsWith('demo-') && tenant.mess === 'Standard Mess') {
      await tenantStore.put({ ...tenant, mess: 'Standard', updatedAt: now });
      repairedTenantIds.add(tenant.id);
    }
  }

  let repairedQueueCount = 0;
  for (const item of queue) {
    const isLegacyDemoTenant = item.store === 'tenants'
      && item.payload.id.startsWith('demo-')
      && item.payload.mess === 'Standard Mess';
    const isDependentDemoPayment = item.store === 'payments'
      && typeof item.payload.tenantId === 'string'
      && item.payload.tenantId.startsWith('demo-')
      && repairedTenantIds.has(item.payload.tenantId);
    if (!isLegacyDemoTenant && !isDependentDemoPayment) continue;

    const { lastError: _lastError, lastErrorCode: _lastErrorCode, ...retryable } = item;
    await queueStore.put({
      ...retryable,
      payload: isLegacyDemoTenant
        ? { ...item.payload, mess: 'Standard', updatedAt: now }
        : item.payload,
      failed: false,
      attempts: 0,
      nextAttemptAt: now,
    });
    repairedQueueCount += 1;
  }

  await tx.done;
  return repairedQueueCount;
}

export async function retryLegacyRoomCapacityFailures(db: Awaited<typeof dbPromise>) {
  const queue = await db.getAll('syncQueue') as SyncQueueItem[];
  const now = new Date().toISOString();
  let repairedCount = 0;
  for (const item of queue) {
    if (item.store !== 'tenants' || !item.failed || item.lastError !== LEGACY_ROOM_SYNC_ERROR) continue;
    const { lastError: _lastError, lastErrorCode: _lastErrorCode, ...retryable } = item;
    await db.put('syncQueue', {
      ...retryable,
      failed: false,
      attempts: 0,
      nextAttemptAt: now,
    });
    repairedCount += 1;
  }
  return repairedCount;
}

export async function retryDuplicateCloudRoomFailures(db: Awaited<typeof dbPromise>) {
  const queue = await db.getAll('syncQueue') as SyncQueueItem[];
  const now = new Date().toISOString();
  let repairedCount = 0;
  for (const item of queue) {
    if (item.store !== 'tenants' || !item.failed || item.lastError !== DUPLICATE_CLOUD_ROOM_SYNC_ERROR) continue;
    const { lastError: _lastError, lastErrorCode: _lastErrorCode, ...retryable } = item;
    await db.put('syncQueue', {
      ...retryable,
      failed: false,
      attempts: 0,
      nextAttemptAt: now,
    });
    repairedCount += 1;
  }
  return repairedCount;
}

export function prepareTenantSyncRecord(
  localData: Record<string, unknown>,
  cloudData?: Record<string, unknown>,
) {
  const record = { ...localData };
  if (typeof record.createdAt !== 'string' && typeof cloudData?.createdAt === 'string') {
    record.createdAt = cloudData.createdAt;
  }
  if (!Array.isArray(record.rentHistory) || record.rentHistory.length === 0) {
    if (Array.isArray(cloudData?.rentHistory) && cloudData.rentHistory.length > 0) {
      record.rentHistory = cloudData.rentHistory;
    } else {
      delete record.rentHistory;
    }
  }
  return record;
}

export function preparePaymentSyncRecord(
  localData: Record<string, unknown>,
  cloudTenant: Record<string, unknown> | undefined,
) {
  const invalidPayment = (message: string, code = 'invalid-argument') => {
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    return error;
  };
  if (!cloudTenant) {
    const tenantId = typeof localData.tenantId === 'string' ? localData.tenantId : '(missing)';
    throw invalidPayment(
      `Cannot sync this payment because tenant ${tenantId} is not in cloud storage and has no local tenant record to sync.`,
      'failed-precondition',
    );
  }
  if (typeof cloudTenant.name !== 'string' || cloudTenant.name.length > 120) {
    throw invalidPayment('Cannot sync this payment because the cloud tenant name is missing or invalid.', 'failed-precondition');
  }

  const record: Record<string, unknown> = { ...localData, tenantName: cloudTenant.name };
  if (typeof record.tenantId !== 'string' || !record.tenantId.length) {
    throw invalidPayment('Cannot sync this payment because its tenant ID is missing.');
  }
  if (typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.amount <= 0 || record.amount > 100000000) {
    throw invalidPayment('Cannot sync this payment because its amount is invalid.');
  }
  if (typeof record.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(record.month)) {
    throw invalidPayment('Cannot sync this payment because its month must use YYYY-MM format.');
  }
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    throw invalidPayment('Cannot sync this payment because its date must use YYYY-MM-DD format.');
  }
  if (typeof record.note !== 'string' || record.note.length > 500) {
    throw invalidPayment('Cannot sync this payment because its note exceeds the 500-character limit.');
  }
  return record;
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

function addSyncPhase(error: unknown, phase: string) {
  const message = error instanceof Error ? error.message : 'Cloud sync failed.';
  const wrapped = new Error(message) as Error & { code?: string; syncPhase?: string };
  if (typeof error === 'object' && error !== null && 'code' in error) {
    wrapped.code = String(error.code);
  }
  wrapped.syncPhase = phase;
  return wrapped;
}

async function withSyncPhase<T>(phase: string, operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw addSyncPhase(error, phase);
  }
}

async function processItem(item: SyncQueueItem) {
  const { collection, doc, getDoc, getDocs, query, runTransaction, setDoc, where } =
    await import('firebase/firestore');
  const ref = await withSyncPhase('opening the cloud record', () => remoteRef(item.store, item.payload.id));
  const remote = await withSyncPhase('reading the cloud record', () => getDoc(ref));
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
      const rooms = await withSyncPhase('resolving room labels and existing occupancy', () => getDocs(roomQuery));
      if (rooms.docs.length === 0) return doc(firestore, 'hostels', user.uid, 'Rooms', `${floor}_${roomName}`);
      const candidates = rooms.docs.map((room) => ({
        id: room.id,
        capacity: room.data().capacity,
        deletedAt: room.data().deletedAt,
        ref: room.ref,
      }));
      const canonical = chooseCanonicalCloudRoom(candidates);
      if (candidates.length > 1) {
        console.warn(
          `Found ${candidates.length} cloud room records for floor ${floor}, room ${roomName}; syncing against ${canonical.id}. Duplicates were retained.`,
        );
      }
      return canonical.ref;
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
      const snapshot = await withSyncPhase('reading existing room occupants', () => getDocs(tenantQuery));
      legacyOccupants.set(roomKey, snapshot.docs
        .filter((entry) => !entry.data().deletedAt)
        .map((entry) => entry.id));
    }
    const oldRoomRef = oldRoom && oldRoom !== nextRoom
      ? previousRoomRef
      : null;
    const outcome = await withSyncPhase('checking room capacity and writing the tenant/room transaction', () =>
      runTransaction(firestore, async (transaction) => {
      const currentTenant = await transaction.get(ref);
      if (currentTenant.exists() && remoteTimestamp(currentTenant.data()) > payloadTimestamp(item.payload, item.createdAt)) {
        return { stale: true, data: currentTenant.data() };
      }
      const tenantData = prepareTenantSyncRecord(
        data,
        currentTenant.exists() ? currentTenant.data() : undefined,
      );
      const newRoomSnapshot = await transaction.get(newRoomRef);
      const oldRoomSnapshot = oldRoomRef ? await transaction.get(oldRoomRef) : null;
      if (!newRoomSnapshot.exists() || newRoomSnapshot.data().deletedAt) {
        const roomError = new Error(`Room ${nextFloor}-${nextRoomName} is missing or deleted in cloud storage. Sync or register the room before retrying.`) as Error & { code?: string };
        roomError.code = 'room-unavailable';
        throw roomError;
      }
      const active = tenantData.status === 'Active' && !tenantData.deletedAt;
      const nextRoomData = newRoomSnapshot.data();
      const readRoomOccupants = async (
        roomData: DocumentData,
        fallbackIds: string[],
        floor: string,
        roomName: string,
      ) => {
        const storedIds = Array.isArray(roomData.occupiedTenantIds)
          ? roomData.occupiedTenantIds.filter((id: unknown): id is string => typeof id === 'string')
          : [];
        const candidates = [...new Set([...storedIds, ...fallbackIds])];
        const records = [];
        for (const id of candidates) {
          if (id === tenantId && currentTenant.exists()) {
            records.push({ id, ...currentTenant.data() });
            continue;
          }
          const occupant = await transaction.get(doc(firestore, 'hostels', user.uid, 'Tenants', id));
          if (occupant.exists()) records.push({ id, ...occupant.data() });
        }
        return reconcileRoomOccupants(storedIds, records, floor, roomName);
      };

      let nextOccupants = await readRoomOccupants(
        nextRoomData,
        legacyOccupants.get(nextRoom) ?? [],
        nextFloor,
        nextRoomName,
      );
      const wasInTarget = nextOccupants.includes(tenantId);
      const previousTenant = currentTenant.exists() ? currentTenant.data() : null;
      const previousActive = previousTenant?.status === 'Active' && !previousTenant.deletedAt;
      const previousRoom = previousActive
        ? `${String(previousTenant.floor)}_${String(previousTenant.room)}`
        : null;
      if (active && !wasInTarget && nextOccupants.length >= Number(nextRoomData.capacity)) {
        const capacityError = new Error(
          `Room ${nextFloor}-${nextRoomName} is full (${nextOccupants.length}/${Number(nextRoomData.capacity)} beds). Assign the tenant to an available room or increase the registered capacity.`,
        ) as Error & { code?: string };
        capacityError.code = 'room-capacity-exceeded';
        throw capacityError;
      }
      if (oldRoomSnapshot?.exists() && previousRoom && previousRoom !== nextRoom && oldTenantData) {
        const oldData = oldRoomSnapshot.data();
        const oldOccupants = await readRoomOccupants(
          oldData,
          legacyOccupants.get(previousRoom) ?? [],
          String(oldTenantData.floor),
          String(oldTenantData.room),
        );
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
      await transaction.set(ref, tenantData);
      return { stale: false, data: null };
      }),
    );
    if (outcome.stale && outcome.data) await applyRemote(item.store, tenantId, outcome.data);
    return;
  }
  if (item.store === 'rooms') {
    await withSyncPhase('writing the room record', () => setDoc(ref, data, { merge: true }));
    return;
  }
  if (item.store === 'payments') {
    const tenantId = typeof data.tenantId === 'string' ? data.tenantId : '';
    if (!tenantId) throw new Error('Cannot sync this payment because its tenant ID is missing.');
    const tenantRef = await remoteRef('tenants', tenantId);
    let tenantSnapshot = await withSyncPhase('reading the linked cloud tenant', () => getDoc(tenantRef));
    if (!tenantSnapshot.exists()) {
      const db = await dbPromise;
      const localTenant = await db.get('tenants', tenantId) as (Record<string, unknown> & { id: string }) | undefined;
      if (localTenant) {
        await processItem({
          id: `payment-prerequisite-${tenantId}`,
          action: 'upsert',
          store: 'tenants',
          payload: localTenant,
          createdAt: typeof localTenant.updatedAt === 'string' ? localTenant.updatedAt : new Date().toISOString(),
          sequence: 0,
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
        });
        tenantSnapshot = await withSyncPhase('verifying the linked tenant after prerequisite sync', () => getDoc(tenantRef));
      }
    }
    const paymentData = preparePaymentSyncRecord(
      data,
      tenantSnapshot.exists() ? tenantSnapshot.data() : undefined,
    );
    await withSyncPhase('writing the payment record', () => setDoc(ref, paymentData));
    return;
  }
  await withSyncPhase(`writing the ${item.store.slice(0, -1)} record`, () => setDoc(ref, data));
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
    await repairLegacyDemoSyncItems(db);
    await retryLegacyRoomCapacityFailures(db);
    await retryDuplicateCloudRoomFailures(db);
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
        const syncPhase = error && typeof error === 'object' && 'syncPhase' in error
          ? String((error as { syncPhase?: unknown }).syncPhase ?? '')
          : '';
        const permanent = code.includes('permission-denied')
          || code.includes('invalid-argument')
          || code.includes('failed-precondition')
          || code.includes('room-capacity-exceeded')
          || code.includes('room-unavailable')
          || /PERMISSION_DENIED|INVALID_ARGUMENT/.test(message);
        if (permanent) {
          await db.put('syncQueue', {
            ...item,
            failed: true,
            lastErrorCode: code || (message.includes('PERMISSION_DENIED') ? 'permission-denied' : 'invalid-argument'),
            lastError: code.includes('room-capacity-exceeded') || code.includes('room-unavailable')
              ? message
              : code.includes('failed-precondition')
              ? message
              : code.includes('permission-denied') || message.includes('PERMISSION_DENIED')
              ? `Firestore rejected this record${syncPhase ? ` while ${syncPhase}` : ''}. Check the deployed rules and the relevant record fields.`
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
