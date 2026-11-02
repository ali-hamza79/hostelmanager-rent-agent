import { openDB } from 'idb';

export const DB_NAME = 'hostel-manager-db';
export const DB_VERSION = 2;

export const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains('tenants')) {
      db.createObjectStore('tenants', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('rooms')) {
      db.createObjectStore('rooms', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('payments')) {
      db.createObjectStore('payments', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('expenses')) {
      db.createObjectStore('expenses', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('syncQueue')) {
      db.createObjectStore('syncQueue', { keyPath: 'id' });
    }
  },
});
