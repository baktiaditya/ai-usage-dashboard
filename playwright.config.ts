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
    // Build, seed, then serve through `npm run start`, which binds to AUD_PORT —
    // the path that keeps the refresh origin guard and the server on the same
    // port. The build is part of the command so a clean checkout never runs
    // against a missing or stale `.next`.
    command: 'npm run build && npm run seed:demo && npm run start',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      AUD_DATA_DIR: DATA_DIR,
      // Never merge a provisioned ~/.config/ai-usage-dashboard/collector.env.
      AUD_ENV_FILE: join(DATA_DIR, 'no-such-collector.env'),
      // `next start` also loads a repository `.env.local`, and @next/env fills a
      // variable only while it is unset. Blank keys keep a refresh from reaching
      // a real upstream and turning a seeded card healthy.
      DEEPSEEK_API_KEY: '',
      OPENROUTER_MANAGEMENT_KEY: '',
      AUD_PORT: String(PORT),
      AUD_TIMEZONE: 'Asia/Jakarta',
      AUD_LOG_LEVEL: 'warn',
    },
  },
});
