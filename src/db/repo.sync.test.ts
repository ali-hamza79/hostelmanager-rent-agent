import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbPromise } from './idb';
import {
  deleteTenant,
  getExpenses,
  getPayments,
  getRooms,
  getTenants,
  saveExpense,
  savePayment,
  saveRoom,
  saveTenant,
} from './repo';
import { SyncQueueItem } from '../services/sync';

describe('offline repository sync queue', () => {
  beforeEach(async () => {
    const db = await dbPromise;
    await Promise.all(['meta', 'tenants', 'rooms', 'payments', 'expenses', 'syncQueue'].map((store) => db.clear(store)));
  });

  it('persists tenant, room, payment, and expense locally with queue entries', async () => {
    await saveRoom({
      id: '1_A-1',
      floor: '1',
      room: 'A-1',
      capacity: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await saveTenant({
      id: 'tenant-1',
      name: 'Amina',
      phone: '',
      floor: '1',
      room: 'A-1',
      joinDate: '2026-01-01',
      occupation: '',
      mess: '',
      rent: 10000,
      status: 'Active',
    });
    await savePayment({
      id: 'payment-1',
      tenantId: 'tenant-1',
      tenantName: 'Amina',
      month: '2026-10',
      amount: 10000,
      date: '2026-10-01',
      note: '',
      createdAt: new Date().toISOString(),
    });
    await saveExpense({
      id: 'expense-1',
      date: '2026-10-01',
      amount: 1500,
      category: 'Utilities',
      note: '',
      createdAt: new Date().toISOString(),
    });

    const db = await dbPromise;
    const queue = await db.getAll('syncQueue') as SyncQueueItem[];
    expect(await getTenants()).toHaveLength(1);
    expect(await getRooms()).toHaveLength(1);
    expect(await getPayments()).toHaveLength(1);
    expect(await getExpenses()).toHaveLength(1);
    expect(queue).toHaveLength(4);
    expect(queue.map((item) => item.store).sort()).toEqual(['expenses', 'payments', 'rooms', 'tenants']);
    expect(queue.every((item) => item.action === 'upsert')).toBe(true);
    expect((await getTenants())[0].updatedAt).toBeTruthy();
  });

  it('records deletions as queued tombstone operations while deleting locally', async () => {
    await saveRoom({
      id: '2_B-2',
      floor: '2',
      room: 'B-2',
      capacity: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await saveTenant({
      id: 'tenant-delete',
      name: 'Bilal',
      phone: '',
      floor: '2',
      room: 'B-2',
      joinDate: '2026-01-01',
      occupation: '',
      mess: '',
      rent: 9000,
      status: 'Active',
    });
    await deleteTenant('tenant-delete');

    const db = await dbPromise;
    const queue = (await db.getAll('syncQueue')) as SyncQueueItem[];
    queue.sort((a, b) => a.sequence - b.sequence);
    expect(await getTenants()).toHaveLength(0);
    expect(queue.map((item) => item.action)).toEqual(['upsert', 'upsert', 'upsert']);
    expect(queue[2].payload.id).toBe('tenant-delete');
    expect(queue[2].payload.deletedAt).toBeTruthy();
  });

  it('serializes local room-capacity checks across concurrent saves', async () => {
    await saveRoom({
      id: '1_A-1',
      floor: '1',
      room: 'A-1',
      capacity: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const records = ['tenant-a', 'tenant-b'].map((id) => saveTenant({
      id,
      name: id,
      phone: '',
      floor: '1',
      room: 'A-1',
      joinDate: '2026-01-01',
      occupation: '',
      mess: '',
      rent: 9000,
      status: 'Active',
    }));
    const results = await Promise.allSettled(records);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await getTenants()).toHaveLength(1);
  });
});
