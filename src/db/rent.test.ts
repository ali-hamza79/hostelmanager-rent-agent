import { describe, expect, it } from 'vitest';
import { calculateUnpaid, validateRentHistory } from './rent';

const month = (offset: number) => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const entry = (effectiveMonth: string, amount: number) => ({ effectiveMonth, amount });
const payment = (tenantId: string, month: string, amount: number) => ({ tenantId, month, amount });

const tenantWithHistory = (id: string, name: string, room: string, joinDate: string, rent: number, rentHistory: Array<{ effectiveMonth: string; amount: number }>) => ({
  id,
  name,
  room,
  status: 'Active',
  joinDate,
  rent,
  rentHistory,
});

describe('calculateUnpaid', () => {
  it('legacy tenant with no rent history', () => {
    const current = month(0);
    const tenant = {
      id: 't1',
      name: 'Alice',
      room: 'A-1',
      status: 'Active',
      joinDate: `${current}-15`,
      rent: 10000,
    };

    const unpaid = calculateUnpaid([tenant], [payment('t1', current, 10000)]);
    expect(unpaid).toHaveLength(0);
  });

  it('billing starts after historical join date', () => {
    const current = month(0);
    const join = month(-21);
    const billingStart = month(-2);
    const tenant = tenantWithHistory('t-billing-start', 'Farah', 'F-1', `${join}-10`, 10000, [entry(join, 10000)]);
    (tenant as any).billingStartDate = billingStart;

    const unpaid = calculateUnpaid([tenant], []);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].monthsDue).toBe(3);
    expect(unpaid[0].amountDue).toBeCloseTo(30000, 2);
  });

  it('rent increase splits correctly', () => {
    const current = month(0);
    const join = month(-8);
    const increase = month(-2);
    const tenant = tenantWithHistory('t2', 'Bob', 'B-2', `${join}-10`, 10000, [entry(join, 10000), entry(increase, 12000)]);

    const unpaid = calculateUnpaid([tenant], []);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].monthsDue).toBe(9);
    expect(unpaid[0].amountDue).toBeCloseTo(96000, 2);
  });

  it('partial payment applies to correct month', () => {
    const current = month(0);
    const join = month(-8);
    const increase = month(-2);
    const tenant = tenantWithHistory('t3', 'Cara', 'C-3', `${join}-10`, 10000, [entry(join, 10000), entry(increase, 12000)]);

    const unpaid = calculateUnpaid([tenant], [payment('t3', month(-6), 5000)]);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].amountDue).toBeCloseTo(91000, 2);
  });

  it('payment in wrong month does not apply', () => {
    const current = month(0);
    const join = month(-8);
    const increase = month(-2);
    const tenant = tenantWithHistory('t4', 'Dina', 'D-4', `${join}-10`, 10000, [entry(join, 10000), entry(increase, 12000)]);

    const unpaid = calculateUnpaid([tenant], [payment('t4', month(-1), 5000)]);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].amountDue).toBeCloseTo(91000, 2);
  });

  it('rent decrease also works', () => {
    const current = month(0);
    const join = month(-8);
    const decrease = month(-2);
    const tenant = tenantWithHistory('t5', 'Evan', 'E-5', `${join}-10`, 12000, [entry(join, 12000), entry(decrease, 9000)]);

    const unpaid = calculateUnpaid([tenant], []);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].monthsDue).toBe(9);
    expect(unpaid[0].amountDue).toBeCloseTo(99000, 2);
  });
});

describe('validateRentHistory', () => {
  it('rejects out-of-order months', () => {
    expect(() => validateRentHistory([entry('2024-06', 12000), entry('2024-05', 9000)])).toThrow();
  });

  it('rejects non-positive amount', () => {
    expect(() => validateRentHistory([entry('2024-01', 10000), entry('2024-02', 0)])).toThrow();
  });
});
