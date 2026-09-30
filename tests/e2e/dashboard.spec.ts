import { expect, test } from '@playwright/test';

/**
 * Browser smoke coverage against a real production build over a seeded
 * database. The seed puts one provider in each card state deliberately, so
 * these tests assert the states a user would actually meet.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI Usage Dashboard' })).toBeVisible();
});

const DISPLAY_ORDER = ['codex', 'claude', 'opencode_go', 'deepseek', 'openrouter'];

test('shows all five providers on one screen, quota before balance', async ({ page }) => {
  for (const provider of DISPLAY_ORDER) {
    await expect(page.getByTestId(`card-${provider}`)).toBeVisible();
  }
  const cards = page.locator('[data-testid^="card-"]');
  expect(await cards.evaluateAll((els) => els.map((el) => el.dataset['testid']))).toEqual(
    DISPLAY_ORDER.map((provider) => `card-${provider}`),
  );
  const picker = page.locator('[data-testid^="history-provider-"]');
  expect(await picker.evaluateAll((els) => els.map((el) => el.dataset['testid']))).toEqual(
    DISPLAY_ORDER.map((provider) => `history-provider-${provider}`),
  );
});

test('renders every card state', async ({ page }) => {
  // Seeded deliberately: healthy / unavailable / stale / error.
  await expect(page.getByTestId('status-codex')).toHaveText(/Healthy/);
  await expect(page.getByTestId('status-opencode_go')).toHaveText(/Healthy/);
  await expect(page.getByTestId('status-claude')).toHaveText(/Unavailable/);
  await expect(page.getByTestId('status-deepseek')).toHaveText(/Stale/);
  await expect(page.getByTestId('status-openrouter')).toHaveText(/Error/);

  await expect(page.getByTestId('summary-counts')).toContainText('2 healthy');
});

test('renders both Codex quota windows with reset times', async ({ page }) => {
  const primary = page.getByTestId('window-codex-primary');
  const secondary = page.getByTestId('window-codex-secondary');

  await expect(primary).toContainText('5 hour');
  await expect(primary).toContainText('63.0%');
  await expect(primary).toContainText('used 37.0%');
  await expect(primary).toContainText('resets');

  await expect(secondary).toContainText('7 day');
  await expect(secondary).toContainText('48.0%');
});

test('renders the three OpenCode Go windows, and watches the one running low', async ({ page }) => {
  await expect(page.getByTestId('window-opencode_go-rolling')).toContainText('5 hour');
  await expect(page.getByTestId('window-opencode_go-rolling')).toContainText('used 18.0%');
  const weekly = page.getByTestId('window-opencode_go-weekly');
  await expect(weekly).toContainText('7 day');
  await expect(weekly).toContainText('16.0%');
  await expect(weekly).toContainText('resets');
  await expect(page.getByTestId('window-opencode_go-monthly')).toContainText('Monthly');
  await expect(page.getByTestId('window-opencode_go-monthly')).toContainText('39.0%');
  await expect(page.getByTestId('advisory-opencode_go')).toHaveText(/Watch/);
  // Percentages only: the source reports no dollars, and none are derived.
  await expect(page.getByTestId('card-opencode_go')).not.toContainText('$');
});

test('renders every DeepSeek currency separately', async ({ page }) => {
  await expect(page.getByTestId('balance-deepseek-CNY')).toContainText('30.00');
  await expect(page.getByTestId('balance-deepseek-USD')).toContainText('15.42');
});

test('renders OpenRouter credits, usage and remaining', async ({ page }) => {
  const usd = page.getByTestId('balance-openrouter-USD');
  await expect(usd).toContainText('100.50');
  await expect(usd).toContainText('25.75');
  await expect(usd).toContainText('74.75');
});

test('labels stale and errored values as last known, not current', async ({ page }) => {
  await expect(page.getByTestId('last-known-deepseek')).toContainText('not current');
  await expect(page.getByTestId('last-known-openrouter')).toContainText('not current');
  // A healthy card carries no such warning.
  await expect(page.getByTestId('last-known-codex')).toHaveCount(0);
});

test('never recommends switching from stale or failed data', async ({ page }) => {
  await expect(page.getByTestId('advisory-deepseek')).toHaveText(/Unknown/);
  await expect(page.getByTestId('advisory-openrouter')).toHaveText(/Unknown/);
  await expect(page.getByTestId('advisory-claude')).toHaveText(/Unknown/);
  // The one healthy provider does get a real verdict.
  await expect(page.getByTestId('advisory-codex')).toHaveText(/OK|Watch|Switch suggested/);
});

test('shows provenance for each provider', async ({ page }) => {
  const card = page.getByTestId('card-codex');
  await expect(card.getByText('Source observed')).toBeVisible();
  await expect(card.getByText('Last collection')).toBeVisible();
  await expect(page.getByTestId('age-codex')).not.toBeEmpty();
});

test('exposes safe diagnostics on demand', async ({ page }) => {
  await page
    .getByTestId('card-openrouter')
    .getByRole('button', { name: /Diagnostics/ })
    .click();
  const diagnostics = page.getByTestId('diagnostics-openrouter');
  await expect(diagnostics).toBeVisible();
  await expect(diagnostics).toContainText('upstream_error');
  // Nothing secret-shaped is on the page.
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toContain('bearer ');
  expect(body).not.toMatch(/sk-[a-z0-9]{8,}/);
  expect(body).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
});

test('shows an empty state with a setup hint for a provider that never reported', async ({
  page,
}) => {
  const claude = page.getByTestId('card-claude');
  await expect(claude).toContainText('Nothing collected yet');
  await expect(claude).toContainText(/no event|not been received/i);
});

test('history renders a quota chart for a quota provider', async ({ page }) => {
  await page.getByTestId('history-provider-codex').click();
  await page.getByTestId('range-7d').click();
  await expect(page.getByTestId('history-quota-chart')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('history-quota-chart')).toContainText('never summed');
  // The daily min/max the API computes is drawn, not discarded.
  await expect(page.getByTestId('history-quota-chart')).toContainText('lowest to highest');
  // The legend names windows by label, never by raw bucket and window identifiers.
  const legend = page.getByTestId('history-quota-chart').locator('ul').last();
  await expect(legend).toContainText('5 hour');
  await expect(legend).toContainText('7 day');
  await expect(legend).not.toContainText('codex · primary');
});

test('history charts every OpenCode Go window by its label', async ({ page }) => {
  await page.getByTestId('history-provider-opencode_go').click();
  await expect(page.getByTestId('history-quota-chart')).toBeVisible({ timeout: 10_000 });
  const legend = page.getByTestId('history-quota-chart').locator('ul').last();
  await expect(legend).toContainText('5 hour');
  await expect(legend).toContainText('7 day');
  await expect(legend).toContainText('Monthly');
  await expect(legend).not.toContainText('go · ');
});

test('history states insufficient data rather than drawing a zero line', async ({ page }) => {
  await page.getByTestId('history-provider-claude').click();
  await page.getByTestId('range-30d').click();
  await expect(page.getByTestId('history-insufficient')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('history-insufficient')).toContainText('Insufficient history');
});

test('history labels DeepSeek movement as balance change, not usage', async ({ page }) => {
  await page.getByTestId('history-provider-deepseek').click();
  await page.getByTestId('range-7d').click();
  const summary = page.getByTestId('history-credit-summary');
  await expect(summary).toBeVisible({ timeout: 10_000 });
  await expect(summary).toContainText('Balance change');
  await expect(summary).toContainText('not a usage figure');
  // The observations behind the delta are charted, one currency per chart.
  await expect(page.getByTestId('history-credit-trend-CNY')).toBeVisible();
  await expect(page.getByTestId('history-credit-trend-USD')).toBeVisible();
});

test('switching history keeps the panel in place while the next selection loads', async ({
  page,
}) => {
  // Before the fix the panel collapsed to a one-line placeholder between tabs,
  // shortening the page for a moment and moving the reader's scroll position.
  // The next response is held so that in-between state is observable, and the
  // shortest the page gets is recorded on every frame.
  await expect(page.getByTestId('history-quota-chart')).toBeVisible({ timeout: 10_000 });
  await page.route('**/api/history?provider=claude*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const before = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate(() => {
    const w = window as unknown as { shortest: number };
    w.shortest = document.documentElement.scrollHeight;
    const sample = () => {
      w.shortest = Math.min(w.shortest, document.documentElement.scrollHeight);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.getByTestId('history-provider-claude').click();
  await expect(page.getByTestId('history-content')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('history-insufficient')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('history-content')).toHaveAttribute('aria-busy', 'false');

  const after = await page.evaluate(() => document.documentElement.scrollHeight);
  const shortest = await page.evaluate(() => (window as unknown as { shortest: number }).shortest);
  expect(shortest).toBeGreaterThanOrEqual(Math.min(before, after));
});

test('every card heading carries its provider mark, hidden from assistive technology', async ({
  page,
}) => {
  for (const provider of ['codex', 'claude', 'deepseek', 'openrouter', 'opencode_go']) {
    const logo = page.getByTestId(`card-${provider}`).locator('h2').getByTestId(`logo-${provider}`);
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('aria-hidden', 'true');
  }
  // The mark adds nothing to the heading's accessible name.
  await expect(
    page.getByTestId('card-claude').getByRole('heading', { name: 'Claude Code', exact: true }),
  ).toBeVisible();
});

test('the OpenRouter mark turns lime only on a dark surface', async ({ page }) => {
  // Its lime has no contrast on a light card, where it takes the heading color.
  const path = page.getByTestId('logo-openrouter').locator('path');
  const fillAndHeadingColor = () =>
    path.evaluate((el) => {
      const heading = el.closest('h2');
      return [getComputedStyle(el).fill, heading ? getComputedStyle(heading).color : ''];
    });

  await page.emulateMedia({ colorScheme: 'light' });
  const [lightFill, headingColor] = await fillAndHeadingColor();
  expect(lightFill).toBe(headingColor);

  await page.emulateMedia({ colorScheme: 'dark' });
  const [darkFill] = await fillAndHeadingColor();
  expect(darkFill).toBe('rgb(200, 255, 0)');
});

test('serves an SVG favicon', async ({ page, request }) => {
  const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href ?? '');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/svg+xml');
});

test('the refresh endpoint rejects a cross-origin POST', async ({ request }) => {
  const res = await request.post('/api/providers/codex/refresh', {
    headers: { origin: 'https://evil.example.com' },
  });
  expect(res.status()).toBe(403);
});

test('the refresh endpoint rejects GET', async ({ request }) => {
  const res = await request.get('/api/providers/codex/refresh');
  expect(res.status()).toBe(405);
});

test('the overview API returns all five providers and leaks nothing', async ({ request }) => {
  const res = await request.get('/api/overview');
  expect(res.ok()).toBe(true);
  const body = await res.text();
  expect(JSON.parse(body).cards).toHaveLength(5);
  expect(body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(body).not.toContain('accountId');
});

test('layout does not scroll horizontally', async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
