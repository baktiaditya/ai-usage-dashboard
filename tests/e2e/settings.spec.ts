import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_ORIGIN, clearProviderKeys } from './credentials';

/**
 * The Settings dialog in a real browser, at desktop and Pixel 7 widths. Focus
 * trapping, scroll lock, and geometry are proven here; jsdom cannot.
 *
 * Fake keys only. Saving never starts a collection, so no request reaches a
 * provider.
 */
const DEEPSEEK_KEY = 'sk-e2e-0000000000001234';
const OPENROUTER_KEY = 'sk-or-e2e-000000000005678';
const CLAUDE_TOKEN = 'sk-ant-oat01-e2e-fake-0000000009012';

test.afterEach(async ({ request }) => {
  await clearProviderKeys(request);
});

async function openSettings(page: Page) {
  await page.getByTestId('open-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('settings-loading')).toHaveCount(0);
  return dialog;
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const focusInsideDialog = (page: Page) =>
  page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

test('Settings sits immediately right of Reload view and shares its styling', async ({ page }) => {
  await page.goto('/');
  const reload = page.getByTestId('reload-overview');
  const settings = page.getByTestId('open-settings');

  await expect(reload).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAccessibleName('Settings');
  await expect(settings).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  await expect(settings.locator('svg')).toBeVisible();
  expect(await settings.getAttribute('class')).toBe(await reload.getAttribute('class'));

  const r = await reload.boundingBox();
  const s = await settings.boundingBox();
  if (!r || !s) throw new Error('both buttons must have a box');
  const gap = s.x - (r.x + r.width);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(12);
  expect(Math.abs(s.y + s.height / 2 - (r.y + r.height / 2))).toBeLessThanOrEqual(1);
  expect(s.height).toBeCloseTo(r.height, 0);

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test('opens a modal dialog that takes focus, traps it, locks scroll, and fits the viewport', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = await openSettings(page);

  await expect(page.getByTestId('open-settings')).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByLabel('DeepSeek API Key')).toBeVisible();
  await expect(dialog.getByLabel('OpenRouter Management Key')).toBeVisible();
  await expect(dialog.getByLabel('Claude Token (optional)')).toBeAttached();
  await expect(page.getByTestId('settings-input-deepseek')).toBeFocused();
  for (const provider of ['deepseek', 'openrouter', 'claude']) {
    await expect(page.getByTestId(`settings-input-${provider}`)).toHaveAttribute(
      'type',
      'password',
    );
    await expect(page.getByTestId(`settings-input-${provider}`)).toHaveValue('');
  }

  // Tab and Shift+Tab cycle inside the dialog and never reach the page behind.
  // Floating UI's focus guards sit just outside the dialog, inside the overlay,
  // and hand focus back within a frame; nothing outside the overlay may ever
  // receive it.
  await page.evaluate(() => {
    const w = window as unknown as { escapedFocus: string[] };
    w.escapedFocus = [];
    document.addEventListener('focusin', (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-testid="settings-overlay"]')) {
        w.escapedFocus.push(target.outerHTML.slice(0, 80));
      }
    });
  });
  for (const key of [...Array<string>(10).fill('Tab'), ...Array<string>(10).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    await expect.poll(() => focusInsideDialog(page), key).toBe(true);
  }
  expect(
    await page.evaluate(() => (window as unknown as { escapedFocus: string[] }).escapedFocus),
  ).toEqual([]);

  // The page behind does not scroll.
  expect(
    await page.evaluate(() =>
      [document.documentElement, document.body].some(
        (el) => getComputedStyle(el).overflow === 'hidden',
      ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
  ).toBe(true);
  const box = await dialog.boundingBox();
  if (!box) throw new Error('dialog must have a box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Inside the viewport at every width, with no horizontal overflow.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport must be set');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  // The lock lifts once the dialog closes.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      [document.documentElement, document.body].every(
        (el) => getComputedStyle(el).overflow !== 'hidden',
      ),
    ),
  ).toBe(true);
});

test('Escape, an outside press, Close, and Cancel each close it and return focus to Settings', async ({
  page,
}) => {
  await page.goto('/');
  const settings = page.getByTestId('open-settings');
  const dialog = page.getByRole('dialog', { name: 'Settings' });

  const closers: [string, () => Promise<void>][] = [
    ['Escape', () => page.keyboard.press('Escape')],
    [
      'outside press',
      () => page.getByTestId('settings-overlay').click({ position: { x: 4, y: 4 } }),
    ],
    ['Close', () => dialog.getByRole('button', { name: 'Close' }).click()],
    ['Cancel', () => page.getByTestId('settings-close').click()],
  ];
  for (const [name, close] of closers) {
    await openSettings(page);
    await close();
    await expect(dialog, name).toHaveCount(0);
    await expect(settings, name).toBeFocused();
    await expect(settings, name).toHaveAttribute('aria-expanded', 'false');
  }
});

