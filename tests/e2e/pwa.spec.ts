import { expect, test } from '@playwright/test';

/**
 * Installability smoke coverage: the manifest Chrome reads and the raster icons
 * it decodes. Chromium needs HTTPS or loopback plus a manifest carrying a name,
 * 192 px and 512 px icons, a start_url, and a standalone display; a service
 * worker is not part of the contract.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('links a manifest that meets the installability requirements', async ({ page }) => {
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveCount(1);

  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();
  const response = await page.request.get(new URL(href ?? '', page.url()).toString());
  expect(response.status()).toBe(200);

  const manifest = (await response.json()) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    display?: string;
    icons?: { src?: string; sizes?: string; type?: string }[];
  };

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

test('serves both icons as PNGs that decode at their declared size', async ({ page }) => {
  const icons = [
    { src: '/icon-192.png', size: 192 },
    { src: '/icon-512.png', size: 512 },
  ];

  for (const { src, size } of icons) {
    const response = await page.request.get(new URL(src, page.url()).toString());
    expect(response.status(), src).toBe(200);
    expect(response.headers()['content-type'], src).toContain('image/png');

    const decoded = await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height };
    }, src);
    expect(decoded, src).toEqual({ width: size, height: size });
  }
});
