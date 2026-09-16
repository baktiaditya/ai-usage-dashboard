import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_USAGE_OAUTH_BETA,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_USER_AGENT,
  CLAUDE_USAGE_WINDOW_KINDS,
  claudeUsageBucketId,
  createClaudeAdapter,
  normalizeClaudeUsageResponse,
} from '@/lib/adapters/claude-usage';
import { CLAUDE_USAGE_SOURCE_VERSION } from '@/lib/domain';
import type { QuotaSnapshot } from '@/lib/domain';
import { CollectionDeferred, CollectionError } from '@/lib/errors';
import { createClaudeIngestor } from '@/lib/ingestors/claude-statusline';
import { labelWindow } from '@/lib/queries/overview';
import { fixtureLossless, fixtureText } from '../helpers/fixtures';

const OBSERVED_AT = '2026-09-17T01:00:00.000Z';
// Shaped like a setup token, but not one.
const TOKEN = 'sk-ant-oat01-fake-unit-token-0000';

function normalize(name: string): QuotaSnapshot {
  return normalizeClaudeUsageResponse(fixtureLossless('claude-usage', name), OBSERVED_AT);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof CollectionError ? err.code : 'not a CollectionError';
  }
  return undefined;
}

describe('limits[] mapping', () => {
  it('maps each active limit field by field, and reads nothing else', () => {
    const snap = normalize('valid');

    expect(snap).toMatchObject({
      kind: 'quota',
      provider: 'claude',
      observedAt: OBSERVED_AT,
      sourceVersion: CLAUDE_USAGE_SOURCE_VERSION,
      // Polled observations are never deduplicated.
      sourceEventId: null,
      usageAllowed: null,
      limitReachedCode: null,
    });
    // The window keys say 77; limits[] is the contract, so they are ignored.
    expect(snap.windows).toEqual([
      {
        bucketId: 'session:session',
        windowKind: 'session',
        usedPercent: 12.5,
        windowDurationMinutes: null,
        resetsAt: '2099-09-17T09:00:00.123456+00:00',
      },
      {
        bucketId: 'weekly_all:weekly',
        windowKind: 'weekly_all',
        usedPercent: 48,
        windowDurationMinutes: null,
        resetsAt: '2099-09-21T03:00:00+07:00',
      },
    ]);
  });

  it('keeps resets_at to the second, never through an epoch conversion', () => {
    for (const w of normalize('valid').windows) {
      expect(w.resetsAt).not.toBeNull();
      expect(new Date(w.resetsAt as string).getUTCFullYear()).toBe(2099);
    }
    const [session, weekly] = normalize('valid').windows;
    expect(Date.parse(session!.resetsAt!)).toBe(Date.parse('2099-09-17T09:00:00.123Z'));
    expect(new Date(weekly!.resetsAt!).toISOString()).toBe('2099-09-20T20:00:00.000Z');
  });

  it('derives the bucket id from identity fields only, omitting nulls', () => {
    expect(claudeUsageBucketId('session', null, null)).toBe('session');
    expect(claudeUsageBucketId('session', 'session', null)).toBe('session:session');
    expect(claudeUsageBucketId('weekly_all', null, 'org')).toBe('weekly_all:org');
    expect(claudeUsageBucketId('weekly_all', 'weekly', 'org')).toBe('weekly_all:weekly:org');
  });

  it('carries nothing from the payload beyond the validated gauges', () => {
    const serialized = JSON.stringify(normalize('valid'));
    for (const unmodelled of ['unmodelled_example_key', 'extra_usage', 'severity', 'USD', '77']) {
      expect(serialized).not.toContain(unmodelled);
    }
  });

  it.each(['no-limits', 'empty-limits', 'all-inactive'])('reports %s as not_entitled', (name) => {
    expect(codeOf(() => normalize(name))).toBe('not_entitled');
  });

  it.each(['drift-percent-string', 'drift-limits-object', 'drift-unknown-kind'])(
    'refuses %s as schema_mismatch, never producing a number',
    (name) => {
      expect(codeOf(() => normalize(name))).toBe('schema_mismatch');
    },
  );

  it('raises schema_mismatch when two limits would share a bucket id', () => {
    expect(codeOf(() => normalize('drift-duplicate-identity'))).toBe('schema_mismatch');
  });

  it.each([
    ['a non-object payload', []],
    ['a percent above 100', { limits: [{ ...active(), percent: 100.5 }] }],
    ['a negative percent', { limits: [{ ...active(), percent: -1 }] }],
    ['an impossible reset date', { limits: [{ ...active(), resets_at: '2026-02-31T00:00:00Z' }] }],
    ['epoch seconds as the reset time', { limits: [{ ...active(), resets_at: 1789606800 }] }],
    ['a missing group', { limits: [omit(active(), 'group')] }],
    ['a non-string severity', { limits: [{ ...active(), severity: 3 }] }],
    ['a non-boolean is_active', { limits: [{ ...active(), is_active: 'yes' }] }],
  ])('refuses %s as schema_mismatch', (_name, payload) => {
    expect(codeOf(() => normalizeClaudeUsageResponse(payload, OBSERVED_AT))).toBe(
      'schema_mismatch',
    );
  });

  it('never names a value or an unrecognised kind in a drift message', () => {
    const cases = [
      { limits: [{ ...active(), percent: 123.456 }] },
      fixtureLossless('claude-usage', 'drift-unknown-kind'),
    ];
    for (const payload of cases) {
      try {
        normalizeClaudeUsageResponse(payload, OBSERVED_AT);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error).message).not.toMatch(/123|renamed_window/);
      }
    }
  });

  it('refuses a kind it cannot label but keeps the labelled ones beside it', () => {
    const snap = normalizeClaudeUsageResponse(
      { limits: [active(), { ...active(), kind: 'renamed_window', group: null }] },
      OBSERVED_AT,
    );
    expect(snap.windows.map((w) => w.windowKind)).toEqual(['session']);
  });

  it('has a WINDOW_LABELS entry for every kind it accepts, so no raw kind is rendered', () => {
    for (const kind of CLAUDE_USAGE_WINDOW_KINDS) {
      const label = labelWindow({
        bucketId: kind,
        windowKind: kind,
        usedPercent: 0,
        windowDurationMinutes: null,
        resetsAt: null,
      });
      expect(label).not.toBe(kind);
    }
  });
});

