export type HostelMeta = {
  name: string;
  address: string;
  createdAt: string;
};

export type TenantStatus = 'Active' | 'Inactive';

export type Tenant = {
  id: string;
  name: string;
  phone: string;
  floor: string;
  room: string;
  joinDate: string;
  billingStartDate?: string;
  occupation: string;
  mess: string;
  rent: number;
  status: TenantStatus;
  rentHistory?: Array<{ effectiveMonth: string; amount: number }>;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
};

export type Room = {
  id: string;
  floor: string;
  room: string;
  capacity: number;
  occupiedTenantIds?: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type Payment = {
  id: string;
  tenantId: string;
  tenantName: string;
  month: string;
  amount: number;
  date: string;
  note: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
};

export type Expense = {
  id: string;
  date: string;
  amount: number;
  category: string;
  note: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
};

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

export type SyncSettings = {
  enabled: boolean;
  firebaseConfig: FirebaseWebConfig;
  sessionTimeoutMinutes?: 0 | 15 | 30 | 60;
};

export type RouteName = 'onboarding' | 'dashboard' | 'tenants' | 'rooms' | 'payments' | 'expenses' | 'settings';
