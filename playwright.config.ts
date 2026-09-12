import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

/**
 * Browser smoke tests run against a real production build with a seeded
 * database, in an isolated data directory so they can never read or write real
 * collection history.
 */
const DATA_DIR = join(import.meta.dirname, '.playwright', 'data');
const PORT = 3939;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'line' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // Seed, then serve the production build bound to loopback only.
    command: `npm run seed:demo && npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AUD_DATA_DIR: DATA_DIR,
      AUD_PORT: String(PORT),
      AUD_TIMEZONE: 'Asia/Jakarta',
      AUD_LOG_LEVEL: 'warn',
    },
  },
});
