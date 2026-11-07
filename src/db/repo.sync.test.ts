import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbPromise } from './idb';
import type { Tenant } from '../types';
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
import {
  repairLegacyDemoSyncItems,
  retryDuplicateCloudRoomFailures,
  retryLegacyRoomCapacityFailures,
  preparePaymentSyncRecord,
  prepareTenantSyncRecord,
} from '../services/sync';
import { DUPLICATE_CLOUD_ROOM_SYNC_ERROR, LEGACY_ROOM_SYNC_ERROR } from '../services/roomOccupancy';

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
    const tenantRecord: Tenant = {
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
      rentHistory: [{ effectiveMonth: '2026-01', amount: 10000 }],
    };
    await saveTenant(tenantRecord);
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
    expect((await getTenants())[0].rentHistory).toEqual(tenantRecord.rentHistory);
    expect(queue.find((item) => item.store === 'tenants')?.payload.rentHistory).toEqual(tenantRecord.rentHistory);
    expect('updatedAt' in tenantRecord).toBe(false);
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

  it('repairs invalid legacy demo tenants and retries their dependent payments', async () => {
    const db = await dbPromise;
    await db.put('tenants', {
      id: 'demo-daniel-reyes',
      name: 'Daniel Reyes',
      mess: 'Standard Mess',
      updatedAt: new Date().toISOString(),
    });
    const failedTenant: SyncQueueItem = {
      id: 'queue-demo-tenant',
      action: 'upsert',
      store: 'tenants',
      payload: { id: 'demo-daniel-reyes', name: 'Daniel Reyes', mess: 'Standard Mess' },
      createdAt: new Date().toISOString(),
      sequence: 1,
      attempts: 4,
      nextAttemptAt: new Date().toISOString(),
      failed: true,
      lastError: 'Firestore rejected this record.',
      lastErrorCode: 'permission-denied',
    };
    const failedPayment: SyncQueueItem = {
      id: 'queue-demo-payment',
      action: 'upsert',
      store: 'payments',
      payload: { id: 'demo-payment-daniel', tenantId: 'demo-daniel-reyes' },
      createdAt: new Date().toISOString(),
      sequence: 2,
      attempts: 4,
      nextAttemptAt: new Date().toISOString(),
      failed: true,
      lastError: 'Firestore rejected this record.',
      lastErrorCode: 'permission-denied',
    };
    await db.put('syncQueue', failedTenant);
    await db.put('syncQueue', failedPayment);

    const repairedCount = await repairLegacyDemoSyncItems(db);
    const repairedTenant = await db.get('tenants', 'demo-daniel-reyes');
    const tenantQueue = await db.get('syncQueue', failedTenant.id) as SyncQueueItem;
    const paymentQueue = await db.get('syncQueue', failedPayment.id) as SyncQueueItem;

    expect(repairedCount).toBe(2);
    expect(repairedTenant?.mess).toBe('Standard');
    expect(tenantQueue.payload.mess).toBe('Standard');
    expect(tenantQueue.failed).toBe(false);
    expect(tenantQueue.attempts).toBe(0);
    expect(tenantQueue.lastError).toBeUndefined();
    expect(paymentQueue.failed).toBe(false);
    expect(paymentQueue.attempts).toBe(0);
  });

  it('retries tenants failed with the old generic room-capacity message', async () => {
    const db = await dbPromise;
    const failedTenant: SyncQueueItem = {
      id: 'queue-old-capacity-error',
      action: 'upsert',
      store: 'tenants',
      payload: { id: 'tenant-room-retry' },
      createdAt: new Date().toISOString(),
      sequence: 1,
      attempts: 2,
      nextAttemptAt: new Date().toISOString(),
      failed: true,
      lastError: LEGACY_ROOM_SYNC_ERROR,
      lastErrorCode: 'failed-precondition',
    };
    const unrelatedFailure: SyncQueueItem = {
      ...failedTenant,
      id: 'queue-unrelated-error',
      payload: { id: 'tenant-unrelated' },
      lastError: 'A different validation error.',
    };
    await db.put('syncQueue', failedTenant);
    await db.put('syncQueue', unrelatedFailure);

    expect(await retryLegacyRoomCapacityFailures(db)).toBe(1);
    const retry = await db.get('syncQueue', failedTenant.id) as SyncQueueItem;
    const untouched = await db.get('syncQueue', unrelatedFailure.id) as SyncQueueItem;
    expect(retry.failed).toBe(false);
    expect(retry.lastError).toBeUndefined();
    expect(untouched.failed).toBe(true);
    expect(untouched.lastError).toBe('A different validation error.');
  });

  it('retries duplicate-room tenant failures for canonical-room synchronization', async () => {
    const db = await dbPromise;
    const failedTenant: SyncQueueItem = {
      id: 'queue-duplicate-room',
      action: 'upsert',
      store: 'tenants',
      payload: { id: 'tenant-duplicate-room' },
      createdAt: new Date().toISOString(),
      sequence: 1,
      attempts: 3,
      nextAttemptAt: new Date().toISOString(),
      failed: true,
      lastError: DUPLICATE_CLOUD_ROOM_SYNC_ERROR,
      lastErrorCode: 'failed-precondition',
    };
    await db.put('syncQueue', failedTenant);

    expect(await retryDuplicateCloudRoomFailures(db)).toBe(1);
    const retry = await db.get('syncQueue', failedTenant.id) as SyncQueueItem;
    expect(retry.failed).toBe(false);
    expect(retry.attempts).toBe(0);
    expect(retry.lastError).toBeUndefined();
  });

  it('preserves cloud tenant creation and rent-history fields omitted by legacy local data', () => {
    const cloudHistory = [{ effectiveMonth: '2026-01', amount: 450 }];
    const record = prepareTenantSyncRecord(
      { name: 'Daniel Reyes', rentHistory: [] },
      { createdAt: '2026-01-01T00:00:00.000Z', rentHistory: cloudHistory },
    );

    expect(record.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(record.rentHistory).toEqual(cloudHistory);
  });

  it('omits empty rent history from new cloud tenant records', () => {
    const record = prepareTenantSyncRecord({ name: 'New Tenant', rentHistory: [] });
    expect(record).toEqual({ name: 'New Tenant' });
  });

  it('uses the current cloud tenant name for payment rules', () => {
    const record = preparePaymentSyncRecord({
      tenantId: 'tenant-1',
      tenantName: 'Old Tenant Name',
      month: '2026-11',
      amount: 700,
      date: '2026-11-04',
      note: 'PayPal capture confirmed.',
    }, { name: 'Current Tenant Name' });

    expect(record.tenantName).toBe('Current Tenant Name');
    expect(record.amount).toBe(700);
  });

  it('reports the exact missing tenant or invalid payment field', () => {
    expect(() => preparePaymentSyncRecord({
      tenantId: 'tenant-1',
      tenantName: 'Tenant',
      month: '2026-11',
      amount: 700,
      date: '2026-11-04',
      note: '',
    }, undefined)).toThrow(/tenant tenant-1 is not in cloud storage/);
    expect(() => preparePaymentSyncRecord({
      tenantId: 'tenant-1',
      tenantName: 'Tenant',
      month: '2026-11',
      amount: 700,
      date: '2026-11-04',
      note: 'x'.repeat(501),
    }, { name: 'Tenant' })).toThrow(/500-character limit/);
  });
});
