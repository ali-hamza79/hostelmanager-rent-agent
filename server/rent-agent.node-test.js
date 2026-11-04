import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRentSnapshot } from './rent-agent.js';

const tenant = (overrides = {}) => ({
  tenantId: 'daniel',
  fullName: 'Daniel Reyes',
  floor: '1',
  room: '101',
  monthlyRent: 350,
  outstandingAmount: 700,
  monthsOverdue: 2,
  recentMonths: [
    { month: '2026-09', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
    { month: '2026-10', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
  ],
  ...overrides,
});

const snapshot = (tenants) => ({
  hostelName: 'Maple House',
  asOf: '2026-10-15',
  currency: 'USD',
  tenants,
});

const generatedCase = (tenantId, amount = '1.00') => ({
  tenantId,
  rank: 99,
  explanation: `Generated explanation for ${tenantId}.`,
  draftReminder: `Hello ${tenantId} — please contact Maple House.`,
  proposedAction: {
    type: 'collect_rent',
    amount,
    currency: 'EUR',
    description: 'Collect rent',
  },
});

test('ranks overdue tenants deterministically and forces snapshot amounts', async () => {
  const daniel = tenant();
  const mina = tenant({
    tenantId: 'mina',
    fullName: 'Mina Okafor',
    outstandingAmount: 380,
    monthsOverdue: 1,
  });
  let modelInput;
  const result = await analyzeRentSnapshot(snapshot([mina, daniel]), async (input) => {
    modelInput = input;
    return {
      summary: 'Overdue tenants.',
      cases: [generatedCase('mina', '9999.99'), generatedCase('daniel', '0.01')],
    };
  });

  assert.equal(result.source, 'gemini');
  assert.deepEqual(result.cases.map((entry) => [entry.tenantId, entry.rank]), [['daniel', 1], ['mina', 2]]);
  assert.deepEqual(result.cases.map((entry) => entry.proposedAction.amount), ['700.00', '380.00']);
  assert.deepEqual(result.cases.map((entry) => entry.proposedAction.currency), ['USD', 'USD']);
  assert.deepEqual(modelInput.tenants.map((entry) => entry.tenantId), ['daniel', 'mina']);
});

test('does not call Gemini when there are no overdue tenants', async () => {
  let called = false;
  const result = await analyzeRentSnapshot(snapshot([
    tenant({ outstandingAmount: 0, monthsOverdue: 0 }),
  ]), async () => {
    called = true;
    throw new Error('Should not be called');
  });

  assert.equal(called, false);
  assert.deepEqual(result, { source: 'rules', summary: 'No overdue tenants.', cases: [] });
});

test('uses template text for omitted tenants and excludes paid tenants', async () => {
  const result = await analyzeRentSnapshot(snapshot([
    tenant(),
    tenant({ tenantId: 'paid', fullName: 'Paid Tenant', outstandingAmount: 0, monthsOverdue: 0 }),
  ]), async () => ({
    summary: 'One overdue tenant.',
    cases: [generatedCase('made-up')],
  }));

  assert.deepEqual(result.cases.map((entry) => entry.tenantId), ['daniel']);
  assert.match(result.cases[0].explanation, /September 2026/);
  assert.match(result.cases[0].draftReminder, /Maple House/);
});

test('returns ranked rules fallback if Gemini fails', async () => {
  const result = await analyzeRentSnapshot(snapshot([tenant()]), async () => {
    throw new Error('Provider unavailable');
  });

  assert.equal(result.source, 'rules_fallback');
  assert.equal(result.cases[0].tenantId, 'daniel');
  assert.equal(result.cases[0].proposedAction.amount, '700.00');
  assert.ok(result.warning);
});

test('rejects invalid snapshots and duplicate tenant IDs', async () => {
  await assert.rejects(() => analyzeRentSnapshot({}), { name: 'ZodError' });
  await assert.rejects(
    () => analyzeRentSnapshot(snapshot([tenant(), tenant()])),
    /tenant IDs must be unique/,
  );
});
