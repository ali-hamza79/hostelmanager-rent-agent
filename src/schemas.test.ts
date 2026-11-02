import { describe, expect, it } from 'vitest';
import { expenseSchema, tenantSchema } from './schemas';

describe('form schemas', () => {
  it('accepts empty optional tenant selections and nullable optional text', () => {
    const result = tenantSchema.safeParse({
      id: 'tenant-1',
      name: 'Amina',
      phone: null,
      floor: '1',
      room: 'A-1',
      joinDate: '2026-01-01',
      billingStartDate: null,
      occupation: null,
      occupationOther: null,
      mess: '',
      messOther: null,
      rent: 10000,
      status: '',
      rentHistory: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.occupation).toBe('');
      expect(result.data.mess).toBe('');
      expect(result.data.status).toBe('Active');
      expect(result.data.phone).toBe('');
    }
  });

  it('preserves ordinary punctuation in free-text fields and rejects invalid required values', () => {
    const safeText = expenseSchema.safeParse({
      id: 'expense-1',
      date: '2026-10-01',
      amount: 1500,
      category: 'Ali & Sons Utilities',
      note: null,
    });
    const invalidAmount = expenseSchema.safeParse({
      id: 'expense-2',
      date: '2026-10-01',
      amount: 0,
      category: 'Utilities',
    });

    expect(safeText.success).toBe(true);
    if (safeText.success) expect(safeText.data.category).toBe('Ali & Sons Utilities');
    expect(invalidAmount.success).toBe(false);
  });
});
