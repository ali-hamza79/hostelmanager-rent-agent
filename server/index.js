import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { requireOwner } from './owner-auth.js';
import { createRentOrder, proveRentAmount, rememberCancel, syncOrder } from './rent-orders.js';
import { createRentOrderSyncHandler } from './rent-order-handlers.js';
import { analyzeRentSnapshot } from './rent-agent.js';

   const {
     PAYPAL_CLIENT_ID,
     PAYPAL_CLIENT_SECRET,
     ALLOWED_ORIGIN = 'http://localhost:5173',
     PORT = 3000,
   } = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET');
  process.exit(1);
}

const PAYPAL = 'https://api-m.sandbox.paypal.com';
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

let cached = { token: null, exp: 0 };
async function getToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token error ${res.status}`);
  const d = await res.json();
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return cached.token;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/orders', requireOwner, async (req, res) => {
  try {
    const { amount, tenantId = 'tenant', month = '', description = 'Hostel rent' } = req.body ?? {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > 5000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const token = await getToken();
    const r = await fetch(`${PAYPAL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `${String(tenantId).slice(0, 60)}-${String(month).slice(0, 10)}`,
          description: String(description).slice(0, 120),
          amount: { currency_code: 'USD', value: value.toFixed(2) },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'HostelManager',
              user_action: 'PAY_NOW',
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              return_url: `${ALLOWED_ORIGIN}/?paypal=return`,
              cancel_url: `${ALLOWED_ORIGIN}/?paypal=cancel`,
            },
          },
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const link = data.links?.find((l) => l.rel === 'payer-action');
    res.json({ orderId: data.id, status: data.status, approveUrl: link?.href });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/orders/:id/capture', requireOwner, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[A-Z0-9]{10,25}$/i.test(id)) return res.status(400).json({ error: 'Bad order id' });
    const token = await getToken();
    const r = await fetch(`${PAYPAL}/v2/checkout/orders/${id}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture-${id}`,
      },
      body: '{}',
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
    res.json({ status: data.status, captureId: cap?.id, amount: cap?.amount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/rent/request', requireOwner, async (req, res) => {
  const tenant = req.body?.tenant;
  try {
    proveRentAmount(tenant);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid tenant snapshot.' });
  }

  try {
    const row = await createRentOrder({ tenant, hostelName: req.body?.hostelName });
    return res.status(201).json(row);
  } catch (error) {
    console.error('PayPal rent order creation failed:', error);
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Could not create the PayPal order.' });
  }
});

app.post('/api/agent/analyze', requireOwner, async (req, res) => {
  try {
    const result = await analyzeRentSnapshot(req.body?.snapshot);
    return res.json(result);
  } catch (error) {
    if (error?.name === 'ZodError' || error instanceof Error && error.message === 'Snapshot tenant IDs must be unique.') {
      return res.status(400).json({ error: 'Snapshot is invalid or missing.' });
    }
    console.error('Rent Agent analysis failed:', error);
    return res.status(500).json({ error: 'Could not analyze the rent snapshot.' });
  }
});

app.get('/api/paypal/return', async (req, res) => {
  const orderId = req.query.token;
  if (typeof orderId !== 'string') return res.status(400).send('Missing PayPal order ID.');
  try {
    const row = await syncOrder(orderId);
    const destination = new URL('/', ALLOWED_ORIGIN);
    destination.hash = 'dashboard';
    destination.searchParams.set('paypal', row.status === 'COMPLETED' ? 'completed' : 'pending');
    destination.searchParams.set('orderId', row.orderId);
    return res.redirect(303, destination.toString());
  } catch (error) {
    console.error('PayPal return sync failed:', error);
    return res.status(502).send('Could not confirm the PayPal payment. Contact the hostel owner before retrying.');
  }
});

app.get('/api/paypal/cancel', (req, res) => {
  const orderId = req.query.token;
  if (typeof orderId !== 'string') return res.status(400).send('Missing PayPal order ID.');
  rememberCancel(orderId);
  const destination = new URL('/', ALLOWED_ORIGIN);
  destination.hash = 'dashboard';
  destination.searchParams.set('paypal', 'cancelled');
  destination.searchParams.set('orderId', orderId);
  return res.redirect(303, destination.toString());
});

app.post('/api/rent/orders/:orderId/sync', requireOwner, createRentOrderSyncHandler(syncOrder));

app.listen(PORT, () => console.log(`Server on :${PORT}`));