describe('sanitised fixtures', () => {
  it('are marked sanitised and carry no token, email, or account identifier', () => {
    for (const name of [
      'valid',
      'no-limits',
      'empty-limits',
      'all-inactive',
      'drift-percent-string',
      'drift-duplicate-identity',
      'drift-unknown-kind',
      'drift-limits-object',
    ]) {
      const text = fixtureText('claude-usage', name);
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
    dir = mkdtempSync(join(tmpdir(), 'aud-claude-usage-'));
    spoolPath = join(dir, 'claude-statusline.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSpool(observedAt: string): void {
    const event = JSON.parse(fixtureText('claude', 'valid-spool')) as Record<string, unknown>;
    writeFileSync(spoolPath, JSON.stringify({ ...event, observedAt }));
  }

  function fetchReturning(status: number, body = fixtureText('claude-usage', 'valid')) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
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
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl as unknown as typeof fetch } : {}),
    });
  }

  const signal = () => new AbortController().signal;

  it('is exactly the spool ingestor when no token is saved, and never claims or fetches', async () => {
    const fetchImpl = fetchReturning(200);
    const claim = vi.fn(() => true);
    const composite = adapter({ token: null, fetchImpl, claim });
    const ingestor = createClaudeIngestor({ spoolPath });

    expect({ ...composite, collect: undefined }).toEqual({ ...ingestor, collect: undefined });
    writeSpool('2026-09-17T00:00:00.000Z');
    const [a, b] = [await composite.collect(signal()), await ingestor.collect(signal())];
    expect({ ...a, collectedAt: null }).toEqual({ ...b, collectedAt: null });

    rmSync(spoolPath);
    await expect(composite.collect(signal())).rejects.toMatchObject({ code: 'no_event_yet' });
    expect(claim).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one GET with the Claude headers, the token only as a bearer header', async () => {
    const fetchImpl = fetchReturning(200);
    await adapter({ fetchImpl }).collect(signal());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(CLAUDE_USAGE_URL);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
      'anthropic-beta': CLAUDE_USAGE_OAUTH_BETA,
    });
  });

  it('claims before it requests, and skips the poll when the claim is lost', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      return new Response(fixtureText('claude-usage', 'valid'), { status: 200 });
    });
    await adapter({
      fetchImpl: fetchImpl as never,
      claim: () => {
        order.push('claim');
        return true;
      },
    }).collect(signal());
    expect(order).toEqual(['claim', 'fetch']);

    writeSpool('2026-09-17T00:00:00.000Z');
    const lost = vi.fn();
    const snap = await adapter({ fetchImpl: lost as never, claim: () => false }).collect(signal());
    expect(lost).not.toHaveBeenCalled();
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
  });

  it('treats a claim that throws as lost, rather than polling unclaimed', async () => {
    writeSpool('2026-09-17T00:00:00.000Z');
    const fetchImpl = fetchReturning(200);
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
    // A spool event from the past loses to a poll made now.
    writeSpool('2026-09-16T00:00:00.000Z');
    const polled = await adapter({ fetchImpl: fetchReturning(200) }).collect(signal());
    expect(polled.sourceVersion).toBe(CLAUDE_USAGE_SOURCE_VERSION);
    expect(polled.sourceEventId).toBeNull();

    // A spool event stamped after the poll wins, keeping its event id for dedup.
    const future = new Date(Date.now() + 60_000).toISOString();
    writeSpool(future);
    const spooled = await adapter({ fetchImpl: fetchReturning(200) }).collect(signal());
    expect(spooled.sourceVersion).toBe('claude-code/2.1.269');
    expect(spooled.sourceEventId).toBe('84cfbc12ad55ba41d052809be0ae4564');
  });

  it.each([
    ['a 429', 429, 'rate_limited'],
    ['a 401', 401, 'auth_rejected'],
    ['a 5xx', 503, 'upstream_error'],
  ])('falls back to the spool on %s without retrying', async (_name, status, code) => {
    const fetchImpl = fetchReturning(status, '{"error":"elided"}');

    writeSpool('2026-09-16T00:00:00.000Z');
    const snap = await adapter({ fetchImpl }).collect(signal());
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    rmSync(spoolPath);
    await expect(adapter({ fetchImpl }).collect(signal())).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the spool on a network error or timeout', async () => {
    writeSpool('2026-09-16T00:00:00.000Z');
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
      adapter({ fetchImpl: fetchReturning(200) }).collect(aborted.signal),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('falls back to the spool on drift, and otherwise surfaces schema_mismatch', async () => {
    const drift = fetchReturning(200, fixtureText('claude-usage', 'drift-duplicate-identity'));

    writeSpool('2026-09-16T00:00:00.000Z');
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
    const fetchImpl = fetchReturning(200);
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

  it('never defers a run that did poll: its own failure is the answer', async () => {
    const refused = adapter({ fetchImpl: fetchReturning(429, '{}'), claim: () => true });
    await expect(refused.collect(signal())).rejects.toBeInstanceOf(CollectionError);
  });

  it('leaves room in its budget for a spool read after a slow poll', () => {
    const composite = adapter({});
    expect(composite.timeoutMs).toBeGreaterThan(
      10_000 + createClaudeIngestor({ spoolPath }).timeoutMs,
    );
  });
});

function active(): Record<string, unknown> {
  return {
    kind: 'session',
    group: 'session',
    percent: 10,
    severity: 'normal',
    resets_at: '2026-09-17T09:00:00+00:00',
    scope: null,
    is_active: true,
  };
}

function omit(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...row };
  delete copy[key];
  return copy;
}
