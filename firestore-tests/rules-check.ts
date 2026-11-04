import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, runTransaction, setDoc, updateDoc } from 'firebase/firestore';

const uid = 'hostel-owner';
const hostelPath = `hostels/${uid}`;
const timestamp = '2026-10-28T00:00:00.000Z';
const tenantRecord = (name = 'Ali & Sons') => ({
  name,
  phone: '',
  floor: '1',
  room: 'A-1',
  joinDate: '2026-01-01',
  occupation: '',
  mess: 'Standard',
  rent: 10000,
  status: 'Active',
  rentHistory: [{ effectiveMonth: '2026-01', amount: 10000 }],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let environment: RulesTestEnvironment;

describe.skipIf(!emulatorAvailable)('Firestore record rules', () => {
  beforeAll(async () => {
    const [host, rawPort] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
    environment = await initializeTestEnvironment({
      projectId: 'demo-hostelmanager-rules',
      firestore: {
        host,
        port: Number(rawPort),
        rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
      },
    });
  });

  beforeEach(async () => {
    await environment.clearFirestore();
  });

  afterAll(async () => {
    await environment?.cleanup();
  });

  it('accepts a valid rent history on tenant creation and rejects a mismatched first month', async () => {
    const firestore = environment.authenticatedContext(uid).firestore();
    await assertSucceeds(setDoc(doc(firestore, hostelPath, 'Tenants', 'tenant-valid'), tenantRecord()));
    await assertFails(setDoc(doc(firestore, hostelPath, 'Tenants', 'tenant-invalid'), {
      ...tenantRecord(),
      rentHistory: [{ effectiveMonth: '2025-12', amount: 10000 }],
    }));
  });

  it('prohibits hard deletion so the tombstone remains the audit record', async () => {
    const path = `${hostelPath}/Tenants/tenant-delete`;
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), path), tenantRecord());
    });

    await assertFails(deleteDoc(doc(environment.authenticatedContext(uid).firestore(), path)));
  });

  it('requires payment edits to use the tenant current name', async () => {
    const firestore = environment.authenticatedContext(uid).firestore();
    const tenantRef = doc(firestore, hostelPath, 'Tenants', 'tenant-payment');
    const paymentRef = doc(firestore, hostelPath, 'Payments', 'payment-1');
    await environment.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, hostelPath, 'Tenants', 'tenant-payment'), tenantRecord());
      await setDoc(doc(adminDb, hostelPath, 'Payments', 'payment-1'), {
        tenantId: 'tenant-payment',
        tenantName: 'Ali & Sons',
        month: '2026-10',
        amount: 10000,
        date: '2026-10-01',
        note: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });

    await assertSucceeds(updateDoc(tenantRef, { name: 'Ali & Sons Hostel', updatedAt: timestamp }));
    await assertFails(updateDoc(paymentRef, { note: 'updated note', updatedAt: timestamp }));
    await assertSucceeds(updateDoc(paymentRef, {
      tenantName: 'Ali & Sons Hostel',
      note: 'updated note',
      updatedAt: timestamp,
    }));
  });

  it('allows the tenant and its room occupancy to sync in one transaction', async () => {
    const firestore = environment.authenticatedContext(uid).firestore();
    const tenantRef = doc(firestore, hostelPath, 'Tenants', 'tenant-room-transaction');
    const roomRef = doc(firestore, hostelPath, 'Rooms', '1_A-1');
    await environment.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(tenantRef, tenantRecord());
      await setDoc(roomRef, {
        floor: '1',
        room: 'A-1',
        capacity: 2,
        occupiedTenantIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });

    await assertSucceeds(runTransaction(firestore, async (transaction) => {
      await transaction.get(tenantRef);
      await transaction.get(roomRef);
      transaction.set(roomRef, {
        floor: '1',
        room: 'A-1',
        capacity: 2,
        occupiedTenantIds: ['tenant-room-transaction'],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      transaction.set(tenantRef, tenantRecord('Ali Revised'));
    }));
  });
});
