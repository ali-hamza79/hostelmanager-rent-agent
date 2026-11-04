import { format, subMonths } from 'date-fns';
import { dbPromise } from '../db/idb';
import type { HostelMeta, Payment, Room, Tenant } from '../types';

const demoTenants = [
  { id: 'demo-daniel-reyes', name: 'Daniel Reyes', floor: '4', room: '4B', rent: 450 },
  { id: 'demo-mina-okafor', name: 'Mina Okafor', floor: '2', room: '2A', rent: 380 },
  { id: 'demo-leo', name: 'Leo', floor: '1', room: '1A', rent: 400 },
  { id: 'demo-priya', name: 'Priya', floor: '1', room: '1B', rent: 400 },
  { id: 'demo-sam', name: 'Sam', floor: '1', room: '1C', rent: 400 },
] as const;

function makePayment(
  tenant: (typeof demoTenants)[number],
  month: string,
  amount: number,
  asOf: Date,
): Payment {
  const date = month === format(asOf, 'yyyy-MM')
    ? format(asOf, 'yyyy-MM-dd')
    : `${month}-15`;
  const now = asOf.toISOString();

  return {
    id: `demo-payment-${tenant.id}-${month}`,
    tenantId: tenant.id,
    tenantName: tenant.name,
    month,
    amount,
    date,
    note: 'Demo rent payment',
    createdAt: now,
    updatedAt: now,
  };
}

export async function seedDemoData() {
  const asOf = new Date();
  const now = asOf.toISOString();
  const months = [-2, -1, 0].map((offset) => format(subMonths(asOf, Math.abs(offset)), 'yyyy-MM'));
  const firstMonth = months[0];
  if (!firstMonth) throw new Error('Could not determine the demo billing period.');

  const rooms: Room[] = [
    { id: 'demo-room-4b', floor: '4', room: '4B', capacity: 2, createdAt: now, updatedAt: now },
    { id: 'demo-room-2a', floor: '2', room: '2A', capacity: 1, createdAt: now, updatedAt: now },
    ...['1A', '1B', '1C'].map((room) => ({
      id: `demo-room-${room.toLowerCase()}`,
      floor: '1',
      room,
      capacity: 1,
      createdAt: now,
      updatedAt: now,
    })),
  ];

  const tenants: Tenant[] = demoTenants.map((tenant) => ({
    ...tenant,
    phone: '',
    joinDate: `${firstMonth}-01`,
    billingStartDate: firstMonth,
    occupation: 'Student',
    mess: 'Standard',
    status: 'Active',
    rentHistory: [{ effectiveMonth: firstMonth, amount: tenant.rent }],
    createdAt: now,
    updatedAt: now,
  }));

  const payments = [
    makePayment(demoTenants[0], months[0]!, 450, asOf),
    makePayment(demoTenants[0], months[1]!, 200, asOf),
    makePayment(demoTenants[1], months[0]!, 380, asOf),
    makePayment(demoTenants[1], months[1]!, 380, asOf),
    ...demoTenants.slice(2).flatMap((tenant) => months.map((month) => (
      makePayment(tenant, month, tenant.rent, asOf)
    ))),
  ];

  const meta: HostelMeta & { key: string } = {
    key: 'hostel',
    name: 'Maple House',
    address: 'Demo property',
    createdAt: now,
  };

  const db = await dbPromise;
  const tx = db.transaction(['meta', 'tenants', 'rooms', 'payments', 'expenses'], 'readwrite');
  const [existingMeta, existingTenants, existingRooms, existingPayments, existingExpenses] = await Promise.all([
    tx.objectStore('meta').getAll(),
    tx.objectStore('tenants').getAll(),
    tx.objectStore('rooms').getAll(),
    tx.objectStore('payments').getAll(),
    tx.objectStore('expenses').getAll(),
  ]);
  const hasExistingData = existingMeta.length > 0
    || existingTenants.length > 0
    || existingRooms.length > 0
    || existingPayments.length > 0
    || existingExpenses.length > 0;

  if (hasExistingData) {
    await tx.done;
    throw new Error('Demo data can only be loaded into an empty workspace. Use a fresh browser profile.');
  }

  await Promise.all([
    tx.objectStore('meta').put(meta),
    ...rooms.map((room) => tx.objectStore('rooms').put(room)),
    ...tenants.map((tenant) => tx.objectStore('tenants').put(tenant)),
    ...payments.map((payment) => tx.objectStore('payments').put(payment)),
  ]);
  await tx.done;
}
