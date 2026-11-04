import { format, subMonths } from 'date-fns';
import { describe, expect, it } from 'vitest';
import type { Payment, Tenant } from '../types';
import { buildSnapshot } from './snapshot';

const asOf = new Date();
const months = [-2, -1, 0].map((offset) => format(subMonths(asOf, Math.abs(offset)), 'yyyy-MM'));

function tenant(id: string, name: string, rent: number): Tenant {
  const firstMonth = months[0]!;
  return {
    id,
    name,
    phone: '',
    floor: '1',
    room: '1A',
    joinDate: `${firstMonth}-01`,
    billingStartDate: firstMonth,
    occupation: 'Student',
    mess: '',
    rent,
    rentHistory: [{ effectiveMonth: firstMonth, amount: rent }],
    status: 'Active',
  };
}

function payment(tenantId: string, tenantName: string, month: string, amount: number): Payment {
  return {
    id: `${tenantId}-${month}`,
    tenantId,
    tenantName,
    month,
    amount,
    date: `${month}-10`,
    note: '',
    createdAt: asOf.toISOString(),
  };
}

describe('buildSnapshot', () => {
  it('calculates the locked overdue cases and excludes paid tenants from overdue totals', () => {
    const daniel = tenant('demo-daniel-reyes', 'Daniel Reyes', 450);
    const mina = tenant('demo-mina-okafor', 'Mina Okafor', 380);
    const leo = tenant('demo-leo', 'Leo', 400);
    const payments = [
      payment(daniel.id, daniel.name, months[0]!, 450),
      payment(daniel.id, daniel.name, months[1]!, 200),
      payment(mina.id, mina.name, months[0]!, 380),
      payment(mina.id, mina.name, months[1]!, 380),
      ...months.map((month) => payment(leo.id, leo.name, month, 400)),
    ];

    const snapshot = buildSnapshot(
      { name: 'Maple House', address: 'Demo property', createdAt: asOf.toISOString() },
      [daniel, mina, leo],
      payments,
    );

    expect(snapshot.currency).toBe('USD');
    expect(snapshot.tenants.find((item) => item.tenantId === daniel.id)).toMatchObject({
      outstandingAmount: 700,
      monthsOverdue: 2,
      recentMonths: [
        { status: 'paid' },
        { status: 'partial' },
        { status: 'unpaid' },
      ],
    });
    expect(snapshot.tenants.find((item) => item.tenantId === mina.id)).toMatchObject({
      outstandingAmount: 380,
      monthsOverdue: 1,
    });
    expect(snapshot.tenants.find((item) => item.tenantId === leo.id)).toMatchObject({
      outstandingAmount: 0,
      monthsOverdue: 0,
    });
  });
});
