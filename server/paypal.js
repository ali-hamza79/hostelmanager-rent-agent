import crypto from 'node:crypto';

const apiBase = () => process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

let token;
let tokenExpiresAt = 0;

async function paypalToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PayPal credentials are not configured on the server.');
  }

  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status}).`);

  token = data.access_token;
  tokenExpiresAt = Date.now() + Number(data.expires_in) * 1000;
  return token;
}

export async function paypal(path, { method = 'GET', body, requestId } = {}) {
  const accessToken = await paypalToken();
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = data?.details?.[0]?.description || data?.message || response.status;
    throw new Error(`PayPal ${method} request failed: ${description}`);
  }
  return data;
}

export function newRequestId() {
  return crypto.randomUUID();
}

export function money(value) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}
