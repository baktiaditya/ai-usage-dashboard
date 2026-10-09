import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  RateLimiter,
  allowedOrigins,
  refreshLimiter,
  requireSameOrigin,
} from '@/lib/server/security';
import { testConfig } from '../helpers/db';

const config = testConfig();

function request(
  headers: Record<string, string>,
  url = 'http://127.0.0.1:3838/api/providers/codex/refresh',
) {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('same-origin enforcement', () => {
  it("accepts the dashboard's own origin", () => {
    for (const origin of allowedOrigins(config)) {
      expect(requireSameOrigin(request({ origin }), config).ok).toBe(true);
    }
  });

  it('rejects a cross-origin POST from any other page', () => {
    // This is the real threat: a page the user visits issuing a POST at the
    // loopback server. The browser attaches Origin and we refuse it.
    for (const origin of [
      'https://evil.example.com',
      'http://localhost:3000',
      'http://127.0.0.1:9999',
      'null',
    ]) {
      const result = requireSameOrigin(request({ origin }), config);
      expect(result.ok, origin).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    }
  });

  it('rejects a request with no Origin at all', () => {
    // curl and other non-browser callers land here, which is intended.
    const result = requireSameOrigin(request({}), config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('origin_required');
  });

  it('accepts a same-origin fetch that reports Sec-Fetch-Site instead', () => {
    expect(requireSameOrigin(request({ 'sec-fetch-site': 'same-origin' }), config).ok).toBe(true);
  });

  it('rejects a cross-site Sec-Fetch-Site', () => {
    expect(requireSameOrigin(request({ 'sec-fetch-site': 'cross-site' }), config).ok).toBe(false);
  });

  it('does not accept a forged Host header as proof of origin', () => {
    // Host is attacker-controlled; only Origin/Sec-Fetch-Site count.
    const result = requireSameOrigin(request({ host: '127.0.0.1:3838' }), config);
    expect(result.ok).toBe(false);
  });

  it('does not accept a forged X-Forwarded-For as proof of origin', () => {
    const result = requireSameOrigin(request({ 'x-forwarded-for': '127.0.0.1' }), config);
    expect(result.ok).toBe(false);
  });
});

describe('configured extra origins', () => {
  const EXTRA = 'https://dev-box.tail1234.ts.net';
  const withExtra = testConfig({ AUD_ALLOWED_ORIGINS: ` ${EXTRA} ` });

  it('appends the configured origin after the three loopback origins', () => {
    expect(allowedOrigins(withExtra)).toEqual([
      'http://127.0.0.1:3838',
      'http://localhost:3838',
      'http://[::1]:3838',
      EXTRA,
    ]);
  });

  it('accepts a request from the configured origin', () => {
    expect(requireSameOrigin(request({ origin: EXTRA }), withExtra).ok).toBe(true);
  });

  it('still refuses the http:// twin and a different ts.net host', () => {
    for (const origin of ['http://dev-box.tail1234.ts.net', 'https://other.tail1234.ts.net']) {
      const result = requireSameOrigin(request({ origin }), withExtra);
      expect(result.ok, origin).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    }
  });
});

describe('rate limiting', () => {
  beforeEach(() => {
    refreshLimiter.reset();
  });

  it('allows a burst up to the limit then throttles', () => {
    const limiter = new RateLimiter(3, 60_000);
    const now = Date.now();
    expect(limiter.check('codex', now)).toBeNull();
    expect(limiter.check('codex', now)).toBeNull();
    expect(limiter.check('codex', now)).toBeNull();
    const retry = limiter.check('codex', now);
    expect(retry).toBeGreaterThan(0);
  });

  it('scopes the limit per provider so one card cannot starve another', () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = Date.now();
    expect(limiter.check('codex', now)).toBeNull();
    expect(limiter.check('codex', now)).not.toBeNull();
    // A different provider is unaffected.
    expect(limiter.check('deepseek', now)).toBeNull();
  });

  it('recovers once the window has passed', () => {
    const limiter = new RateLimiter(1, 1000);
    const now = Date.now();
    expect(limiter.check('codex', now)).toBeNull();
    expect(limiter.check('codex', now + 500)).not.toBeNull();
    expect(limiter.check('codex', now + 1500)).toBeNull();
  });

  it('ships a conservative default for manual refresh', () => {
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) expect(refreshLimiter.check('codex', now)).toBeNull();
    expect(refreshLimiter.check('codex', now)).not.toBeNull();
  });
});
