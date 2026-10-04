import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PROBE_ANTHROPIC_VERSION,
  CLAUDE_PROBE_BODY,
  CLAUDE_PROBE_OAUTH_BETA,
  CLAUDE_PROBE_URL,
  CLAUDE_PROBE_WINDOWS,
  createClaudeAdapter,
  normalizeClaudeRateLimitHeaders,
} from '@/lib/adapters/claude-usage';
import { CLAUDE_PROBE_SOURCE_VERSION } from '@/lib/domain';
import type { QuotaSnapshot } from '@/lib/domain';
import { CollectionDeferred, CollectionError } from '@/lib/errors';
import { createClaudeIngestor } from '@/lib/ingestors/claude-statusline';
import { labelWindow } from '@/lib/queries/overview';
import { fixtureJson, fixtureText } from '../helpers/fixtures';

const OBSERVED_AT = '2026-09-17T01:00:00.000Z';
// Shaped like a setup token, but not one.
const TOKEN = 'sk-ant-oat01-fake-unit-token-0000';
const U = 'anthropic-ratelimit-unified-';
const FIXTURES = [
  'valid',
  'limit-reached',
  'no-unified-headers',
  'drift-no-known-window',
  'drift-utilization-percent',
  'drift-missing-reset',
  'drift-reset-iso',
];
// Older than the probe budget below, so it never answers a run by itself.
const STALE_SPOOL = '2026-09-16T00:00:00.000Z';
const FRESH_MS = 15 * 60_000;

interface ProbeFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
}

function fixture(name: string): ProbeFixture {
  return fixtureJson('claude-probe', name) as ProbeFixture;
}

function normalize(name: string, override: Record<string, string | null> = {}): QuotaSnapshot {
  const headers = new Headers(fixture(name).headers);
  for (const [key, value] of Object.entries(override)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return normalizeClaudeRateLimitHeaders(headers, OBSERVED_AT);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof CollectionError ? err.code : 'not a CollectionError';
  }
  return undefined;
}

describe('rate-limit header mapping', () => {
  it('maps the five-hour and seven-day headers onto the status line windows', () => {
    const snap = normalize('valid');

    expect(snap).toMatchObject({
      kind: 'quota',
      provider: 'claude',
      observedAt: OBSERVED_AT,
      sourceVersion: CLAUDE_PROBE_SOURCE_VERSION,
      // Probed observations are never deduplicated.
      sourceEventId: null,
      usageAllowed: null,
      limitReachedCode: null,
    });
    expect(snap.windows).toEqual([
      {
        bucketId: 'five_hour',
        windowKind: 'five_hour',
        usedPercent: 12.5,
        windowDurationMinutes: 300,
        resetsAt: '2099-09-13T16:26:40.000Z',
      },
      {
        bucketId: 'seven_day',
        windowKind: 'seven_day',
        usedPercent: 48,
        windowDurationMinutes: 10_080,
        resetsAt: '2099-09-18T07:33:20.000Z',
      },
    ]);
  });

  it('labels every window it produces, so no raw kind is rendered', () => {
    for (const [, kind] of CLAUDE_PROBE_WINDOWS) {
      expect(
        labelWindow({
          bucketId: kind,
          windowKind: kind,
          usedPercent: 0,
          windowDurationMinutes: null,
          resetsAt: null,
        }),
      ).not.toBe(kind);
    }
  });

  it.each([
    ['0', 0],
    ['0.07', 7],
    ['0.123456', 12.3456],
    ['1', 100],
    ['1.0', 100],
  ])('shifts the fraction %s to exactly %s percent', (value, percent) => {
    const snap = normalize('valid', { [`${U}5h-utilization`]: value });
    expect(snap.windows[0]?.usedPercent).toBe(percent);
  });

  it('keeps a plan that reports only one window', () => {
    const snap = normalize('valid', { [`${U}7d-utilization`]: null, [`${U}7d-reset`]: null });
    expect(snap.windows.map((w) => w.windowKind)).toEqual(['five_hour']);
  });

  it('reads a subscription at its limit as a reading of 100 percent', () => {
    expect(normalize('limit-reached').windows[0]?.usedPercent).toBe(100);
  });

  it('carries nothing from the headers beyond the validated gauges', () => {
    // `collectedAt` is the wall clock, which may contain any digits.
    const serialized = JSON.stringify({ ...normalize('valid'), collectedAt: null });
    for (const unread of ['77', 'req_elided', 'org_level_disabled', 'rejected', 'allowed']) {
      expect(serialized).not.toContain(unread);
    }
  });

  it('reports a response with no subscription rate-limit headers as not_entitled', () => {
    expect(codeOf(() => normalize('no-unified-headers'))).toBe('not_entitled');
  });

  it.each([
    'drift-no-known-window',
    'drift-utilization-percent',
    'drift-missing-reset',
    'drift-reset-iso',
  ])('refuses %s as schema_mismatch, never producing a number', (name) => {
    expect(codeOf(() => normalize(name))).toBe('schema_mismatch');
  });

  it.each([
    ['a negative utilization', { [`${U}5h-utilization`]: '-0.1' }],
    ['a utilization above 1', { [`${U}5h-utilization`]: '1.01' }],
    ['a non-numeric utilization', { [`${U}5h-utilization`]: 'high' }],
    ['a utilization without its reset', { [`${U}5h-reset`]: null }],
    ['a reset without its utilization', { [`${U}5h-utilization`]: null }],
    ['a reset in milliseconds', { [`${U}5h-reset`]: '4093000000000' }],
    ['a reset past 2100', { [`${U}5h-reset`]: '99999999999' }],
  ])('refuses %s as schema_mismatch', (_name, override) => {
    expect(codeOf(() => normalize('valid', override))).toBe('schema_mismatch');
  });

  it('never names a header value in a drift message', () => {
    try {
      normalize('valid', { [`${U}5h-utilization`]: '123.456' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/123/);
    }
  });
});

describe('sanitised fixtures', () => {
  it('are marked sanitised and carry no token, email, or account identifier', () => {
    for (const name of FIXTURES) {
      const text = fixtureText('claude-probe', name);
      expect(JSON.parse(text)).toHaveProperty('_fixture.sanitized');
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text).not.toMatch(/sk-ant-|Bearer|org[_-]?id|account[_-]?id|uuid/i);
    }
  });
});

