import { paypal, money, newRequestId } from './paypal.js';

const orders = new Map();
const pendingOrders = new Map();
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const orderIdPattern = /^[A-Z0-9]{10,25}$/i;

function isMoney(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100000000;
}

export function proveRentAmount(tenant) {
  if (!tenant || typeof tenant !== 'object'
    || typeof tenant.tenantId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(tenant.tenantId)
    || typeof tenant.fullName !== 'string'
    || tenant.fullName.length === 0
    || typeof tenant.room !== 'string'
    || !Array.isArray(tenant.recentMonths)
    || tenant.recentMonths.length === 0
    || tenant.recentMonths.length > 36) {
    throw new Error('Invalid tenant snapshot.');
  }

  const seenMonths = new Set();
  const allocations = [];
  let total = 0;
  for (const month of tenant.recentMonths) {
    if (!month || typeof month.month !== 'string' || !monthPattern.test(month.month)
      || seenMonths.has(month.month)
      || !isMoney(month.rentDue)
      || !isMoney(month.amountPaid)) {
      throw new Error('Invalid payment month in tenant snapshot.');
    }
    seenMonths.add(month.month);
    const due = Math.max(0, Math.round((month.rentDue - month.amountPaid) * 100) / 100);
    if (due > 0) {
      allocations.push({ month: month.month, amount: money(due) });
      total += due;
    }
  }

  const amount = Math.round(total * 100) / 100;
  const claimed = Number(tenant.outstandingAmount);
  if (!Number.isFinite(claimed) || Math.abs(amount - claimed) > 0.009) {
    throw new Error('Outstanding amount does not match the payment months.');
  }
  if (amount <= 0) throw new Error('There is no outstanding rent to collect.');
  if (amount > 5000) throw new Error('Rent request exceeds the $5,000 demo limit.');
  if (customIdFor(amount, allocations).length > 127) {
    throw new Error('Payment history is too large for a PayPal rent order.');
  }

  return { amount, allocations };
}

function customIdFor(amount, allocations) {
  return `${money(amount)}|USD|${allocations.map(({ month, amount: value }) => `${month}=${value}`).join(',')}`;
}

function parseOrderMetadata(order) {
  const purchaseUnit = order.purchase_units?.[0];
  const tenantId = purchaseUnit?.reference_id;
  const customId = purchaseUnit?.custom_id || '';
  const [amount, currency, allocationText] = customId.split('|');
  const allocations = (allocationText || '').split(',').filter(Boolean).map((entry) => {
    const [month, value] = entry.split('=');
    if (!monthPattern.test(month || '') || !/^\d{1,8}\.\d{2}$/.test(value || '')) {
      throw new Error('PayPal order is missing valid payment allocation metadata.');
    }
    return { month, amount: value };
  });
  const total = allocations.reduce((sum, item) => sum + Number(item.amount), 0);
  const liveAmount = purchaseUnit?.amount?.value;
  const liveCurrency = purchaseUnit?.amount?.currency_code;
  if (typeof tenantId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)
    || !/^\d{1,8}\.\d{2}$/.test(amount || '')
    || currency !== 'USD'
    || allocations.length === 0
    || Math.abs(total - Number(amount)) > 0.009
    || Math.abs(Number(liveAmount) - Number(amount)) > 0.009
    || liveCurrency !== 'USD') {
    throw new Error('PayPal order details do not match the rent request.');
  }
  return { tenantId, amount, currency, allocations };
}

function approvalUrl(order) {
  const href = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  if (!href) return null;
  try {
    const url = new URL(href);
    const paypalHost = url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com');
    return url.protocol === 'https:' && paypalHost ? url.href : null;
  } catch {
    return null;
  }
}

function verifiedCaptureId(order, expectedAmount) {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) return null;
  if (capture.amount?.currency_code !== 'USD'
    || Math.abs(Number(capture.amount?.value) - Number(expectedAmount)) > 0.009) {
    throw new Error('PayPal capture amount does not match the rent order.');
  }
  return capture.id || null;
}