test('saves a key that persists across a reload and never returns to the browser in full', async ({
  page,
  request,
}) => {
  const console: string[] = [];
  page.on('console', (message) => console.push(message.text()));
  await page.goto('/');
  await openSettings(page);

  await expect(page.getByTestId('settings-status-deepseek')).toHaveText('Not set');
  await expect(page.getByTestId('settings-save')).toBeDisabled();
  await page.getByTestId('settings-input-deepseek').fill(DEEPSEEK_KEY);

  const putResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/credentials/deepseek') && r.request().method() === 'PUT',
  );
  await page.getByTestId('settings-save').click();
  const put = await putResponse;
  expect(put.status()).toBe(200);
  expect(await put.text()).not.toContain(DEEPSEEK_KEY.slice(0, -4));

  await expect(page.getByTestId('settings-success')).toHaveText('Saved.');
  await expect(page.getByTestId('settings-status-deepseek')).toContainText('Saved ••••1234');
  await expect(page.getByTestId('settings-input-deepseek')).toHaveValue('');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

  await page.reload();
  const getResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/credentials') && r.request().method() === 'GET',
  );
  await openSettings(page);
  const listed = await (await getResponse).text();
  expect(listed).toContain('"hint":"1234"');
  expect(listed).not.toContain(DEEPSEEK_KEY.slice(0, -4));

  await expect(page.getByTestId('settings-status-deepseek')).toContainText('Saved ••••1234');
  await expect(page.getByTestId('settings-input-deepseek')).toHaveValue('');

  // Nothing beyond the last four characters anywhere the browser keeps it.
  const leaked = (text: string) => text.includes(DEEPSEEK_KEY.slice(0, -4));
  expect(leaked(await page.content())).toBe(false);
  expect(leaked(page.url())).toBe(false);
  expect(
    leaked(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))),
  ).toBe(false);
  expect(leaked(console.join('\n'))).toBe(false);

  const api = await request.get('/api/settings/credentials', { headers: { origin: E2E_ORIGIN } });
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toBe('no-store');
  expect(leaked(await api.text())).toBe(false);
});

test('a failed save keeps its value and shows the server message while the other key saves', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page);

  // A short key saves but shows no hint; a key with a space is refused.
  await page.getByTestId('settings-input-deepseek').fill('sk-short-15char');
  await page.getByTestId('settings-input-openrouter').fill('sk-or bad key');
  await page.getByTestId('settings-save').click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'Enter the key exactly as issued: printable characters, no spaces.',
  );
  await expect(alert).toHaveAttribute('data-testid', 'settings-error');
  await expect(page.getByTestId('settings-input-deepseek')).toHaveValue('');
  await expect(page.getByTestId('settings-status-deepseek')).toHaveText(/^Saved · updated /);
  await expect(page.getByTestId('settings-input-openrouter')).toHaveValue('sk-or bad key');
  await expect(page.getByTestId('settings-status-openrouter')).toHaveText('Not set');
});

test('Remove deletes a saved key immediately', async ({ page, request }) => {
  const saved = await request.put('/api/settings/credentials/openrouter', {
    headers: { origin: E2E_ORIGIN },
    data: { secret: OPENROUTER_KEY },
  });
  expect(saved.status()).toBe(200);

  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(page.getByTestId('settings-status-openrouter')).toContainText('Saved ••••5678');

  await page.getByTestId('settings-remove-openrouter').click();
  await expect(page.getByTestId('settings-status-openrouter')).toHaveText('Not set');
  await expect(page.getByTestId('settings-remove-openrouter')).toHaveCount(0);
  await expect(dialog).toBeVisible();

  const listed = await request.get('/api/settings/credentials', {
    headers: { origin: E2E_ORIGIN },
  });
  expect(await listed.json()).toMatchObject({
    credentials: [
      { configured: false },
      { provider: 'openrouter', configured: false },
      { provider: 'claude', configured: false },
    ],
  });
});

test('the optional Claude token field says it is optional, saves, and is reachable at every width', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const dialog = await openSettings(page);
  const input = dialog.getByLabel('Claude Token (optional)');

  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('settings-status-claude')).toHaveText('Not set');
  await expect(input).toHaveAccessibleDescription(
    /^Optional\. Claude still reports quota through the status line without it\..*claude setup-token.*Each request counts toward your Claude usage\. Removing the token here does not revoke it\. Not set$/,
  );

  // The third field may push the footer below the fold on a phone; the panel
  // scrolls internally, and the field and Save stay inside the viewport.
  await input.scrollIntoViewIfNeeded();
  await input.fill(CLAUDE_TOKEN);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport must be set');
  for (const target of [input, page.getByTestId('settings-save')]) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error('target must have a box');
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
  const panel = await dialog.boundingBox();
  if (!panel) throw new Error('dialog must have a box');
  expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  const putResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/credentials/claude') && r.request().method() === 'PUT',
  );
  await page.getByTestId('settings-save').click();
  const put = await putResponse;
  expect(put.status()).toBe(200);
  expect(await put.text()).not.toContain(CLAUDE_TOKEN.slice(0, -4));
  await expect(page.getByTestId('settings-status-claude')).toContainText('Saved ••••9012');
  await expect(input).toHaveValue('');
  // Tab order still reaches the Claude field's Remove button inside the dialog.
  await page.getByTestId('settings-remove-claude').focus();
  await expect(page.getByTestId('settings-remove-claude')).toBeFocused();

  const listed = await request.get('/api/settings/credentials', {
    headers: { origin: E2E_ORIGIN },
  });
  const text = await listed.text();
  expect(text).toContain('"provider":"claude","configured":true,"hint":"9012"');
  expect(text).not.toContain(CLAUDE_TOKEN.slice(0, -4));

  await page.getByTestId('settings-remove-claude').click();
  await expect(page.getByTestId('settings-status-claude')).toHaveText('Not set');
});

test('the settings API refuses a cross-origin request', async ({ request }) => {
  const res = await request.get('/api/settings/credentials', {
    headers: { origin: 'https://evil.example.com' },
  });
  expect(res.status()).toBe(403);
});
