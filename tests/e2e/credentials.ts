import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/** The e2e server's own origin (playwright.config.ts); the settings routes refuse any other. */
export const E2E_ORIGIN = 'http://127.0.0.1:3939';

/**
 * Remove every saved provider key, the Claude token included, so no spec
 * inherits one from another — the mobile project runs refresh.spec.ts after the
 * desktop project's settings spec.
 */
export async function clearProviderKeys(request: APIRequestContext): Promise<void> {
  for (const provider of ['deepseek', 'openrouter', 'claude']) {
    const res = await request.delete(`/api/settings/credentials/${provider}`, {
      headers: { origin: E2E_ORIGIN },
    });
    expect(res.status()).toBe(200);
  }
}
