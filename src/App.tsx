import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format, parseISO } from 'date-fns';
import { useStore } from './state/store';
import {
  clearAll,
  deleteExpense,
  deletePayment,
  deleteRoom,
  deleteTenant,
  getExpenses,
  getMeta,
  getPayments,
  getRooms,
  getTenants,
  saveExpense,
  saveMeta,
  savePayment,
  saveRoom,
  saveTenant,
} from './db/repo';
import { buildRentByMonth, calculateUnpaid, rentForMonth } from './db/rent';
import { Expense, HostelMeta, Payment, Room, RouteName, Tenant } from './types';
import { SyncPill } from './components/SyncPill';
import { Settings } from './screens/Settings';
import { processSyncQueue } from './services/sync';
import { getSyncSettings, SyncStoreName } from './services/sync';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Onboarding } from './screens/Onboarding';
import { restoreRecord } from './db/repo';
import type { User } from 'firebase/auth';

const currency = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 2 });

const defaultTenant: Omit<Tenant, 'id'> = {
  name: '',
  phone: '',
  floor: '',
  room: '',
  joinDate: format(new Date(), 'yyyy-MM-dd'),
  billingStartDate: format(new Date(), 'yyyy-MM'),
  occupation: '',
  mess: '',
  rent: 0,
  status: 'Active',
};
const navItems: Array<[RouteName, string]> = [
  ['dashboard', 'Dashboard'],
  ['tenants', 'Tenants'],
  ['rooms', 'Rooms'],
  ['payments', 'Payments'],
  ['expenses', 'Expenses'],
  ['settings', 'Settings'],
];

const defaultRoom = { floor: '', room: '', capacity: 1 };
const expenseCategories = [
  'Food',
  'Electricity',
  'Gas',
  'Water',
  'Internet',
  'Maintenance',
  'Cleaning',
  'Staff Salary',
  'Supplies',
  'Other',
] as const;
const defaultExpense: Omit<Expense, 'id' | 'createdAt'> = { date: format(new Date(), 'yyyy-MM-dd'), amount: 0, category: 'Food', note: '' };
const defaultPayment: Omit<Payment, 'id' | 'createdAt'> = { tenantId: '', tenantName: '', month: format(new Date(), 'yyyy-MM'), amount: 0, date: format(new Date(), 'yyyy-MM-dd'), note: '' };

function formatMoney(value: number) {
  return currency.format(Number(value || 0));
}

function formatMonth(value: string | undefined) {
  if (!value) return '-';
  return format(parseISO(`${value}-01`), 'MMM yyyy');
}