describe('composite Claude adapter', () => {
  let dir: string;
  let spoolPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aud-claude-probe-'));
    spoolPath = join(dir, 'claude-statusline.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpool(observedAt: string): void {
    const event = JSON.parse(fixtureText('claude', 'valid-spool')) as Record<string, unknown>;
    writeFileSync(spoolPath, JSON.stringify({ ...event, observedAt }));
  }

  function fetchReturning(name = 'valid', status?: number) {
    const { status: fixtureStatus, headers } = fixture(name);
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      // The body is never read; a sentinel proves it.
      return new Response('{"content":"elided-body-sentinel"}', {
        status: status ?? fixtureStatus,
        headers,
      });
    });
  }

  function adapter(options: {
    token?: string | null;
    fetchImpl?: ReturnType<typeof fetchReturning>;
    claim?: () => boolean;
  }) {
    return createClaudeAdapter({
      spoolPath,
      usageToken: options.token === undefined ? TOKEN : options.token,
      claimPoll: options.claim ?? (() => true),
      spoolFreshMs: FRESH_MS,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl as unknown as typeof fetch } : {}),
    });
  }

  const signal = () => new AbortController().signal;

  it('is exactly the spool ingestor when no token is saved, and never claims or fetches', async () => {
    const fetchImpl = fetchReturning();
    const claim = vi.fn(() => true);
    const composite = adapter({ token: null, fetchImpl, claim });
    const ingestor = createClaudeIngestor({ spoolPath });

    expect({ ...composite, collect: undefined }).toEqual({ ...ingestor, collect: undefined });
    writeSpool(STALE_SPOOL);
    const [a, b] = [await composite.collect(signal()), await ingestor.collect(signal())];
    expect({ ...a, collectedAt: null }).toEqual({ ...b, collectedAt: null });

    rmSync(spoolPath);
    await expect(composite.collect(signal())).rejects.toMatchObject({ code: 'no_event_yet' });
    expect(claim).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one minimal Haiku POST, the token only as a bearer header, with no Claude Code identity', async () => {
    const fetchImpl = fetchReturning();
    await adapter({ fetchImpl }).collect(signal());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(CLAUDE_PROBE_URL);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'User-Agent': 'ai-usage-dashboard/0.2.0',
      'Content-Type': 'application/json',
      'anthropic-version': CLAUDE_PROBE_ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_PROBE_OAUTH_BETA,
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual(CLAUDE_PROBE_BODY);
    expect(body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });
    expect(String(init?.body)).not.toMatch(/system|Claude Code/);
  });

  it('never probes while the status line has a fresh reading', async () => {
    writeSpool(new Date(Date.now() - 60_000).toISOString());
    const fetchImpl = fetchReturning();
    const claim = vi.fn(() => true);
    const snap = await adapter({ fetchImpl, claim }).collect(signal());

    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
    expect(claim).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('probes once the status line reading is older than the probe budget', async () => {
    writeSpool(new Date(Date.now() - FRESH_MS - 60_000).toISOString());
    const fetchImpl = fetchReturning();
    const snap = await adapter({ fetchImpl }).collect(signal());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snap.sourceVersion).toBe(CLAUDE_PROBE_SOURCE_VERSION);
  });

  it('claims before it requests, and skips the probe when the claim is lost', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      return new Response(null, { status: 200, headers: fixture('valid').headers });
    });
    await adapter({
      fetchImpl: fetchImpl as never,
      claim: () => {
        order.push('claim');
        return true;
      },
    }).collect(signal());
    expect(order).toEqual(['claim', 'fetch']);

    writeSpool(STALE_SPOOL);
    const lost = vi.fn();
    const snap = await adapter({ fetchImpl: lost as never, claim: () => false }).collect(signal());
    expect(lost).not.toHaveBeenCalled();
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
  });

  it('treats a claim that throws as lost, rather than probing unclaimed', async () => {
    writeSpool(STALE_SPOOL);
    const fetchImpl = fetchReturning();
    const snap = await adapter({
      fetchImpl,
      claim: () => {
        throw new Error('database is locked');
      },
    }).collect(signal());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
  });

  it('prefers the newer observation when both sources answer', async () => {
    // A stale spool event loses to a probe made now.
    writeSpool(STALE_SPOOL);
    const probed = await adapter({ fetchImpl: fetchReturning() }).collect(signal());
    expect(probed.sourceVersion).toBe(CLAUDE_PROBE_SOURCE_VERSION);
    expect(probed.sourceEventId).toBeNull();
  });

  it('records a 429 that still reports its windows as a reading', async () => {
    const snap = await adapter({ fetchImpl: fetchReturning('limit-reached') }).collect(signal());
    expect(snap.windows[0]?.usedPercent).toBe(100);
  });

  it.each([
    ['a 429 with no windows', 'no-unified-headers', 429, 'rate_limited'],
    ['a 401', 'no-unified-headers', 401, 'auth_rejected'],
    ['a 403', 'no-unified-headers', 403, 'insufficient_scope'],
    ['a 5xx', 'no-unified-headers', 503, 'upstream_error'],
  ])('falls back to the spool on %s without retrying', async (_name, name, status, code) => {
    const fetchImpl = fetchReturning(name, status);

    writeSpool(STALE_SPOOL);
    const snap = await adapter({ fetchImpl }).collect(signal());
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    rmSync(spoolPath);
    await expect(adapter({ fetchImpl }).collect(signal())).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never reads or echoes the response body, even on a refusal', async () => {
    const fetchImpl = fetchReturning('no-unified-headers', 400);
    try {
      await adapter({ fetchImpl }).collect(signal());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('elided-body-sentinel');
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('falls back to the spool on a network error or timeout', async () => {
    writeSpool(STALE_SPOOL);
    const network = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await adapter({ fetchImpl: network as never }).collect(signal())).sourceVersion).toBe(
      'claude-code/2.1.269',
    );

    rmSync(spoolPath);
    await expect(adapter({ fetchImpl: network as never }).collect(signal())).rejects.toMatchObject({
      code: 'network_error',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      adapter({ fetchImpl: fetchReturning() }).collect(aborted.signal),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('falls back to the spool on drift, and otherwise surfaces schema_mismatch', async () => {
    const drift = fetchReturning('drift-utilization-percent');

    writeSpool(STALE_SPOOL);
    const snap = await adapter({ fetchImpl: drift }).collect(signal());
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');

    rmSync(spoolPath);
    await expect(adapter({ fetchImpl: drift }).collect(signal())).rejects.toMatchObject({
      code: 'schema_mismatch',
    });

    // A spool that is present but unusable is not a fallback either.
    writeFileSync(spoolPath, '{ not json');
    await expect(adapter({ fetchImpl: drift }).collect(signal())).rejects.toMatchObject({
      code: 'schema_mismatch',
      message: expect.not.stringContaining('spool'),
    });
  });

  it('defers, rather than recording a verdict, when it lost the claim and the spool is unusable', async () => {
    const fetchImpl = fetchReturning();
    const lost = adapter({ fetchImpl, claim: () => false });

    // No spool file at all.
    await expect(lost.collect(signal())).rejects.toBeInstanceOf(CollectionDeferred);
    // A spool that is present but unusable is no different.
    writeFileSync(spoolPath, '{ not json');
    await expect(lost.collect(signal())).rejects.toBeInstanceOf(CollectionDeferred);
    // A claim that could not be written is lost too.
    const broken = adapter({
      fetchImpl,
      claim: () => {
        throw new Error('database is locked');
      },
    });
    await expect(broken.collect(signal())).rejects.toBeInstanceOf(CollectionDeferred);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never defers a run that did probe: its own failure is the answer', async () => {
    const refused = adapter({
      fetchImpl: fetchReturning('no-unified-headers', 429),
      claim: () => true,
    });
    await expect(refused.collect(signal())).rejects.toBeInstanceOf(CollectionError);
  });

  it('leaves room in its budget for a spool read and a slow probe', () => {
    const composite = adapter({});
    expect(composite.timeoutMs).toBeGreaterThan(
      15_000 + createClaudeIngestor({ spoolPath }).timeoutMs,
    );
  });
});
