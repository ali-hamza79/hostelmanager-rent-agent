import { dbPromise } from './idb';
import { Expense, HostelMeta, Payment, Room, Tenant } from '../types';
import { enqueueSync, SyncStoreName, notifySyncQueueChanged } from '../services/sync';
import { expenseSchema, hostelSchema, paymentSchema, roomSchema, tenantSchema } from '../schemas';

const recordSchemas = {
  tenants: tenantSchema,
  rooms: roomSchema,
  payments: paymentSchema,
  expenses: expenseSchema,
} as const;

async function saveRecord(
  store: SyncStoreName,
  record: Tenant | Room | Payment | Expense,
) {
  const parsed = recordSchemas[store].safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Please check the entered information.');
  }
  const { occupationOther: _occupationOther, messOther: _messOther, ...safeRecord } =
    parsed.data as typeof parsed.data & { occupationOther?: string; messOther?: string };
  if (safeRecord.id.includes('/') || /[\u0000-\u001f\u007f]/.test(safeRecord.id)) {
    throw new Error('The record ID contains unsupported characters.');
  }
  const db = await dbPromise;
  const stores = [...new Set<'tenants' | 'rooms' | 'payments' | 'expenses' | 'syncQueue'>(
    [store, 'syncQueue', 'tenants', 'rooms'],
  )];
  const tx = db.transaction(stores, 'readwrite');
  const records = tx.objectStore(store);
  const existing = await records.get(safeRecord.id) as { createdAt?: string } | undefined;
  if (store === 'rooms') {
    const roomRecord = safeRecord as Room;
    const duplicates = await tx.objectStore('rooms').getAll() as Room[];
    if (duplicates.some((room) => room.id !== roomRecord.id
      && !room.deletedAt
      && room.floor === roomRecord.floor
      && room.room === roomRecord.room)) {
      throw new Error('This room is already registered on that floor.');
    }
  }
  if (store === 'tenants') {
    const tenantRecord = safeRecord as Tenant;
    const previous = await tx.objectStore('tenants').get(tenantRecord.id) as Tenant | undefined;
    if (tenantRecord.status === 'Active') {
      const rooms = await tx.objectStore('rooms').getAll() as Room[];
      const room = rooms.find((item) => !item.deletedAt
        && item.floor === tenantRecord.floor
        && item.room === tenantRecord.room);
      if (!room) {
        throw new Error('Register this room and its bed capacity before assigning an active tenant.');
      }
      const tenants = await tx.objectStore('tenants').getAll() as Tenant[];
      const currentOccupancy = tenants.filter((item) => item.id !== tenantRecord.id
        && !item.deletedAt
        && item.status === 'Active'
        && item.floor === room.floor
        && item.room === room.room).length;
      const staysInSameRoom = previous?.status === 'Active'
        && !previous.deletedAt
        && previous.floor === room.floor
        && previous.room === room.room;
      if (!staysInSameRoom && currentOccupancy >= room.capacity) {
        throw new Error('This room has reached its registered bed capacity.');
      }
    }
  }
  const now = new Date().toISOString();
  const value = {
    ...safeRecord,
    createdAt: safeRecord.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  };
  await records.put(value);
  await enqueueSync('upsert', store, value, tx);
  await tx.done;
  notifySyncQueueChanged();
}

async function removeRecord(store: SyncStoreName, id: string) {
  if (!id || id.length > 81 || id.includes('/') || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('The record could not be identified.');
  }
  const db = await dbPromise;
  const tx = db.transaction([store, 'syncQueue'], 'readwrite');
  const records = tx.objectStore(store);
  const existing = await records.get(id) as Record<string, unknown> | undefined;
  if (!existing || typeof existing.deletedAt === 'string') {
    await tx.done;
    return;
  }
  const now = new Date().toISOString();
  const tombstone = {
    ...existing,
    id: typeof existing.id === 'string' ? existing.id : id,
    updatedAt: now,
    deletedAt: now,
  };
  await records.put(tombstone);
  await enqueueSync('upsert', store, tombstone, tx);
  await tx.done;
  notifySyncQueueChanged();
}

export const getMeta = async () => {
  const db = await dbPromise;
  return (await db.get('meta', 'hostel')) as HostelMeta | undefined;
};

export const saveMeta = async (meta: HostelMeta) => {
  const parsed = hostelSchema.safeParse(meta);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Please check the hostel profile.');
  const db = await dbPromise;
  await db.put('meta', { key: 'hostel', ...parsed.data, createdAt: meta.createdAt });
};

export const getTenants = async () => {
  const db = await dbPromise;
  return (await db.getAll('tenants') as Tenant[]).filter((record) => !record.deletedAt);
};

export const saveTenant = (tenant: Tenant) => saveRecord('tenants', tenant);
export const deleteTenant = (id: string) => removeRecord('tenants', id);

export const getRooms = async () => {
  const db = await dbPromise;
  return (await db.getAll('rooms') as Room[]).filter((record) => !record.deletedAt);
};

export const saveRoom = (room: Room) => saveRecord('rooms', room);
export const deleteRoom = (id: string) => removeRecord('rooms', id);

export const getPayments = async () => {
  const db = await dbPromise;
  return (await db.getAll('payments') as Payment[]).filter((record) => !record.deletedAt);
};

export const savePayment = (payment: Payment) => saveRecord('payments', payment);
export const deletePayment = (id: string) => removeRecord('payments', id);

export const getExpenses = async () => {
  const db = await dbPromise;
  return (await db.getAll('expenses') as Expense[]).filter((record) => !record.deletedAt);
};

export const saveExpense = (expense: Expense) => saveRecord('expenses', expense);
export const deleteExpense = (id: string) => removeRecord('expenses', id);

export async function restoreRecord(store: SyncStoreName, id: string) {
  const db = await dbPromise;
  const existing = await db.get(store, id) as Record<string, unknown> | undefined;
  if (!existing || typeof existing.deletedAt !== 'string') {
    throw new Error('The deleted record could not be restored.');
  }
  const { deletedAt: _deletedAt, ...record } = existing;
  await saveRecord(store, record as Tenant | Room | Payment | Expense);
}

export const clearAll = async () => {
  const db = await dbPromise;
  await Promise.all([
    db.clear('meta'),
    db.clear('tenants'),
    db.clear('rooms'),
    db.clear('payments'),
    db.clear('expenses'),
    db.clear('syncQueue'),
  ]);
};
