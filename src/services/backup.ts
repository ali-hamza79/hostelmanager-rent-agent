import { z } from 'zod';
import { dbPromise } from '../db/idb';
import { expenseSchema, hostelSchema, paymentSchema, roomSchema, tenantSchema } from '../schemas';

const backupSchema = z.object({
  format: z.literal('hostel-manager-backup'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  profile: hostelSchema.extend({ createdAt: z.string().datetime() }).nullable(),
  tenants: z.array(tenantSchema).max(10000),
  rooms: z.array(roomSchema).max(10000),
  payments: z.array(paymentSchema).max(50000),
  expenses: z.array(expenseSchema).max(50000),
});

export async function downloadBackup() {
  const db = await dbPromise;
  const [profile, tenants, rooms, payments, expenses] = await Promise.all([
    db.get('meta', 'hostel'),
    db.getAll('tenants'),
    db.getAll('rooms'),
    db.getAll('payments'),
    db.getAll('expenses'),
  ]);
  const backup = backupSchema.parse({
    format: 'hostel-manager-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: profile ? { name: profile.name, address: profile.address, createdAt: profile.createdAt } : null,
    tenants,
    rooms,
    payments,
    expenses,
  });
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `hostel-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function restoreBackupFile(file: File) {
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('Backup files must be smaller than 25 MB.');
  }
  let contents: unknown;
  try {
    contents = JSON.parse(await file.text());
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const parsed = backupSchema.safeParse(contents);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue ? `Backup validation failed: ${issue.path.join('.')}: ${issue.message}` : 'Backup validation failed.');
  }
  const backup = parsed.data;
  const db = await dbPromise;
  const tx = db.transaction(['meta', 'tenants', 'rooms', 'payments', 'expenses', 'syncQueue'], 'readwrite');
  await Promise.all([
    tx.objectStore('tenants').clear(),
    tx.objectStore('rooms').clear(),
    tx.objectStore('payments').clear(),
    tx.objectStore('expenses').clear(),
    tx.objectStore('syncQueue').clear(),
  ]);
  if (backup.profile) {
    await tx.objectStore('meta').put({ key: 'hostel', ...backup.profile });
  } else {
    await tx.objectStore('meta').delete('hostel');
  }
  for (const record of backup.tenants) await tx.objectStore('tenants').put(record);
  for (const record of backup.rooms) await tx.objectStore('rooms').put(record);
  for (const record of backup.payments) await tx.objectStore('payments').put(record);
  for (const record of backup.expenses) await tx.objectStore('expenses').put(record);
  await tx.done;
  window.dispatchEvent(new CustomEvent('hostel-sync-updated'));
}
