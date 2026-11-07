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
  assert.equal(result.reason, 'model_error');
  assert.equal(result.cases[0].tenantId, 'daniel');
  assert.equal(result.cases[0].proposedAction.amount, '700.00');
  assert.ok(result.warning);
});

test('uses template prose when Gemini invents an amount or omits the balance', async () => {
  const result = await analyzeRentSnapshot(snapshot([tenant()]), async () => ({
    summary: 'Overdue tenant.',
    cases: [{
      ...generatedCase('daniel'),
      explanation: 'The tenant owes $999.00.',
      draftReminder: 'Please pay your rent soon.',
    }],
  }));

  assert.match(result.cases[0].explanation, /700\.00 outstanding/);
  assert.doesNotMatch(result.cases[0].explanation, /999\.00/);
  assert.match(result.cases[0].draftReminder, /700\.00/);
  assert.doesNotMatch(result.cases[0].draftReminder, /999\.00/);
});

test('rejects partial decimal matches and invented dollar-word amounts', async () => {
  const result = await analyzeRentSnapshot(snapshot([tenant()]), async () => ({
    summary: 'Overdue tenant.',
    cases: [{
      ...generatedCase('daniel'),
      explanation: 'The correct balance is $700.001.',
      draftReminder: 'Please pay 999 dollars to Maple House.',
    }],
  }));

  assert.match(result.cases[0].explanation, /700\.00 outstanding/);
  assert.match(result.cases[0].draftReminder, /700\.00/);
  assert.doesNotMatch(result.cases[0].draftReminder, /999 dollars/);
});

test('allows grouped known amounts in Gemini prose', async () => {
  const daniel = tenant({
    outstandingAmount: 5600,
    monthsOverdue: 4,
    recentMonths: [
      { month: '2026-08', rentDue: 1400, amountPaid: 0, outstandingAmount: 1400, status: 'unpaid' },
      { month: '2026-09', rentDue: 1400, amountPaid: 0, outstandingAmount: 1400, status: 'unpaid' },
      { month: '2026-10', rentDue: 1400, amountPaid: 0, outstandingAmount: 1400, status: 'unpaid' },
    ],
  });
  const result = await analyzeRentSnapshot(snapshot([daniel]), async () => ({
    summary: 'One overdue tenant.',
    cases: [{
      ...generatedCase('daniel'),
      explanation: 'The balance is $5,600.00, including $1,400.00 due in October 2026.',
      draftReminder: 'Please pay $5,600.00 to Maple House.',
    }],
  }));

  assert.match(result.cases[0].explanation, /\$5,600\.00/);
  assert.match(result.cases[0].draftReminder, /\$5,600\.00/);
});

test('limits Gemini context to the three latest months when the snapshot has older arrears', async () => {
  const fourMonthTenant = tenant({
    outstandingAmount: 1400,
    monthsOverdue: 4,
    recentMonths: [
      { month: '2026-08', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
      { month: '2026-09', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
      { month: '2026-10', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
      { month: '2026-11', rentDue: 350, amountPaid: 0, outstandingAmount: 350, status: 'unpaid' },
    ],
  });
  let modelInput;
  await analyzeRentSnapshot(snapshot([fourMonthTenant]), async (input) => {
    modelInput = input;
    return {
      summary: 'One overdue tenant.',
      cases: [generatedCase('daniel')],
    };
  });

  assert.equal(modelInput.tenants[0].recentMonths.length, 3);
  assert.equal(modelInput.tenants[0].recentMonths[0].month, '2026-09');
});

test('classifies missing key and timeout fallback reasons', async () => {
  const missingKey = await analyzeRentSnapshot(snapshot([tenant()]), async () => {
    throw new Error('Missing GOOGLE_GENERATIVE_AI_API_KEY');
  });
  const timeout = await analyzeRentSnapshot(snapshot([tenant()]), async () => {
    const error = new Error('Request timed out');
    error.name = 'TimeoutError';
    throw error;
  });

  assert.equal(missingKey.reason, 'missing_key');
  assert.equal(timeout.reason, 'timeout');
});

test('rejects invalid snapshots and duplicate tenant IDs', async () => {
  await assert.rejects(() => analyzeRentSnapshot({}), { name: 'ZodError' });
  await assert.rejects(
    () => analyzeRentSnapshot(snapshot([tenant(), tenant()])),
    /tenant IDs must be unique/,
  );
});
