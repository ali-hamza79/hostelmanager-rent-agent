import { z } from 'zod';
import limits from '../shared/validation-limits.json';

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const sanitizeText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const text = (max: number, min = 0) => z.preprocess(
  (value) => value == null ? '' : typeof value === 'string' ? sanitizeText(value) : value,
  z.string().min(min).max(max),
);
const optionalText = (max: number) => text(max).optional().transform((value) => value ?? '');
const requiredMonth = z.string().regex(monthPattern, 'Month must use YYYY-MM format.');
const requiredDate = z.string().regex(datePattern, 'Date must use YYYY-MM-DD format.').refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date.');
const positiveMoney = z.coerce.number().finite().positive().max(100000000);
const optionalSelection = (choices: readonly [string, ...string[]], max: number) => z.preprocess(
  (value) => value == null ? '' : value,
  z.union([z.literal(''), z.enum(choices)]).or(text(max)),
);

export const hostelSchema = z.object({
  name: text(limits.hostelName, 1),
  address: text(limits.hostelAddress, 1),
});

export const tenantSchema = z.object({
  id: z.string().min(1).max(limits.recordId),
  name: text(limits.tenantName, 1),
  phone: optionalText(limits.phone),
  floor: text(limits.floor, 1),
  room: text(limits.room, 1),
  joinDate: requiredDate,
  billingStartDate: z.preprocess((value) => value == null || value === '' ? undefined : value, requiredMonth.optional()),
  occupation: optionalSelection(['Student', 'Professional', 'Business', 'Other'], limits.occupation),
  mess: optionalSelection(['Standard Mess', 'Vegetarian', 'No Mess / Self-Cook', 'Other'], limits.mess),
  rent: positiveMoney,
  status: z.preprocess((value) => value == null || value === '' ? 'Active' : value, z.enum(['Active', 'Inactive'])),
  rentHistory: z.preprocess((value) => value == null ? undefined : value, z.array(z.object({
    effectiveMonth: requiredMonth,
    amount: positiveMoney,
  })).max(limits.rentHistoryEntries).optional()).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
}).superRefine((tenant, context) => {
  const history = tenant.rentHistory;
  if (!history?.length) return;
  let prior = '';
  for (const [index, item] of history.entries()) {
    if (item.effectiveMonth <= prior) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rentHistory', index], message: 'Rent history must be in ascending month order.' });
    }
    prior = item.effectiveMonth;
  }
  if (history[0]?.effectiveMonth !== tenant.joinDate.slice(0, 7)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rentHistory', 0], message: 'The first rent entry must match the join month.' });
  }
});

export const roomSchema = z.object({
  id: z.string().min(1).max(limits.recordId + 1),
  floor: text(limits.floor, 1),
  room: text(limits.room, 1),
  capacity: z.coerce.number().int().min(1).max(limits.roomCapacity),
  occupiedTenantIds: z.array(z.string().min(1).max(limits.recordId)).max(limits.roomCapacity).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
});

export const paymentSchema = z.object({
  id: z.string().min(1).max(limits.recordId),
  tenantId: z.string().min(1).max(limits.recordId),
  tenantName: text(limits.tenantName, 1),
  month: requiredMonth,
  amount: positiveMoney,
  date: requiredDate,
  note: optionalText(limits.note),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
});

export const expenseSchema = z.object({
  id: z.string().min(1).max(limits.recordId),
  date: requiredDate,
  amount: positiveMoney,
  category: text(limits.category, 1),
  note: optionalText(limits.note),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
});

export const rentChangeSchema = z.object({
  tenantId: z.string().min(1).max(80),
  effectiveMonth: requiredMonth,
  newAmount: positiveMoney,
});
