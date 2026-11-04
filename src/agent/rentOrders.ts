import type { AgentSnapshot } from './snapshot';

export type RentOrderResult = {
  orderId: string;
  tenantId: string;
  fullName: string | null;
  room: string | null;
  amount: string;
  currency: 'USD';
  allocations: Array<{ month: string; amount: string }>;
  status: string;
  captureId: string | null;
  approveUrl: string | null;
  reused?: boolean;
};

const serverUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

export async function ownerRequest<T>(path: string, body?: unknown): Promise<T> {
  const { getFirebaseServices } = await import('../services/firebase');
  const { auth } = await getFirebaseServices();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in with the hostel owner account before running owner actions.');

  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : `Rent action failed (${response.status}).`);
  }
  return result as T;
}

export function requestRentOrder(hostelName: string, tenant: AgentSnapshot['tenants'][number]) {
  return ownerRequest<RentOrderResult>('/api/rent/request', { hostelName, tenant });
}

export function syncRentOrder(orderId: string) {
  return ownerRequest<RentOrderResult>(`/api/rent/orders/${encodeURIComponent(orderId)}/sync`, {});
}
