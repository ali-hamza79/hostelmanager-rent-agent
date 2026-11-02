import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['firestore-tests/rules-check.ts'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
