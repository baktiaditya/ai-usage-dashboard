import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Live smoke checks only. Kept in a separate config so the default `npm test`
 * can never reach a real provider endpoint or a real local account.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 60_000,
    // These talk to the network and to a CLI; running them in parallel would
    // make an upstream rate limit look like a bug.
    fileParallelism: false,
  },
});
