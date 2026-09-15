import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clearProviderKeys } from './credentials';

/**
 * Manual refresh actually collects, so it mutates the seeded database. It lives
 * in its own file with a re-seed afterwards, so the read-only assertions in
 * dashboard.spec.ts always see the state the seed intended — including when
 * both the desktop and mobile projects run in one invocation.
 */
test.afterAll(() => {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/seed-demo.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUD_DATA_DIR: join(process.cwd(), '.playwright', 'data') },
      stdio: 'ignore',
    },
  );
});

// The desktop project's settings spec runs before the mobile project reaches
// this file; DeepSeek must have no saved key here.
test.beforeEach(async ({ request }) => {
  await clearProviderKeys(request);
});

test('manual refresh is scoped to one provider and reports its outcome', async ({ page }) => {
  await page.goto('/');
  const before = await page.getByTestId('status-deepseek').innerText();
  expect(before).toMatch(/Stale/);

  await page.getByTestId('refresh-deepseek').click();

  // DeepSeek has no credential in the test environment, so a real refresh moves
  // it to `unavailable` — and leaves every other card untouched.
  await expect(page.getByTestId('status-deepseek')).toHaveText(/Unavailable/, { timeout: 15_000 });
  await expect(page.getByTestId('status-codex')).toHaveText(/Healthy/);
  await expect(page.getByTestId('status-openrouter')).toHaveText(/Error/);
});

test('manual refresh is rate limited rather than hammering the provider', async ({ page }) => {
  await page.goto('/');

  // The limiter allows 6 per provider per minute; the 7th must be refused
  // locally rather than forwarded upstream.
  for (let i = 0; i < 7; i += 1) {
    await page.getByTestId('refresh-codex').click();
    await expect(page.getByTestId('refresh-codex')).toBeEnabled({ timeout: 15_000 });
  }
  await expect(page.getByTestId('refresh-error-codex')).toContainText(/Too many refreshes/);
});