export async function createRentOrder({ tenant, hostelName }) {
  const { amount, allocations } = proveRentAmount(tenant);
  const alreadyCreating = pendingOrders.get(tenant.tenantId);
  if (alreadyCreating) return { ...(await alreadyCreating), reused: true };

  const open = [...orders.values()].find((row) => row.tenantId === tenant.tenantId
    && !['COMPLETED', 'VOIDED', 'CANCELLED'].includes(row.status));
  if (open) return { ...open, reused: true };

  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!publicBase) throw new Error('PUBLIC_BASE_URL is not configured on the server.');

  const createPromise = (async () => {
    const requestId = newRequestId();
    const order = await paypal('/v2/checkout/orders', {
      method: 'POST',
      requestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: tenant.tenantId,
          custom_id: customIdFor(amount, allocations),
          invoice_id: `hostel-${requestId}`.slice(0, 127),
          description: `${hostelName || 'Hostel'} rent for ${tenant.fullName}`.slice(0, 127),
          amount: { currency_code: 'USD', value: money(amount) },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: (hostelName || 'Hostel').slice(0, 127),
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              return_url: `${publicBase}/api/paypal/return`,
              cancel_url: `${publicBase}/api/paypal/cancel`,
            },
          },
        },
      },
    });

    const row = {
      orderId: order.id,
      tenantId: tenant.tenantId,
      fullName: tenant.fullName,
      room: tenant.room,
      amount: money(amount),
      currency: 'USD',
      allocations,
      status: order.status,
      approveUrl: approvalUrl(order),
      captureId: null,
      createdAt: new Date().toISOString(),
    };
    if (!row.orderId || !row.approveUrl) throw new Error('PayPal did not return a usable approval link.');
    orders.set(row.orderId, row);
    return row;
  })();

  pendingOrders.set(tenant.tenantId, createPromise);
  try {
    return await createPromise;
  } finally {
    pendingOrders.delete(tenant.tenantId);
  }
}

export async function syncOrder(orderId) {
  if (typeof orderId !== 'string' || !orderIdPattern.test(orderId)) {
    throw new Error('Invalid PayPal order ID.');
  }
  const live = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  const metadata = parseOrderMetadata(live);
  const prior = orders.get(orderId);
  const status = prior?.status === 'CANCELLED'
    && !['APPROVED', 'COMPLETED', 'VOIDED'].includes(live.status)
    ? 'CANCELLED'
    : live.status;
  let row = {
    ...prior,
    orderId,
    ...metadata,
    status,
    captureId: verifiedCaptureId(live, metadata.amount) || prior?.captureId || null,
    approveUrl: approvalUrl(live) || prior?.approveUrl || null,
  };

  if (live.status === 'APPROVED') {
    const captured = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      requestId: `capture-${orderId}`,
      body: {},
    });
    row = {
      ...row,
      status: captured.status,
      captureId: verifiedCaptureId(captured, metadata.amount) || row.captureId,
    };
  }

  if (row.status === 'COMPLETED' && !row.captureId) {
    const refreshed = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    row.captureId = verifiedCaptureId(refreshed, metadata.amount);
  }
  if (row.status === 'COMPLETED' && !row.captureId) {
    throw new Error('PayPal marked the order completed but returned no capture ID.');
  }
  orders.set(orderId, row);

  return {
    orderId,
    tenantId: row.tenantId,
    fullName: row.fullName || null,
    room: row.room || null,
    amount: row.amount,
    currency: row.currency,
    allocations: row.allocations,
    status: row.status,
    captureId: row.captureId,
    approveUrl: row.status === 'COMPLETED' ? null : row.approveUrl,
  };
}

export function rememberCancel(orderId) {
  const row = orders.get(orderId);
  if (row && row.status !== 'COMPLETED') orders.set(orderId, { ...row, status: 'CANCELLED' });
}
