import { format, subMonths } from 'date-fns';
import { buildRentByMonth, calculateUnpaid, rentForMonth } from '../db/rent';
import type { HostelMeta, Payment, Tenant } from '../types';

export type AgentSnapshot = {
  hostelName: string;
  asOf: string;
  currency: 'USD';
  tenants: Array<{
    tenantId: string;
    fullName: string;
    floor: string;
    room: string;
    monthlyRent: number;
    outstandingAmount: number;
    monthsOverdue: number;
    recentMonths: Array<{
      month: string;
      rentDue: number;
      amountPaid: number;
      outstandingAmount: number;
      status: 'paid' | 'partial' | 'unpaid';
    }>;
  }>;
};

function money(value: number) {
  return Number(value.toFixed(2));
}

export function buildSnapshot(
  meta: HostelMeta | null,
  tenants: Tenant[],
  payments: Payment[],
): AgentSnapshot {
  if (!meta) throw new Error('Set up the hostel profile before creating an agent snapshot.');

  const asOf = new Date();
  const currentMonth = format(asOf, 'yyyy-MM');
  const activeTenants = tenants.filter((tenant) => tenant.status === 'Active');
  const unpaidByTenant = new Map(
    calculateUnpaid(activeTenants, payments).map((item) => [item.id, item]),
  );
  const recentMonthKeys = [-2, -1, 0]
    .map((offset) => format(subMonths(asOf, Math.abs(offset)), 'yyyy-MM'));

  return {
    hostelName: meta.name,
    asOf: format(asOf, 'yyyy-MM-dd'),
    currency: 'USD',
    tenants: activeTenants.map((tenant) => {
      const joinMonth = tenant.joinDate.slice(0, 7);
      const firstMonth = tenant.billingStartDate && tenant.billingStartDate >= joinMonth
        ? tenant.billingStartDate
        : joinMonth;
      const rentByMonth = buildRentByMonth(tenant, joinMonth);
      const recentMonths = recentMonthKeys
        .filter((month) => month >= firstMonth && month <= currentMonth)
        .map((month) => {
          const rentDue = rentForMonth(rentByMonth, month);
          const amountPaid = payments
            .filter((payment) => payment.tenantId === tenant.id && payment.month === month)
            .reduce((total, payment) => total + Number(payment.amount), 0);
          const outstandingAmount = money(Math.max(rentDue - amountPaid, 0));
          const status: 'paid' | 'partial' | 'unpaid' = outstandingAmount === 0
            ? 'paid'
            : amountPaid === 0 ? 'unpaid' : 'partial';

          return {
            month,
            rentDue: money(rentDue),
            amountPaid: money(amountPaid),
            outstandingAmount,
            status,
          };
        });
      const unpaid = unpaidByTenant.get(tenant.id);

      return {
        tenantId: tenant.id,
        fullName: tenant.name,
        floor: tenant.floor,
        room: tenant.room,
        monthlyRent: money(rentForMonth(rentByMonth, currentMonth)),
        outstandingAmount: money(unpaid?.amountDue ?? 0),
        monthsOverdue: unpaid?.monthsDue ?? 0,
        recentMonths,
      };
    }),
  };
}
