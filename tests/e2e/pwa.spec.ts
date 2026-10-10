import { expect, test, type Page } from '@playwright/test';

/**
 * Installability smoke coverage: the manifest Chrome reads and the raster icons
 * it decodes. Chromium needs HTTPS or loopback plus a manifest carrying a name,
 * 192 px and 512 px icons, a start_url, and a standalone display; a service
 * worker is not part of the contract.
 */

type Manifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: { src?: string; sizes?: string; type?: string }[];
};

async function fetchManifest(page: Page): Promise<Manifest> {
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveCount(1);

  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();
  const response = await page.request.get(new URL(href ?? '', page.url()).toString());
  expect(response.status()).toBe(200);

  return (await response.json()) as Manifest;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('links a manifest that meets the installability requirements', async ({ page }) => {
  const manifest = await fetchManifest(page);

  expect(manifest.name).toBe('AI Usage Dashboard');
  expect(manifest.short_name).toBe('AI Usage');
  expect(manifest.start_url).toBe('/');
  expect(manifest.display).toBe('standalone');

  const icons = manifest.icons ?? [];
  expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of icons) {
    expect(icon.type, icon.src).toBe('image/png');
  }
});

test('serves each manifest icon as a PNG that decodes at its declared size', async ({ page }) => {
  const icons = (await fetchManifest(page)).icons ?? [];
  expect(icons.length).toBeGreaterThan(0);

  for (const { src, sizes } of icons) {
    expect(src, 'icon src').toBeTruthy();
    const size = Number((sizes ?? '').split('x')[0]);
    expect(size, sizes).toBeGreaterThan(0);

    const url = new URL(src ?? '', page.url()).toString();
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
    expect(response.headers()['content-type'], url).toContain('image/png');

    const decoded = await page.evaluate(async (href) => {
      const blob = await (await fetch(href)).blob();
      const bitmap = await createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height };
    }, url);
    expect(decoded, url).toEqual({ width: size, height: size });
  }
});
