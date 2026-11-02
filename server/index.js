import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

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

app.post('/api/orders', async (req, res) => {
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

app.post('/api/orders/:id/capture', async (req, res) => {
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

app.listen(PORT, () => console.log(`Server on :${PORT}`));