function csvCell(value: string | number) {
  let text = String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportMonthlyReport(month: string, payments: Payment[], expenses: Expense[]) {
  const lines = [
    ['Type', 'Date', 'Month', 'Name / Category', 'Amount', 'Note'],
    ...payments.filter((payment) => payment.month === month).map((payment) => [
      'Payment', payment.date, payment.month, payment.tenantName, payment.amount, payment.note,
    ]),
    ...expenses.filter((expense) => expense.date.startsWith(`${month}-`)).map((expense) => [
      'Expense', expense.date, month, expense.category, expense.amount, expense.note,
    ]),
  ];
  const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `hostel-financial-report-${month}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function shareReceipt(payment: Payment) {
  const receipt = [
    'Hostel Manager - Payment Receipt',
    `Tenant: ${payment.tenantName}`,
    `Amount: ${formatMoney(payment.amount)}`,
    `For: ${formatMonth(payment.month)}`,
    `Paid on: ${payment.date}`,
    payment.note ? `Note: ${payment.note}` : '',
  ].filter(Boolean).join('\n');
  if (navigator.share) {
    await navigator.share({ title: 'Hostel payment receipt', text: receipt });
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(receipt);
    return;
  }
  window.prompt('Copy this payment receipt:', receipt);
}

function App() {
  const route = useStore((s) => s.route);
  const meta = useStore((s) => s.meta);
  const setMeta = useStore((s) => s.setMeta);
  const setRoute = useStore((s) => s.setRoute);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tenantForm, setTenantForm] = useState<Tenant & { id?: string }>({ ...defaultTenant, id: '' });
  const [occupationChoice, setOccupationChoice] = useState('Student');
  const [occupationOther, setOccupationOther] = useState('');
  const [messChoice, setMessChoice] = useState('Standard Mess');
  const [messOther, setMessOther] = useState('');
  const [roomForm, setRoomForm] = useState(defaultRoom);
  const [paymentForm, setPaymentForm] = useState(defaultPayment);
  const [expenseForm, setExpenseForm] = useState(defaultExpense);
  const [hostelForm, setHostelForm] = useState({ name: '', address: '' });
  const [dataReady, setDataReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [firebaseAuthLoading, setFirebaseAuthLoading] = useState(true);
  const [firebaseAuthError, setFirebaseAuthError] = useState('');
  const authRouteCheckStartedRef = useRef(false);
  const localMetaRef = useRef<HostelMeta | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useState('');
  const [formError, setFormError] = useState('');
  const [invalidField, setInvalidField] = useState('');
  const [roomSetupRequired, setRoomSetupRequired] = useState(false);
  const [lastSavedId, setLastSavedId] = useState('');
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => Promise<void> } | null>(null);

  useEffect(() => {
    setFormError('');
    setInvalidField('');
    if (route !== 'rooms') setRoomSetupRequired(false);
  }, [route]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const [{ getFirebaseServices }, { onAuthStateChanged }] = await Promise.all([
          import('./services/firebase'),
          import('firebase/auth'),
        ]);
        const { auth } = await getFirebaseServices();
        if (!active) return;
        unsubscribe = onAuthStateChanged(auth, (user) => {
          if (!active) return;
          setFirebaseUser(user);
          setFirebaseAuthError('');
          setFirebaseAuthLoading(false);
          if (!user) {
            authRouteCheckStartedRef.current = false;
            return;
          }
          authRouteCheckStartedRef.current = true;
          void (async () => {
            try {
              const { getCloudHostelProfile } = await import('./services/firebase');
              const profile = await getCloudHostelProfile(user);
              if (!active || !profile) {
                if (active) setRoute('onboarding');
                return;
              }
            } catch (reason) {
              if (!active) return;
              setFirebaseAuthError(reason instanceof Error
                ? reason.message
                : 'Could not verify the cloud hostel profile.');
              const localProfile = localMetaRef.current ?? await getMeta();
              if (!active) return;
              if (localProfile) {
                localMetaRef.current = localProfile;
                setMeta(localProfile);
                setHostelForm({ name: localProfile.name, address: localProfile.address });
                setRoute('dashboard');
              } else {
                setRoute('onboarding');
              }
            }
          })();
        });
      } catch (reason) {
        if (!active) return;
        setFirebaseAuthError(reason instanceof Error
          ? reason.message
          : 'Could not check the Firebase account session.');
        setFirebaseAuthLoading(false);
      }
    })();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [setMeta, setRoute]);

  useEffect(() => {
    const selectedTenant = tenants.find((tenant) => tenant.id === paymentForm.tenantId);
    if (selectedTenant) {
      if (paymentForm.tenantName !== selectedTenant.name) {
        setPaymentForm((current) => ({ ...current, tenantName: selectedTenant.name }));
      }
      return;
    }
    const firstTenant = tenants[0];
    if (firstTenant && paymentForm.tenantId !== firstTenant.id) {
      setPaymentForm((current) => ({ ...current, tenantId: firstTenant.id, tenantName: firstTenant.name }));
    } else if (!firstTenant && paymentForm.tenantId) {
      setPaymentForm((current) => ({ ...current, tenantId: '', tenantName: '' }));
    }
  }, [tenants, paymentForm.tenantId, paymentForm.tenantName]);

  useEffect(() => {
    const load = async () => {
      try {
        const currentMeta = await getMeta();
        localMetaRef.current = currentMeta ?? null;
        setMeta(currentMeta ?? null);
        if (currentMeta) {
          setHostelForm({ name: currentMeta.name, address: currentMeta.address });
          if (!authRouteCheckStartedRef.current) setRoute('dashboard');
        } else if (!authRouteCheckStartedRef.current) {
          setRoute('onboarding');
        }
        setTenants(await getTenants());
        setRooms(await getRooms());
        setPayments(await getPayments());
        setExpenses(await getExpenses());
        await processSyncQueue();
      } catch {
        setLoadError('The local workspace could not be opened. Check browser storage permissions and try again.');
      } finally {
        setDataReady(true);
      }
    };
    void load();
  }, [setMeta, setRoute]);

  const reloadLocalData = async () => {
    const [currentMeta, currentTenants, currentRooms, currentPayments, currentExpenses] = await Promise.all([
      getMeta(), getTenants(), getRooms(), getPayments(), getExpenses(),
    ]);
    setMeta(currentMeta ?? null);
    setTenants(currentTenants);
    setRooms(currentRooms);
    setPayments(currentPayments);
    setExpenses(currentExpenses);
    setRoute(currentMeta ? 'dashboard' : 'onboarding');
  };

  useEffect(() => {
    if (!meta || route === 'onboarding') return;
    let timer: number | undefined;
    let timeoutMinutes = 30;
    const activityEvents = ['pointerdown', 'keydown', 'touchstart'] as const;
    const lockOnIdle = () => {
      if (timer) window.clearTimeout(timer);
      if (timeoutMinutes > 0) timer = window.setTimeout(() => setRoute('onboarding'), timeoutMinutes * 60_000);
    };
    void getSyncSettings().then((settings) => {
      timeoutMinutes = settings?.sessionTimeoutMinutes ?? 30;
      lockOnIdle();
    });
    for (const event of activityEvents) window.addEventListener(event, lockOnIdle, { passive: true });
    lockOnIdle();
    return () => {
      if (timer) window.clearTimeout(timer);
      for (const event of activityEvents) window.removeEventListener(event, lockOnIdle);
    };
  }, [meta, route, setRoute]);

  useEffect(() => {
    const refresh = async () => {
      setTenants(await getTenants());
      setRooms(await getRooms());
      setPayments(await getPayments());
      setExpenses(await getExpenses());
    };
    window.addEventListener('hostel-sync-updated', refresh);
    return () => window.removeEventListener('hostel-sync-updated', refresh);
  }, []);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    const valid = ['onboarding', 'dashboard', 'tenants', 'rooms', 'payments', 'expenses', 'settings'] as const;
    if (valid.includes(hash as RouteName)) {
      setRoute(hash as RouteName);
    }
    const onHash = () => {
      const next = window.location.hash.replace('#', '') || 'dashboard';
      if (valid.includes(next as RouteName)) setRoute(next as RouteName);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setRoute]);

  useEffect(() => {
    if (meta) {
      window.location.hash = route;
    }
  }, [meta, route]);

  const unpaid = useMemo(() => calculateUnpaid(tenants, payments), [tenants, payments]);
  const activeTenants = useMemo(() => tenants.filter((tenant) => tenant.status === 'Active'), [tenants]);
  const inactiveTenants = tenants.length - activeTenants.length;
  const currentMonth = format(new Date(), 'yyyy-MM');
  const unpaidThisMonth = activeTenants.filter((tenant) => {
    const joinMonth = tenant.joinDate.slice(0, 7);
    const firstMonth = tenant.billingStartDate && tenant.billingStartDate >= joinMonth
      ? tenant.billingStartDate
      : joinMonth;
    if (firstMonth > currentMonth) return false;
    const rent = rentForMonth(buildRentByMonth(tenant, joinMonth), currentMonth);
    const paid = payments
      .filter((payment) => payment.tenantId === tenant.id && payment.month === currentMonth)
      .reduce((sum, payment) => sum + payment.amount, 0);
    return rent > paid;
  }).length;
  const occupiedBeds = activeTenants.reduce((count, tenant) => count + (rooms.some((room) =>
    !room.deletedAt && room.floor === tenant.floor && room.room === tenant.room) ? 1 : 0), 0);
  const totalBeds = rooms.reduce((sum, room) => sum + room.capacity, 0);
  const vacantBeds = Math.max(0, totalBeds - occupiedBeds);
  const activeFloors = [...new Set(rooms.filter((room) => !room.deletedAt).map((room) => room.floor))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const tenantRooms = rooms.filter((room) => !room.deletedAt && room.floor === tenantForm.floor);
  const selectedTenantRoom = tenantRooms.find((room) => room.room === tenantForm.room);
  const selectedRoomOccupancy = selectedTenantRoom
    ? activeTenants.filter((tenant) => tenant.id !== tenantForm.id
      && tenant.floor === selectedTenantRoom.floor
      && tenant.room === selectedTenantRoom.room).length
    : 0;
  const bedsLeft = selectedTenantRoom ? Math.max(0, selectedTenantRoom.capacity - selectedRoomOccupancy) : 0;
  useEffect(() => {
    if (tenantForm.id || tenantForm.floor || tenantForm.room) return;
    const firstAvailableRoom = rooms.find((room) => !room.deletedAt
      && activeTenants.filter((tenant) => tenant.floor === room.floor && tenant.room === room.room).length < room.capacity);
    if (firstAvailableRoom) {
      setTenantForm((current) => current.id || current.floor || current.room
        ? current
        : { ...current, floor: firstAvailableRoom.floor, room: firstAvailableRoom.room });
    }
  }, [activeTenants, rooms, tenantForm.floor, tenantForm.id, tenantForm.room]);
  const canSaveTenant = tenantForm.name.trim().length > 0
    && tenantForm.floor.length > 0
    && tenantForm.room.length > 0
    && Boolean(tenantForm.joinDate)
    && tenantForm.rent > 0
    && (tenantForm.status !== 'Active' || (selectedTenantRoom !== undefined && bedsLeft > 0));
  const canSaveRoom = roomForm.floor.trim().length > 0
    && roomForm.room.trim().length > 0
    && roomForm.floor.trim().length <= 40
    && roomForm.room.trim().length <= 40
    && !roomForm.floor.includes('/')
    && !roomForm.room.includes('/')
    && Number.isInteger(Number(roomForm.capacity))
    && Number(roomForm.capacity) > 0
    && Number(roomForm.capacity) <= 100
    && !rooms.some((room) => !room.deletedAt
      && room.floor === roomForm.floor.trim()
      && room.room === roomForm.room.trim());
  const canSavePayment = tenants.length > 0
    && Boolean(paymentForm.tenantId)
    && Number(paymentForm.amount) > 0
    && Boolean(paymentForm.month)
    && Boolean(paymentForm.date);
  const canSaveExpense = Number(expenseForm.amount) > 0
    && Boolean(expenseForm.category)
    && Boolean(expenseForm.date);
  const totalRentCollected = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const occupancy = totalBeds ? Math.min(100, (occupiedBeds / totalBeds) * 100) : 0;
  const tenantRoomIsRegistered = rooms.some((room) => !room.deletedAt
    && room.floor === tenantForm.floor.trim()
    && room.room === tenantForm.room.trim());

  const saveProfileAction = async (name: string, address: string) => {
    if (!name.trim() || !address.trim()) throw new Error('Hostel name and address are required.');
    const record: HostelMeta = {
      name: name.trim(),
      address: address.trim(),
      createdAt: meta?.createdAt ?? new Date().toISOString(),
    };
    await saveMeta(record);
    setMeta(record);
    setHostelForm({ name: record.name, address: record.address });
  };

  const saveTenantAction = async () => {
    const item: Tenant = {
      id: tenantForm.id || crypto.randomUUID(),
      name: tenantForm.name.trim(),
      phone: tenantForm.phone.trim(),
      floor: tenantForm.floor.trim(),
      room: tenantForm.room.trim(),
      joinDate: tenantForm.joinDate,
      billingStartDate: tenantForm.billingStartDate || tenantForm.joinDate.slice(0, 7),
      occupation: occupationChoice === 'Other' ? occupationOther.trim() : occupationChoice,
      mess: messChoice === 'Other' ? messOther.trim() : messChoice === 'No Mess / Self-Cook' ? 'Self-Cook' : messChoice === 'Standard Mess' ? 'Standard' : messChoice,
      rent: Number(tenantForm.rent || 0),
      status: tenantForm.status,
      rentHistory: tenantForm.rentHistory ?? (tenantForm.id ? undefined : [{ effectiveMonth: tenantForm.joinDate.slice(0, 7), amount: Number(tenantForm.rent || 0) }]),
    };
    await saveTenant(item);
    const next = [...tenants.filter((entry) => entry.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name));
    setTenants(next);
    setLastSavedId(item.id);
    window.setTimeout(() => setLastSavedId(''), 1500);
    setTenantForm({ ...defaultTenant, id: '' });
    setOccupationChoice('Student');
    setOccupationOther('');
    setMessChoice('Standard Mess');
    setMessOther('');
  };

  const saveRoomAction = async () => {
    const floor = roomForm.floor.trim();
    const roomName = roomForm.room.trim();
    const id = `${floor}_${roomName}`;
    if (rooms.some((room) => !room.deletedAt && room.floor === floor && room.room === roomName)) {
      throw new Error('This room is already registered on that floor.');
    }
    const item: Room = {
      id,
      floor,
      room: roomName,
      capacity: Number(roomForm.capacity || 1),
      occupiedTenantIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveRoom(item);
    setRooms([...rooms, item]);
    if (roomSetupRequired) {
      setTenantForm((current) => ({ ...current, floor, room: roomName }));
      setRoute('tenants');
      setRoomSetupRequired(false);
      return;
    }
    setRoomForm(defaultRoom);
  };

  const savePaymentAction = async () => {
    const tenant = tenants.find((entry) => entry.id === paymentForm.tenantId);
    const item: Payment = {
      id: crypto.randomUUID(),
      tenantId: paymentForm.tenantId,
      tenantName: tenant?.name ?? paymentForm.tenantName,
      month: paymentForm.month,
      amount: Number(paymentForm.amount),
      date: paymentForm.date,
      note: paymentForm.note,
      createdAt: new Date().toISOString(),
    };
    await savePayment(item);
    setPayments((all) => [item, ...all]);
    setLastSavedId(item.id);
    window.setTimeout(() => setLastSavedId(''), 1500);
    setPaymentForm({ ...defaultPayment, tenantId: '', tenantName: '' });
  };

  const saveExpenseAction = async () => {
    const item: Expense = { ...expenseForm, id: crypto.randomUUID(), createdAt: new Date().toISOString(), amount: Number(expenseForm.amount) };
    await saveExpense(item);
    setExpenses((all) => [item, ...all]);
    setLastSavedId(item.id);
    window.setTimeout(() => setLastSavedId(''), 1500);
    setExpenseForm(defaultExpense);
  };

  const clearAllAction = async () => {
    await clearAll();
    setMeta(null);
    setTenants([]);
    setRooms([]);
    setPayments([]);
    setExpenses([]);
    setRoute('onboarding');
  };

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    try {
      await action();
      setFormError('');
      setInvalidField('');
      setRoomSetupRequired(false);
      setToast(successMessage);
      window.setTimeout(() => setToast(''), 1800);
    } catch (reason) {
      const rawMessage = reason instanceof Error ? reason.message : 'The action could not be completed.';
      const field = rawMessage.includes(':') ? rawMessage.split(':', 1)[0] : '';
      const fieldLabels: Record<string, string> = {
        name: 'tenant name',
        phone: 'phone number',
        floor: 'floor',
        room: 'room',
        joinDate: 'join date',
        billingStartDate: 'billing start month',
        occupation: 'occupation',
        mess: 'mess option',
        rent: 'monthly rent',
        status: 'tenant status',
        capacity: 'room capacity',
        tenantId: 'tenant',
        tenantName: 'tenant name',
        month: 'payment month',
        amount: 'amount',
        date: 'date',
        note: 'note',
        category: 'expense category',
      };
      const friendlyField = fieldLabels[field];
      const needsRoomSetup = rawMessage.includes('Register this room and its bed capacity');
      const roomIsFull = rawMessage.includes('reached its registered bed capacity');
      const duplicateRoom = rawMessage.startsWith('This room is already registered');
      const message = needsRoomSetup
        ? `Room ${tenantForm.room.trim()} on floor ${tenantForm.floor.trim()} is not registered yet. Add it with its bed capacity, then save this tenant.`
        : roomIsFull
          ? 'This room is at capacity. Choose another room or increase its registered bed capacity before saving.'
          : duplicateRoom
            ? rawMessage
            : friendlyField
        ? field === 'category'
          ? 'Please choose an expense category.'
          : rawMessage.includes('at least 1 character')
            ? `Please enter the required ${friendlyField}.`
            : `Please check the ${friendlyField}.`
        : rawMessage.startsWith('[')
          ? 'Please check the entered information and try again.'
          : rawMessage;
      setInvalidField(needsRoomSetup || roomIsFull || duplicateRoom ? 'room' : friendlyField ? field : '');
      setRoomSetupRequired(needsRoomSetup);
      setFormError(message);
      setToast('');
    }
  };

  const deleteWithUndo = async (
    label: string,
    store: SyncStoreName,
    id: string,
    remove: (recordId: string) => Promise<void>,
    refresh: () => Promise<void>,
  ) => {
    try {
      await remove(id);
      await refresh();
      setFormError('');
      setUndoAction({
        label,
        run: async () => {
          await restoreRecord(store, id);
          await refresh();
        },
      });
      setToast(`${label} deleted`);
      window.setTimeout(() => {
        setToast('');
        setUndoAction(null);
      }, 7000);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : `Could not delete ${label.toLowerCase()}.`;
      setFormError('');
      setToast(message);
    }
  };

  if (!dataReady) {
    return <div className="loading-screen" role="status">Opening your offline workspace…</div>;
  }
  if (loadError) {
    return (
      <div className="landing-page">
        <section className="panel error-fallback" role="alert">
          <h2>Could not open Hostel Manager</h2>
          <p>{loadError}</p>
          <button className="primary-btn" onClick={() => window.location.reload()}>Try again</button>
        </section>
      </div>
    );
  }

  if (!meta || route === 'onboarding') {
    return (
      <ErrorBoundary key="onboarding">
        <Onboarding
          existingProfile={meta}
          onComplete={async (profile) => {
            setMeta(profile);
            setHostelForm({ name: profile.name, address: profile.address });
            setRoute('dashboard');
          }}
          onBack={meta ? () => setRoute('dashboard') : undefined}
        />
      </ErrorBoundary>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark">H</div>
          {!sidebarCollapsed && <div>
            <strong>{meta.name}</strong>
            <small>{meta.address}</small>
          </div>}
        </div>
        <button className="sidebar-collapse ghost-btn" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? '›' : '‹'}</button>
        {!sidebarCollapsed && <SyncPill />}

        <nav className="nav-list">
          {navItems.map(([key, label]) => (
            <button
              key={key}
              className={`nav-item ${route === key ? 'active' : ''}`}
              onClick={() => setRoute(key)}
              title={sidebarCollapsed ? label : undefined}
            >
              {sidebarCollapsed ? label.slice(0, 1) : label}
            </button>
          ))}
        </nav>
      </aside>

      <header className="mobile-header">
        <div className="brand-block">
          <div className="brand-mark">H</div><strong>{meta.name}</strong>
        </div>
        <div className="mobile-status"><SyncPill /></div>
      </header>

      <main
        className="main-panel"
        onChangeCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest('label.field-invalid')) {
            setInvalidField('');
            setFormError('');
            setRoomSetupRequired(false);
          }
        }}
      >
        <ErrorBoundary key={route}>
        <AnimatePresence mode="wait">
        <motion.div
          key={route}
          className="screen-transition"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
        {route === 'dashboard' && (
          <div className="screen-space">
            <h1>Dashboard</h1>
            <div className="stats-grid">
              <StatCard label="Outstanding rent" value={formatMoney(unpaid.reduce((sum, item) => sum + item.amountDue, 0))} tone="warn" />
              <StatCard label="Room occupancy" value={`${Math.round(occupancy)}%`} tone="brand" />
              <StatCard label="Rent collected" value={formatMoney(totalRentCollected)} tone="success" />
              <StatCard label="Expenses" value={formatMoney(totalExpenses)} tone="danger" />
            </div>
            <div className="cards-row">
              <section className="panel">
                <div className="section-heading"><h3>Active tenants</h3><span className="summary-chip success">{activeTenants.length} active</span></div>
                <ul className="list-stack">
                  {activeTenants.length === 0 ? <EmptyState icon="♙" message="No active tenants. Add a tenant to start tracking occupancy." action="Add tenant" onClick={() => setRoute('tenants')} /> : activeTenants.slice(0, 5).map((tenant) => (
                    <li key={tenant.id}><span>{tenant.name}</span><strong>{tenant.room}</strong></li>
                  ))}
                </ul>
              </section>
              <section className="panel">
                <div className="section-heading"><h3>Payments to review</h3><span className={`summary-chip ${unpaidThisMonth ? 'warning' : 'success'}`}>{unpaidThisMonth} due this month</span></div>
                <ul className="list-stack">
                  {unpaid.length === 0 ? <EmptyState icon="✓" message="No outstanding rent detected. New unpaid balances will appear here." action="Record payment" onClick={() => setRoute('payments')} /> : unpaid.slice(0, 5).map((item) => {
                    const tenant = tenants.find((record) => record.id === item.id);
                    const phone = tenant?.phone.replace(/\D/g, '');
                    const reminder = `Hello ${item.name}, a reminder that ${formatMoney(item.amountDue)} in rent is outstanding for ${item.monthsDue} month(s). Please contact the hostel if you have already paid.`;
                    return (
                      <li key={item.id}>
                        <span>{item.name}</span>
                        <strong>{formatMoney(item.amountDue)}</strong>
                        {phone && <a className="ghost-btn" href={`https://wa.me/${phone}?text=${encodeURIComponent(reminder)}`} target="_blank" rel="noreferrer">WhatsApp reminder</a>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </div>
        )}

        {route === 'tenants' && (
          <div className="screen-space">
            <div className="page-heading">
              <h1>Tenants</h1>
              <div className="summary-chips" aria-label="Tenant summary">
                <span className="summary-chip success">{activeTenants.length} active</span>
                <span className="summary-chip muted">{inactiveTenants} inactive</span>
                <span className="summary-chip brand">{vacantBeds} vacant beds</span>
              </div>
            </div>
            <div className="form-panel panel">
              <h3>{tenantForm.id ? 'Edit tenant' : 'Add tenant'} <span className="form-step">Identity · Accommodation · Rent</span></h3>
              {formError && <p className="inline-form-error" role="alert">{formError}</p>}
              <div className="field-grid">
                <div className="field-group-title wide">Identity</div>
                <label className={invalidField === 'name' ? 'field-invalid' : undefined}><span>Name</span><input type="text" value={tenantForm.name} onChange={(e) => setTenantForm({ ...tenantForm, name: e.target.value })} />{invalidField === 'name' && <small className="field-inline-error">Enter the tenant's name.</small>}</label>
                <label><span>Phone</span><input type="tel" value={tenantForm.phone} onChange={(e) => setTenantForm({ ...tenantForm, phone: e.target.value })} /></label>
                <div className="field-group-title wide">Accommodation</div>
                <label className={invalidField === 'floor' ? 'field-invalid' : undefined}><span>Floor</span>
                  <select value={tenantForm.floor} onChange={(e) => setTenantForm({ ...tenantForm, floor: e.target.value, room: '' })} disabled={activeFloors.length === 0}>
                    <option value="" disabled>{activeFloors.length ? 'Select floor' : 'Add a room first'}</option>
                    {activeFloors.map((floor) => <option key={floor} value={floor}>{floor}</option>)}
                  </select>
                  {invalidField === 'floor' && <small className="field-inline-error">Choose a floor.</small>}
                </label>
                <label className={invalidField === 'room' || (tenantForm.status === 'Active' && !tenantRoomIsRegistered) ? 'field-invalid' : undefined}>
                  <span>Room</span>
                  <select value={tenantForm.room} onChange={(e) => setTenantForm({ ...tenantForm, room: e.target.value })} disabled={!tenantForm.floor || tenantRooms.length === 0}>
                    <option value="" disabled>{tenantForm.floor ? (tenantRooms.length ? 'Select room' : 'No rooms on this floor') : 'Choose a floor first'}</option>
                    {tenantRooms.map((room) => {
                      const occupied = activeTenants.filter((tenant) => tenant.id !== tenantForm.id
                        && tenant.floor === room.floor
                        && tenant.room === room.room).length;
                      const remaining = Math.max(0, room.capacity - occupied);
                      return <option key={room.id} value={room.room} disabled={remaining === 0}>{room.room} · {remaining === 0 ? 'Full' : `${remaining} ${remaining === 1 ? 'bed' : 'beds'} left`}</option>;
                    })}
                  </select>
                  {invalidField === 'room' && <small className="field-inline-error">Choose an available room.</small>}
                  {selectedTenantRoom && <small className={bedsLeft === 0 ? 'field-help warning' : 'field-help'}>{bedsLeft === 0 ? 'Room is full' : `${bedsLeft} ${bedsLeft === 1 ? 'bed' : 'beds'} left`} · {selectedRoomOccupancy}/{selectedTenantRoom.capacity} occupied</small>}
                  {!selectedTenantRoom && <button type="button" className="inline-link" onClick={() => {
                    setRoomSetupRequired(true);
                    setRoomForm((current) => ({ ...current, floor: tenantForm.floor, room: tenantForm.room }));
                    setRoute('rooms');
                  }}>{activeFloors.length ? 'Add a room' : 'Register the first room'}</button>}
                </label>
                <div className="field-group-title wide">Stay and billing</div>
                <label className={invalidField === 'joinDate' ? 'field-invalid' : undefined}><span>Join date</span><input type="date" value={tenantForm.joinDate} onChange={(e) => setTenantForm({ ...tenantForm, joinDate: e.target.value })} />{invalidField === 'joinDate' && <small className="field-inline-error">Choose a valid join date.</small>}</label>
                <label className={invalidField === 'billingStartDate' ? 'field-invalid' : undefined}><span>Billing start</span><input type="month" value={tenantForm.billingStartDate || ''} onChange={(e) => setTenantForm({ ...tenantForm, billingStartDate: e.target.value })} />{invalidField === 'billingStartDate' && <small className="field-inline-error">Choose a valid billing month.</small>}</label>
                <label><span>Occupation</span><select value={occupationChoice} onChange={(e) => setOccupationChoice(e.target.value)}>
                  <option>Student</option><option>Professional</option><option>Business</option><option>Other</option>
                </select></label>
                {occupationChoice === 'Other' && <label><span>Occupation details</span><input value={occupationOther} maxLength={60} onChange={(e) => setOccupationOther(e.target.value)} /></label>}
                <label><span>Mess</span><select value={messChoice} onChange={(e) => setMessChoice(e.target.value)}>
                  <option>Standard Mess</option><option>Vegetarian</option><option>No Mess / Self-Cook</option><option>Other</option>
                </select></label>
                {messChoice === 'Other' && <label><span>Mess details (max 10 characters)</span><input value={messOther} maxLength={10} onChange={(e) => setMessOther(e.target.value)} /></label>}
                <label className={invalidField === 'rent' ? 'field-invalid' : undefined}><span>Monthly rent</span><input type="number" min="0.01" step="0.01" value={tenantForm.rent || ''} placeholder="Enter monthly rent" onChange={(e) => setTenantForm({ ...tenantForm, rent: Number(e.target.value) })} />{invalidField === 'rent' && <small className="field-inline-error">Enter a monthly rent greater than zero.</small>}</label>
                <label>
                  <span>Status <span className={`status-chip ${tenantForm.status === 'Active' ? 'success' : 'muted'}`}>{tenantForm.status}</span></span>
                  <select value={tenantForm.status} onChange={(e) => setTenantForm({ ...tenantForm, status: e.target.value as 'Active' | 'Inactive' })}>
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </label>
              </div>
              <button className="primary-btn" onClick={() => void runAction(saveTenantAction, 'Tenant saved · stored on this device')} disabled={!canSaveTenant}>Save tenant</button>
              {!canSaveTenant && <small className="muted-copy">Enter a name and rent, then assign an available registered room to save an active tenant.</small>}
            </div>

            <div className="panel">
              <div className="section-heading"><h3>Tenant list</h3><span className="summary-chip muted">{tenants.length} total</span></div>
              <ul className="list-stack tight">
                {tenants.length === 0 ? <EmptyState icon="♙" message="No tenants yet. Add the first tenant to start tracking rooms and payments." action="Add first tenant" onClick={() => document.querySelector('.form-panel input')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} /> : tenants.map((tenant) => (
                  <li key={tenant.id} className={lastSavedId === tenant.id ? 'list-item-saved' : undefined}>
                    <div>
                      <strong>{tenant.name}</strong>
                      <small>{tenant.floor} / {tenant.room} • <span className={`status-chip ${tenant.status === 'Active' ? 'success' : 'muted'}`}>{tenant.status}</span></small>
                    </div>
                    <div className="row-actions">
                      <button className="ghost-btn" onClick={() => {
                        setTenantForm(tenant);
                        const occupations = ['Student', 'Professional', 'Business'];
                        setOccupationChoice(occupations.includes(tenant.occupation) ? tenant.occupation : 'Other');
                        setOccupationOther(occupations.includes(tenant.occupation) ? '' : tenant.occupation);
                        const storedMess: Record<string, string> = { Standard: 'Standard Mess', Vegetarian: 'Vegetarian', 'Self-Cook': 'No Mess / Self-Cook' };
                        const selectedMess = storedMess[tenant.mess];
                        setMessChoice(selectedMess ?? 'Other');
                        setMessOther(selectedMess ? '' : tenant.mess);
                      }}>Edit</button>
                      <button className="danger-btn" onClick={() => void deleteWithUndo('Tenant', 'tenants', tenant.id, deleteTenant, async () => setTenants(await getTenants()))}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {route === 'rooms' && (
          <div className="screen-space">
            <div className="page-heading">
              <h1>Rooms</h1>
              <div className="summary-chips" aria-label="Room occupancy">
                <span className="summary-chip brand">{occupiedBeds}/{totalBeds} beds occupied</span>
                <span className="summary-chip success">{vacantBeds} vacant</span>
              </div>
            </div>
            <div className="panel form-panel">
              <h3>Add room <span className="form-step">Accommodation</span></h3>
              {formError && <p className="inline-form-error" role="alert">{formError}</p>}
              <div className="field-grid">
                <div className="field-group-title wide">Room details</div>
                <label className={invalidField === 'floor' ? 'field-invalid' : undefined}><span>Floor</span><input type="text" list="known-floors" maxLength={40} value={roomForm.floor} onChange={(e) => setRoomForm((p) => ({ ...p, floor: e.target.value }))} /><datalist id="known-floors">{[...new Set([...activeFloors, ...Array.from({ length: 10 }, (_, index) => String(index + 1))])].map((floor) => <option key={floor} value={floor} />)}</datalist>{invalidField === 'floor' && <small className="field-inline-error">Enter a floor.</small>}</label>
                <label className={invalidField === 'room' ? 'field-invalid' : undefined}><span>Room</span><input type="text" list="known-rooms" maxLength={40} value={roomForm.room} onChange={(e) => setRoomForm((p) => ({ ...p, room: e.target.value }))} /><datalist id="known-rooms">{rooms.filter((room) => !room.deletedAt && room.floor === roomForm.floor).map((room) => <option key={room.id} value={room.room} />)}</datalist>{invalidField === 'room' && <small className="field-inline-error">Enter a unique room on this floor.</small>}</label>
                <label className={invalidField === 'capacity' ? 'field-invalid' : undefined}><span>Bed capacity</span><input type="number" min="1" max="100" value={roomForm.capacity || ''} onChange={(e) => setRoomForm((p) => ({ ...p, capacity: Number(e.target.value) }))} />{invalidField === 'capacity' && <small className="field-inline-error">Enter a capacity from 1 to 100.</small>}</label>
              </div>
              <div className="room-preview">
                <div>
                  <small>Room preview</small>
                  <strong>Floor {roomForm.floor || '—'} · Room {roomForm.room || '—'}</strong>
                </div>
                <span className="summary-chip brand">{roomForm.capacity || 0} {roomForm.capacity === 1 ? 'bed' : 'beds'}</span>
              </div>
              <button className="primary-btn" onClick={() => void runAction(saveRoomAction, roomSetupRequired ? 'Room saved. Finish saving the tenant.' : 'Room saved · stored on this device')} disabled={!canSaveRoom}>Save room</button>
              {!canSaveRoom && <small className="muted-copy">Enter a floor and room, and set a capacity from 1 to 100. Room names must be unique on each floor.</small>}
            </div>

            <div className="panel">
              <div className="section-heading"><h3>Room list</h3><span className="summary-chip muted">{rooms.length} rooms</span></div>
              <ul className="list-stack tight">
                {rooms.length === 0 ? <EmptyState icon="▦" message="No rooms yet. Add rooms and bed capacities before assigning tenants." action="Add first room" onClick={() => document.querySelector('.form-panel input')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} /> : rooms.map((room) => {
                  const occupied = activeTenants.filter((tenant) => tenant.floor === room.floor && tenant.room === room.room).length;
                  const fillPercent = Math.min(100, (occupied / room.capacity) * 100);
                  return (
                  <li key={room.id} className={lastSavedId === room.id ? 'list-item-saved' : undefined}>
                    <div className="room-list-info"><strong>Floor {room.floor} · Room {room.room}</strong><small>{occupied}/{room.capacity} beds occupied · {Math.max(0, room.capacity - occupied)} vacant</small><div className="occupancy-track" aria-label={`${occupied} of ${room.capacity} beds occupied`}><span style={{ width: `${fillPercent}%` }} /></div></div>
                    <span className={`status-chip ${occupied >= room.capacity ? 'warning' : 'success'}`}>{occupied >= room.capacity ? 'Full' : 'Available'}</span>
                    <button className="danger-btn" onClick={() => void deleteWithUndo('Room', 'rooms', room.id, deleteRoom, async () => setRooms(await getRooms()))}>Delete</button>
                  </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {route === 'payments' && (
          <div className="screen-space">
            <div className="page-heading">
              <h1>Payments</h1>
              <div className="summary-chips"><span className={`summary-chip ${unpaidThisMonth ? 'warning' : 'success'}`}>{unpaidThisMonth} unpaid this month</span></div>
            </div>
            <div className="panel form-panel">
              <h3>Add payment <span className="form-step">Tenant · Billing period · Amount</span></h3>
              {formError && <p className="inline-form-error" role="alert">{formError}</p>}
              <div className="field-grid">
                <div className="field-group-title wide">Payment details</div>
                <label className={invalidField === 'tenantId' ? 'field-invalid' : undefined}><span>Tenant</span><select value={paymentForm.tenantId || tenants[0]?.id || ''} disabled={tenants.length === 0} onChange={(e) => {
                  const id = e.target.value;
                  const tenant = tenants.find((item) => item.id === id);
                  setPaymentForm((p) => ({ ...p, tenantId: id, tenantName: tenant?.name || p.tenantName }));
                }}>
                  {tenants.length === 0 && <option value="" disabled>No tenants available</option>}
                  {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
                </select>{tenants.length === 0 && <small className="field-help">Create a tenant before recording payments.</small>}{invalidField === 'tenantId' && <small className="field-inline-error">Choose a tenant.</small>}</label>
                <label className={invalidField === 'month' ? 'field-invalid' : undefined}><span>Month</span><input type="month" value={paymentForm.month} onChange={(e) => setPaymentForm((p) => ({ ...p, month: e.target.value }))} />{invalidField === 'month' && <small className="field-inline-error">Choose a valid month.</small>}</label>
                <label className={invalidField === 'amount' ? 'field-invalid' : undefined}><span>Amount</span><input type="number" min="0.01" step="0.01" value={paymentForm.amount || ''} placeholder="Enter amount" onChange={(e) => setPaymentForm((p) => ({ ...p, amount: Number(e.target.value) }))} />{invalidField === 'amount' && <small className="field-inline-error">Enter an amount greater than zero.</small>}</label>
                <label className={invalidField === 'date' ? 'field-invalid' : undefined}><span>Date</span><input type="date" value={paymentForm.date} onChange={(e) => setPaymentForm((p) => ({ ...p, date: e.target.value }))} />{invalidField === 'date' && <small className="field-inline-error">Choose a valid date.</small>}</label>
                <label className="wide"><span>Note</span><input type="text" value={paymentForm.note} onChange={(e) => setPaymentForm((p) => ({ ...p, note: e.target.value }))} /></label>
              </div>
              {tenants.length === 0 && <button type="button" className="inline-link" onClick={() => setRoute('tenants')}>Create a tenant first →</button>}
              <button className="primary-btn" onClick={() => void runAction(savePaymentAction, 'Payment saved · stored on this device')} disabled={!canSavePayment}>Save payment</button>
            </div>
            <div className="panel">
              <div className="section-heading"><h3>Payment history</h3><span className="summary-chip muted">{payments.length} payments</span></div>
              <ul className="list-stack tight">
                {payments.length === 0 ? <EmptyState icon="＄" message="No payments recorded yet. Payments you add will appear here by tenant and month." action={tenants.length ? 'Add first payment' : 'Create tenant first'} onClick={() => {
                  if (tenants.length) document.querySelector('.form-panel select')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  else setRoute('tenants');
                }} /> : payments.map((payment) => (
                  <li key={payment.id} className={lastSavedId === payment.id ? 'list-item-saved' : undefined}>
                    <span>{payment.tenantName}</span>
                    <strong>{formatMonth(payment.month)} • {formatMoney(payment.amount)}</strong>
                    <div className="row-actions">
                      <button className="ghost-btn" onClick={() => void runAction(() => shareReceipt(payment), 'Receipt ready to share')}>Share receipt</button>
                      <button className="danger-btn" onClick={() => void deleteWithUndo('Payment', 'payments', payment.id, deletePayment, async () => setPayments(await getPayments()))}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {route === 'expenses' && (
          <div className="screen-space">
            <h1>Expenses</h1>
            <div className="panel form-panel">
              <h3>Add expense <span className="form-step">Date · Category · Amount</span></h3>
              {formError && <p className="inline-form-error" role="alert">{formError}</p>}
              <div className="field-grid">
                <div className="field-group-title wide">Expense details</div>
                <label className={invalidField === 'date' ? 'field-invalid' : undefined}><span>Date</span><input type="date" value={expenseForm.date} onChange={(e) => setExpenseForm((p) => ({ ...p, date: e.target.value }))} />{invalidField === 'date' && <small className="field-inline-error">Choose a valid date.</small>}</label>
                <label className={invalidField === 'amount' ? 'field-invalid' : undefined}><span>Amount</span><input type="number" min="0.01" step="0.01" value={expenseForm.amount || ''} placeholder="Enter amount" onChange={(e) => setExpenseForm((p) => ({ ...p, amount: Number(e.target.value) }))} />{invalidField === 'amount' && <small className="field-inline-error">Enter an amount greater than zero.</small>}</label>
                <label className={invalidField === 'category' ? 'field-invalid' : undefined}><span>Category</span><select value={expenseForm.category} onChange={(e) => setExpenseForm((p) => ({ ...p, category: e.target.value }))}>
                  {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>{invalidField === 'category' && <small className="field-inline-error">Choose an expense category.</small>}</label>
                <label className="wide"><span>Note</span><input type="text" value={expenseForm.note} onChange={(e) => setExpenseForm((p) => ({ ...p, note: e.target.value }))} /></label>
              </div>
              <button className="primary-btn" onClick={() => void runAction(saveExpenseAction, 'Expense saved · stored on this device')} disabled={!canSaveExpense}>Save expense</button>
            </div>
            <div className="panel">
              <div className="section-heading"><h3>Expense history</h3><span className="summary-chip muted">{expenses.length} records</span></div>
              <ul className="list-stack tight">
                {expenses.length === 0 ? <EmptyState icon="↘" message="No expenses recorded yet. Track food, utilities, maintenance, and other costs here." action="Add first expense" onClick={() => document.querySelector('.form-panel input')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} /> : expenses.map((expense) => (
                  <li key={expense.id} className={lastSavedId === expense.id ? 'list-item-saved' : undefined}><div><strong>{expense.category}</strong><small>{expense.date}</small></div><strong>{formatMoney(expense.amount)}</strong><button className="danger-btn" onClick={() => void deleteWithUndo('Expense', 'expenses', expense.id, deleteExpense, async () => setExpenses(await getExpenses()))}>Delete</button></li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {route === 'settings' && (
          <Settings
            hostelName={meta.name}
            hostelAddress={meta.address}
            accountEmail={firebaseUser?.email ?? null}
            accountLoading={firebaseAuthLoading}
            accountError={firebaseAuthError}
            onSaveProfile={saveProfileAction}
            onEraseAll={clearAllAction}
            onDataReload={reloadLocalData}
            onExportReport={(month) => exportMonthlyReport(month, payments, expenses)}
            onOpenSignIn={() => setRoute('onboarding')}
            onSignOut={async () => {
              const { signOutFromFirebase } = await import('./services/firebase');
              await signOutFromFirebase();
            }}
          />
        )}
        </motion.div>
        </AnimatePresence>
        </ErrorBoundary>
      </main>
      <nav className="mobile-tabbar" aria-label="Main navigation">
        {navItems.map(([key, label]) => (
          <button key={key} className={`mobile-tab ${route === key ? 'active' : ''}`} onClick={() => setRoute(key)} aria-label={label}>
            {route === key && <motion.span className="tab-indicator" layoutId="active-tab" transition={{ type: 'spring', stiffness: 420, damping: 32 }} />}
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>
      <AnimatePresence>
        {toast && (
          <motion.div className="toast-message" role="status" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
            <span>{toast}</span>
            {undoAction && <button type="button" className="toast-undo" onClick={() => {
              const selected = undoAction;
              void runAction(async () => { await selected.run(); setUndoAction(null); }, `${selected.label} restored`);
            }}>Undo</button>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: 'brand' | 'warn' | 'success' | 'danger' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({
  icon,
  message,
  action,
  onClick,
}: {
  icon: string;
  message: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <li className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">{icon}</span>
      <p>{message}</p>
      <button type="button" className="ghost-btn" onClick={onClick}>{action}</button>
    </li>
  );
}

export { App };
