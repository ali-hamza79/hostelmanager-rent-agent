import { addMonths, format, parseISO, startOfMonth, subMonths } from 'date-fns';

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export type RentHistoryItem = {
  effectiveMonth: string;
  amount: number;
};

export function decimalAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return Number(amount.toFixed(2));
}

export function validateRentHistory(history: Array<{ effectiveMonth: string; amount: number }>) {
  if (!Array.isArray(history) || history.length === 0) return;

  let previous: Date | null = null;

  for (const entry of history) {
    if (!monthPattern.test(entry.effectiveMonth)) {
      throw new Error('Effective month must use YYYY-MM format.');
    }
    const monthDate = new Date(`${entry.effectiveMonth}-01T00:00:00`);
    if (previous && monthDate <= previous) {
      throw new Error('Rent history must be in ascending month order.');
    }
    if (entry.amount <= 0) {
      throw new Error('Rent entry amount must be greater than zero.');
    }
    previous = monthDate;
  }
}

export function buildRentByMonth(tenant: any, joinMonth: string) {
  const map = new Map<string, number>();
  const history = Array.isArray(tenant?.rentHistory) ? tenant.rentHistory : [];
  if (history.length === 0) {
    map.set(joinMonth, Number(tenant.rent));
    return map;
  }

  validateRentHistory(history);
  for (const entry of history) {
    map.set(entry.effectiveMonth, Number(entry.amount));
  }
  return map;
}

export function rentForMonth(rentMap: Map<string, number>, month: string) {
  const entries = Array.from(rentMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let current = 0;
  for (const [key, amount] of entries) {
    if (key <= month) current = amount;
  }
  return current;
}

export function aggregatePaymentsByMonth(payments: any[]) {
  const map = new Map<string, number>();
  for (const payment of payments) {
    const key = `${payment.tenantId}|${payment.month}`;
    map.set(key, (map.get(key) ?? 0) + Number(payment.amount));
  }
  return map;
}

export function calculateUnpaid(tenants: any[], payments: any[] = []) {
  const paid = aggregatePaymentsByMonth(payments);
  const currentMonth = format(new Date(), 'yyyy-MM');
  const result: Array<{ id: string; name: string; room: string; amountDue: number; monthsDue: number }> = [];

  for (const tenant of tenants) {
    if (!tenant || tenant.status !== 'Active') continue;

    const joinMonth = tenant.joinDate?.slice(0, 7) ?? currentMonth;
    const firstMonth = tenant.billingStartDate && tenant.billingStartDate >= joinMonth ? tenant.billingStartDate : joinMonth;
    if (firstMonth > currentMonth) continue;

    const rentMap = buildRentByMonth(tenant, joinMonth);
    let outstanding = 0;
    let monthsDue = 0;
    let cursor = firstMonth;

    while (cursor <= currentMonth) {
      const paidAmount = paid.get(`${tenant.id}|${cursor}`) ?? 0;
      const rent = rentForMonth(rentMap, cursor);
      const due = Math.max(rent - paidAmount, 0);
      if (due > 0) {
        outstanding += due;
        monthsDue += 1;
      }
      cursor = format(addMonths(parseISO(`${cursor}-01`), 1), 'yyyy-MM');
    }

    if (outstanding > 0) {
      result.push({
        id: tenant.id,
        name: tenant.name,
        room: tenant.room,
        amountDue: Number(outstanding.toFixed(2)),
        monthsDue,
      });
    }
  }

  return result;
}
