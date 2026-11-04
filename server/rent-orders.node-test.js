import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { requireOwner } from './owner-auth.js';
import { createRentOrder, proveRentAmount, rememberCancel, syncOrder } from './rent-orders.js';

const tenant = {
  tenantId: 'demo-daniel-reyes',
  fullName: 'Daniel Reyes',
  room: '4B',
  outstandingAmount: 700,
  recentMonths: [
    { month: '2026-09', rentDue: 450, amountPaid: 450 },
    { month: '2026-10', rentDue: 450, amountPaid: 200 },
    { month: '2026-11', rentDue: 450, amountPaid: 0 },
  ],
};

const originalFetch = globalThis.fetch;
const originalEnv = {
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('rent order safety and idempotency', () => {
  it('derives rent from month rows and rejects a client amount mismatch', () => {
    const proof = proveRentAmount(tenant);
    assert.equal(proof.amount, 700);
    assert.deepEqual(proof.allocations, [
      { month: '2026-10', amount: '250.00' },
      { month: '2026-11', amount: '450.00' },
    ]);

    assert.throws(() => proveRentAmount({ ...tenant, outstandingAmount: 1 }), /does not match/);
  });

  it('rejects owner actions without a Firebase bearer token', async () => {
    let status;
    let body;
    const response = {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    };

    await requireOwner({ get: () => undefined }, response, () => assert.fail('next must not be called'));
    assert.equal(status, 401);
    assert.equal(body.error, 'Owner sign-in required.');
  });

  it('reuses a pending order and recovers a completed order after server memory is lost', async () => {
    process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
    process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    let createCount = 0;
    let captureCount = 0;
    let orderRequestBody;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
        createCount += 1;
        orderRequestBody = JSON.parse(init.body);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({
          id: 'TESTORDER123',
          status: 'CREATED',
          links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER123' }],
        }), { status: 201 });
      }
      if (url.endsWith('/v2/checkout/orders/RECOVERORDER123')) {
        return new Response(JSON.stringify({
          id: 'RECOVERORDER123',
          status: 'COMPLETED',
          purchase_units: [{
            reference_id: tenant.tenantId,
            custom_id: '700.00|USD|2026-10=250.00,2026-11=450.00',
            amount: { currency_code: 'USD', value: '700.00' },
            payments: {
              captures: [{
                id: 'CAPTURE123456789',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '700.00' },
              }],
            },
          }],
        }), { status: 200 });
      }
      if (url.includes('/capture')) captureCount += 1;
      throw new Error(`Unexpected mocked PayPal request: ${url}`);
    };

    const [first, second] = await Promise.all([
      createRentOrder({ tenant, hostelName: 'Maple House' }),
      createRentOrder({ tenant, hostelName: 'Maple House' }),
    ]);
    assert.equal(createCount, 1);
    assert.equal(
      orderRequestBody.payment_source.paypal.experience_context.payment_method_preference,
      'IMMEDIATE_PAYMENT_REQUIRED',
    );
    assert.equal(first.status, 'CREATED');
    assert.match(first.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
    assert.equal([first, second].filter((row) => row.reused).length, 1);

    const recovered = await syncOrder('RECOVERORDER123');
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recovered.captureId, 'CAPTURE123456789');
    assert.deepEqual(recovered.allocations, [
      { month: '2026-10', amount: '250.00' },
      { month: '2026-11', amount: '450.00' },
    ]);
    assert.equal(captureCount, 0);
  });

  it('preserves a recorded cancellation when PayPal still reports an open order', async () => {
    process.env.PAYPAL_CLIENT_ID = 'sandbox-client';
    process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret';
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith('/v2/checkout/orders/TESTORDER123')) {
        return new Response(JSON.stringify({
          id: 'TESTORDER123',
          status: 'PAYER_ACTION_REQUIRED',
          purchase_units: [{
            reference_id: tenant.tenantId,
            custom_id: '700.00|USD|2026-10=250.00,2026-11=450.00',
            amount: { currency_code: 'USD', value: '700.00' },
          }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected mocked PayPal request: ${url}`);
    };

    await createRentOrder({ tenant, hostelName: 'Maple House' });
    rememberCancel('TESTORDER123');
    const synced = await syncOrder('TESTORDER123');

    assert.equal(synced.status, 'CANCELLED');
    assert.equal(synced.captureId, null);
  });
});
