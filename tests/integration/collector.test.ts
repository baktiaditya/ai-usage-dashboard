import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrapped, not replaced: each keeps its real behavior and records its options.
vi.mock('@/lib/adapters/deepseek', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters/deepseek')>();
  return { ...actual, createDeepseekAdapter: vi.fn(actual.createDeepseekAdapter) };
});
vi.mock('@/lib/adapters/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters/openrouter')>();
  return { ...actual, createOpenrouterAdapter: vi.fn(actual.createOpenrouterAdapter) };
});

import { createDeepseekAdapter } from '@/lib/adapters/deepseek';
import { createOpenrouterAdapter } from '@/lib/adapters/openrouter';
import { collectOnce, runAdapter } from '@/lib/collector/index';
import { getConfig, resetConfigCache } from '@/lib/config';
import { openDb } from '@/lib/db/client';
import { removeProviderCredential, saveProviderCredential } from '@/lib/db/credentials';
import { CollectionDeferred, CollectionError } from '@/lib/errors';
import type { ErrorCode } from '@/lib/errors';
import { CLAUDE_PROBE_SOURCE_VERSION } from '@/lib/domain';
import type { ProviderAdapter, Provider, QuotaSnapshot } from '@/lib/domain';
import { claimClaudePoll, getLatestAttempts, getLatestSnapshots } from '@/lib/db/repository';
import type { Logger } from '@/lib/logger';
import { buildOverview } from '@/lib/queries/overview';
import { createTestDb, testConfig } from '../helpers/db';
import { fixtureJson, fixtureText } from '../helpers/fixtures';
import type { TestDb } from '../helpers/db';

let t: TestDb;
const config = testConfig();

beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function snapshotFor(provider: Provider): QuotaSnapshot {
  return {
    kind: 'quota',
    provider,
    observedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    sourceVersion: 'test/1',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    sourceEventId: null,
    windows: [
      {
        bucketId: 'b',
        windowKind: 'primary',
        usedPercent: 10,
        windowDurationMinutes: 300,
        resetsAt: null,
      },
    ],
  };
}

function okAdapter(provider: Provider, delayMs = 0): ProviderAdapter {
  return {
    provider,
    schemaVersion: 1,
    timeoutMs: 1000,
    async collect() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return snapshotFor(provider);
    },
  };
}

function failingAdapter(provider: Provider, code: ErrorCode): ProviderAdapter {
  return {
    provider,
    schemaVersion: 1,
    timeoutMs: 1000,
    async collect() {
      throw new CollectionError(code, `simulated ${code}`);
    },
  };
}

/** An adapter that ignores its abort signal, as a badly behaved one would. */
function hangingAdapter(provider: Provider): ProviderAdapter {
  return {
    provider,
    schemaVersion: 1,
    timeoutMs: 120,
    async collect() {
      await new Promise((r) => setTimeout(r, 5000));
      return snapshotFor(provider);
    },
  };
}

describe('runAdapter', () => {
  it('never rejects, even when the adapter throws a plain Error', async () => {
    const record = await runAdapter({
      provider: 'codex',
      schemaVersion: 1,
      timeoutMs: 500,
      async collect() {
        throw new Error('kaboom');
      },
    });
    expect(record.result.outcome).toBe('error');
  });

  it('reports a deferred adapter as deferred, and collectOnce writes no attempt for it', async () => {
    const deferring: ProviderAdapter = {
      provider: 'claude',
      schemaVersion: 1,
      timeoutMs: 500,
      async collect() {
        throw new CollectionDeferred('another run owns this answer');
      },
    };
    expect((await runAdapter(deferring)).result.outcome).toBe('deferred');

    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'manual',
      adapters: [deferring, okAdapter('codex')],
    });
    expect(summary.attempts).toEqual([
      { provider: 'claude', outcome: 'deferred', code: null },
      { provider: 'codex', outcome: 'success', code: null },
    ]);
    expect(summary).toMatchObject({ success: 1, deferred: 1, error: 0, unavailable: 0 });
    expect([...getLatestAttempts(t.db).keys()]).toEqual(['codex']);
  });

  it('classifies a missing credential as unavailable, not error', async () => {
    const record = await runAdapter(failingAdapter('deepseek', 'not_configured'));
    expect(record.result.outcome).toBe('unavailable');
  });

  it.each(['schema_mismatch', 'version_unsupported'] as const)(
    'classifies %s as error for every provider',
    async (code) => {
      for (const provider of ['codex', 'claude', 'deepseek', 'openrouter'] as const) {
        const record = await runAdapter(failingAdapter(provider, code));
        expect(record.result).toMatchObject({ outcome: 'error', failure: { provider, code } });
      }
    },
  );

  it('enforces its own timeout ceiling on an adapter that ignores the signal', async () => {
    const started = Date.now();
    const record = await runAdapter(hangingAdapter('codex'));
    expect(record.result.outcome).toBe('error');
    if (record.result.outcome === 'error') {
      expect(record.result.failure.code).toBe('timeout');
      expect(record.result.failure.retryable).toBe(true);
    }
    // It gives up near its budget rather than waiting out the 5s sleep.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('redacts a secret that leaked into an adapter error message', async () => {
    const record = await runAdapter({
      provider: 'openrouter',
      schemaVersion: 1,
      timeoutMs: 500,
      async collect() {
        throw new Error('request failed with Authorization: Bearer sk-or-v1-supersecretvalue');
      },
    });
    expect(record.result.outcome).toBe('error');
    if (record.result.outcome === 'error') {
      expect(record.result.failure.safeMessage).not.toContain('sk-or-v1-supersecretvalue');
    }
  });
});

describe('retry accounting', () => {
  it('persists how many retries an attempt took, for success and failure alike', async () => {
    const flaky: ProviderAdapter = {
      provider: 'codex',
      schemaVersion: 1,
      timeoutMs: 1000,
      async collect(_signal, context) {
        context?.recordRetry();
        context?.recordRetry();
        return snapshotFor('codex');
      },
    };
    const exhausted: ProviderAdapter = {
      provider: 'deepseek',
      schemaVersion: 1,
      timeoutMs: 1000,
      async collect(_signal, context) {
        context?.recordRetry();
        throw new CollectionError('upstream_error', 'still failing');
      },
    };

    await collectOnce({ db: t.db, config, trigger: 'manual', adapters: [flaky, exhausted] });
    const latest = getLatestAttempts(t.db);
    expect(latest.get('codex')?.retryCount).toBe(2);
    expect(latest.get('deepseek')?.retryCount).toBe(1);
  });

  it('records the retry the HTTP layer actually made (500, then success)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 500 })
        : new Response('{"data":{"total_credits":10,"total_usage":1}}', { status: 200 });
    }) as unknown as typeof fetch;

    await collectOnce({
      db: t.db,
      config,
      trigger: 'manual',
      adapters: [createOpenrouterAdapter({ managementKey: 'k', fetchImpl })],
    });
    expect(calls).toBe(2);
    expect(getLatestAttempts(t.db).get('openrouter')?.retryCount).toBe(1);
  });
});

describe('provider failure isolation', () => {
  it('lets healthy providers update while others fail', async () => {
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [
        okAdapter('codex'),
        failingAdapter('claude', 'no_event_yet'),
        failingAdapter('deepseek', 'not_configured'),
        failingAdapter('openrouter', 'upstream_error'),
      ],
    });

    expect(summary.success).toBe(1);
    expect(summary.unavailable).toBe(2);
    expect(summary.error).toBe(1);

    // The healthy provider's observation actually landed.
    const snapshots = getLatestSnapshots(t.db);
    expect(snapshots.get('codex')).toBeDefined();
    expect(snapshots.get('openrouter')).toBeUndefined();

    // Every provider is still audited.
    const attempts = getLatestAttempts(t.db);
    expect(attempts.size).toBe(4);
    expect(attempts.get('openrouter')?.errorCode).toBe('upstream_error');
  });

  it('reports an attempt that could not be persisted as an error, never as success', async () => {
    t.db.$client.exec(
      "CREATE TRIGGER reject_attempts BEFORE INSERT ON collector_attempts BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [okAdapter('codex'), failingAdapter('deepseek', 'not_configured')],
    });

    // Nothing reached the database, so neither the adapter's success nor its
    // "unavailable" may be reported: the run must not look green.
    expect(summary.success).toBe(0);
    expect(summary.unavailable).toBe(0);
    expect(summary.error).toBe(2);
    expect(summary.attempts).toEqual([
      { provider: 'codex', outcome: 'error', code: 'io_error' },
      { provider: 'deepseek', outcome: 'error', code: 'io_error' },
    ]);
    expect(getLatestSnapshots(t.db).size).toBe(0);
  });

  it('is not slowed to the sum of its providers', async () => {
    const started = Date.now();
    await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [
        okAdapter('codex', 200),
        okAdapter('claude', 200),
        okAdapter('deepseek', 200),
        okAdapter('openrouter', 200),
      ],
    });
    // Concurrent: closer to 200ms than to 800ms.
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('keeps one provider timing out from delaying the others', async () => {
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [okAdapter('codex'), hangingAdapter('deepseek')],
    });
    expect(summary.success).toBe(1);
    expect(summary.error).toBe(1);
    expect(getLatestSnapshots(t.db).get('codex')).toBeDefined();
  });

  it('records exactly one run and one attempt per provider', async () => {
    await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [okAdapter('codex'), failingAdapter('deepseek', 'timeout')],
    });

    const runs = t.db.$client.prepare('SELECT COUNT(*) c FROM collector_runs').get() as {
      c: number;
    };
    const attempts = t.db.$client.prepare('SELECT COUNT(*) c FROM collector_attempts').get() as {
      c: number;
    };
    expect(runs.c).toBe(1);
    expect(attempts.c).toBe(2);
  });

  it('derives success and failure counts from the attempt rows', async () => {
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [okAdapter('codex'), failingAdapter('deepseek', 'timeout')],
    });

    const rows = t.db.$client
      .prepare('SELECT outcome, COUNT(*) c FROM collector_attempts GROUP BY outcome')
      .all() as { outcome: string; c: number }[];
    const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.c]));
    expect(byOutcome['success']).toBe(summary.success);
    expect(byOutcome['error']).toBe(summary.error);
  });
});

describe('scoped and idempotent collection', () => {
  it('collects only the requested provider', async () => {
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'manual',
      providers: ['codex'],
      adapters: [okAdapter('codex'), okAdapter('deepseek')],
    });
    expect(summary.attempts.map((a) => a.provider)).toEqual(['codex']);
    expect(getLatestSnapshots(t.db).has('deepseek')).toBe(false);
  });

  it('treats a replayed event as a no-op while still recording the attempt', async () => {
    const eventAdapter: ProviderAdapter = {
      provider: 'claude',
      schemaVersion: 1,
      timeoutMs: 500,
      async collect() {
        return { ...snapshotFor('claude'), sourceEventId: 'stable-event-id' };
      },
    };

    const first = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [eventAdapter],
    });
    const second = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [eventAdapter],
    });

    expect(first.deduplicated).toBe(0);
    expect(second.deduplicated).toBe(1);

    const snapshots = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
      c: number;
    };
    expect(snapshots.c).toBe(1);
  });

  it('runs retention on scheduled collections and skips it on manual ones', async () => {
    const scheduled = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [okAdapter('codex')],
    });
    const manual = await collectOnce({
      db: t.db,
      config,
      trigger: 'manual',
      adapters: [okAdapter('codex')],
    });
    expect(scheduled.prunedSnapshots).toBe(0);
    expect(manual.prunedSnapshots).toBe(0);

    // Retention is opt-out on manual, which the summary reports faithfully.
    expect(manual.attempts).toHaveLength(1);
  });

  it('survives a run where every provider fails', async () => {
    const summary = await collectOnce({
      db: t.db,
      config,
      trigger: 'scheduled',
      adapters: [
        failingAdapter('codex', 'process_failed'),
        failingAdapter('deepseek', 'network_error'),
      ],
    });
    expect(summary.error).toBe(2);
    expect(summary.success).toBe(0);
    // The run still closes cleanly.
    const run = t.db.$client
      .prepare('SELECT finished_at FROM collector_runs WHERE id = ?')
      .get(summary.runId) as {
      finished_at: string | null;
    };
    expect(run.finished_at).not.toBeNull();
  });
});

describe('credentials come from the database', () => {
  // Fake keys only.
  const DEEPSEEK_KEY = 'sk-fake-collector-deepseek-0001';
  const OPENROUTER_KEY = 'sk-or-fake-collector-openrouter-0002';
  const run = (runConfig = config) =>
    collectOnce({
      db: t.db,
      config: runConfig,
      trigger: 'scheduled',
      providers: ['deepseek', 'openrouter'],
    });

  /** The next adapters built fail locally, so no run reaches a provider. */
  function stubNextAdapters(): void {
    vi.mocked(createDeepseekAdapter).mockImplementationOnce(
      () =>
        failingAdapter('deepseek', 'auth_rejected') as unknown as ReturnType<
          typeof createDeepseekAdapter
        >,
    );
    vi.mocked(createOpenrouterAdapter).mockImplementationOnce(
      () =>
        failingAdapter('openrouter', 'auth_rejected') as unknown as ReturnType<
          typeof createOpenrouterAdapter
        >,
    );
  }

  beforeEach(() => {
    vi.mocked(createDeepseekAdapter).mockClear();
    vi.mocked(createOpenrouterAdapter).mockClear();
  });

  it('hands each adapter exactly the saved key, re-read on every run', async () => {
    saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY);
    saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);
    stubNextAdapters();
    await run();

    expect(vi.mocked(createDeepseekAdapter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDeepseekAdapter)).toHaveBeenLastCalledWith({ apiKey: DEEPSEEK_KEY });
    expect(vi.mocked(createOpenrouterAdapter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createOpenrouterAdapter)).toHaveBeenLastCalledWith({
      managementKey: OPENROUTER_KEY,
    });

    // A change between runs applies to the very next one: nothing is cached.
    saveProviderCredential(t.db, 'deepseek', `${DEEPSEEK_KEY}-rotated`);
    removeProviderCredential(t.db, 'openrouter');
    stubNextAdapters();
    await run();

    expect(vi.mocked(createDeepseekAdapter)).toHaveBeenLastCalledWith({
      apiKey: `${DEEPSEEK_KEY}-rotated`,
    });
    expect(vi.mocked(createOpenrouterAdapter)).toHaveBeenLastCalledWith({ managementKey: null });
  });

  it('reports both unavailable when no key is saved, even with keys in the environment and AUD_ENV_FILE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aud-collector-env-'));
    const envFile = join(dir, 'collector.env');
    writeFileSync(envFile, `DEEPSEEK_API_KEY=${DEEPSEEK_KEY}\n`, { mode: 0o600 });
    const names = ['DEEPSEEK_API_KEY', 'OPENROUTER_MANAGEMENT_KEY', 'AUD_ENV_FILE'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const upstream = vi.fn(async () => {
      throw new Error('no network in this suite');
    });
    vi.stubGlobal('fetch', upstream);
    delete process.env['DEEPSEEK_API_KEY'];
    process.env['OPENROUTER_MANAGEMENT_KEY'] = OPENROUTER_KEY;
    process.env['AUD_ENV_FILE'] = envFile;
    resetConfigCache();

    try {
      // `getConfig` merges the file into the environment, as every entry point does.
      const summary = await run(getConfig());
      expect(process.env['DEEPSEEK_API_KEY']).toBe(DEEPSEEK_KEY);

      expect(summary.attempts).toEqual([
        { provider: 'deepseek', outcome: 'unavailable', code: 'not_configured' },
        { provider: 'openrouter', outcome: 'unavailable', code: 'not_configured' },
      ]);
      expect(vi.mocked(createDeepseekAdapter)).toHaveBeenLastCalledWith({ apiKey: null });
      expect(vi.mocked(createOpenrouterAdapter)).toHaveBeenLastCalledWith({ managementKey: null });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      resetConfigCache();
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude quota probe through the collector', () => {
  // Shaped like a setup token, but not one.
  const CLAUDE_TOKEN = 'sk-ant-oat01-fake-collector-token-0000';
  let upstream: ReturnType<typeof vi.fn>;
  let claudeConfig: ReturnType<typeof testConfig>;

  const probeHeaders = (name: string) =>
    (fixtureJson('claude-probe', name) as { headers: Record<string, string> }).headers;

  const respond = (status: number, fixture = 'valid', delayMs = 0) =>
    vi.fn(async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return new Response('{"content":"elided"}', { status, headers: probeHeaders(fixture) });
    });

  function stubUpstream(fn: ReturnType<typeof vi.fn>): void {
    upstream = fn;
    vi.stubGlobal('fetch', upstream);
  }

  /** The fixture event is long past, so by default it never answers a run by itself. */
  function writeSpool(observedAt?: string): void {
    mkdirSync(dirname(claudeConfig.spoolPath), { recursive: true });
    const event = JSON.parse(fixtureText('claude', 'valid-spool')) as Record<string, unknown>;
    writeFileSync(
      claudeConfig.spoolPath,
      JSON.stringify(observedAt ? { ...event, observedAt } : event),
    );
  }

  const run = (trigger: 'scheduled' | 'manual' = 'scheduled', db = t.db) =>
    collectOnce({ db, config: claudeConfig, trigger, providers: ['claude'] });

  const claudeRows = (table: 'collector_attempts' | 'provider_snapshots') =>
    t.db.$client.prepare(`SELECT COUNT(*) FROM ${table} WHERE provider = 'claude'`).pluck().get();

  const claudeCard = () =>
    buildOverview(t.db, claudeConfig).cards.find((c) => c.provider === 'claude');

  beforeEach(() => {
    claudeConfig = testConfig({ AUD_DATA_DIR: t.dir });
    stubUpstream(respond(200));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('with no token saved, reads only the spool and never probes or claims', async () => {
    const summary = await run();

    expect(summary.attempts).toEqual([
      { provider: 'claude', outcome: 'unavailable', code: 'no_event_yet' },
    ]);
    expect(upstream).not.toHaveBeenCalled();
    expect(t.db.$client.prepare('SELECT COUNT(*) FROM claude_poll_state').pluck().get()).toBe(0);

    writeSpool();
    expect((await run()).attempts).toEqual([
      { provider: 'claude', outcome: 'success', code: null },
    ]);
    expect(getLatestSnapshots(t.db).get('claude')?.sourceVersion).toBe('claude-code/2.1.269');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('with a token, reports a current, labelled reading while no session has run', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    const summary = await run();

    expect(summary.attempts).toEqual([{ provider: 'claude', outcome: 'success', code: null }]);
    expect(upstream).toHaveBeenCalledTimes(1);

    const card = claudeCard();
    expect(card).toMatchObject({
      status: 'healthy',
      sourceVersion: CLAUDE_PROBE_SOURCE_VERSION,
      // A probed observation gets the pull budget, not the 12-hour event budget.
      freshnessBudgetMs: 15 * 60_000,
      endedWindows: [],
    });
    expect(card?.windows.map((w) => w.label)).toEqual(['5 hour', '7 day']);
    expect(card?.windows.map((w) => w.resetsAt)).toEqual([
      '2099-09-13T16:26:40.000Z',
      '2099-09-18T07:33:20.000Z',
    ]);
  });

  it('with a token, sends no probe and takes no claim while a session is reporting', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    writeSpool(new Date(Date.now() - 60_000).toISOString());

    for (const trigger of ['scheduled', 'manual'] as const) {
      expect((await run(trigger)).attempts).toEqual([
        { provider: 'claude', outcome: 'success', code: null },
      ]);
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(t.db.$client.prepare('SELECT COUNT(*) FROM claude_poll_state').pluck().get()).toBe(0);
    expect(getLatestSnapshots(t.db).get('claude')?.sourceVersion).toBe('claude-code/2.1.269');
  });

  it('makes at most one request when scheduled and manual collections overlap', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    stubUpstream(respond(200, 'valid', 200));
    writeSpool();
    const web = openDb({ path: t.path });
    try {
      const summaries = await Promise.all([run('scheduled'), run('manual', web)]);

      expect(upstream).toHaveBeenCalledTimes(1);
      // Each run still records exactly one Claude attempt, and both succeed.
      for (const summary of summaries) {
        expect(summary.attempts).toEqual([{ provider: 'claude', outcome: 'success', code: null }]);
      }
      expect(claudeRows('collector_attempts')).toBe(2);
      expect([...getLatestAttempts(t.db).keys()].filter((p) => p === 'claude')).toHaveLength(1);
    } finally {
      web.$client.close();
    }
  });

  it('spends the interval on a 429: no retry, success from the spool, no second request', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    stubUpstream(respond(429, 'no-unified-headers'));
    writeSpool();

    const first = await run();
    expect(first.attempts).toEqual([{ provider: 'claude', outcome: 'success', code: null }]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(getLatestAttempts(t.db).get('claude')).toMatchObject({
      outcome: 'success',
      retryCount: 0,
    });
    expect(getLatestSnapshots(t.db).get('claude')?.sourceVersion).toBe('claude-code/2.1.269');

    // A manual refresh straight after is inside the interval the failure spent.
    await run('manual');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('records error with the probe code when a 429 has no usable spool to fall back on', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    stubUpstream(respond(429, 'no-unified-headers'));

    expect((await run()).attempts).toEqual([
      { provider: 'claude', outcome: 'error', code: 'rate_limited' },
    ]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(claudeCard()?.status).toBe('error');
  });

  it('records schema_mismatch and renders error on drift without a usable spool', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    stubUpstream(respond(200, 'drift-utilization-percent'));

    expect((await run()).attempts).toEqual([
      { provider: 'claude', outcome: 'error', code: 'schema_mismatch' },
    ]);
    expect(claudeRows('provider_snapshots')).toBe(0);
    expect(claudeCard()).toMatchObject({
      status: 'error',
      windows: [],
      diagnostics: { errorCode: 'schema_mismatch' },
    });
  });

  it('writes one attempt and at most one snapshot when both sources answer', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    writeSpool();

    await run();
    expect(claudeRows('collector_attempts')).toBe(1);
    expect(claudeRows('provider_snapshots')).toBe(1);
    expect(getLatestSnapshots(t.db).get('claude')?.sourceVersion).toBe(CLAUDE_PROBE_SOURCE_VERSION);

    // Inside the interval the probe is skipped; the unchanged spool event is
    // written once and then deduplicated.
    await run('manual');
    await run('manual');
    expect(claudeRows('collector_attempts')).toBe(3);
    expect(claudeRows('provider_snapshots')).toBe(2);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  describe('a run that loses the claim with no usable spool', () => {
    const claudeAttempts = () =>
      t.db.$client
        .prepare(
          "SELECT outcome, error_code FROM collector_attempts WHERE provider = 'claude' ORDER BY id",
        )
        .all();

    it('keeps a stored probe reading healthy and lets it age, with no request and no new row', async () => {
      saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
      await run('scheduled');
      const probedAt = claudeCard()?.sourceObservedAt;
      expect(upstream).toHaveBeenCalledTimes(1);

      // A manual refresh and a narrowly early scheduled run both lose the claim.
      for (const trigger of ['manual', 'scheduled'] as const) {
        const summary = await run(trigger);
        expect(summary.attempts).toEqual([{ provider: 'claude', outcome: 'deferred', code: null }]);
        expect(summary).toMatchObject({ deferred: 1, success: 0, unavailable: 0, error: 0 });
      }

      expect(upstream).toHaveBeenCalledTimes(1);
      expect(claudeAttempts()).toEqual([{ outcome: 'success', error_code: null }]);
      expect(claudeRows('provider_snapshots')).toBe(1);
      expect(claudeCard()).toMatchObject({ status: 'healthy', sourceObservedAt: probedAt });

      // Age still applies: past the pull budget the same reading is stale, not current.
      const later = new Date(Date.parse(probedAt!) + 16 * 60_000);
      expect(
        buildOverview(t.db, claudeConfig, later).cards.find((c) => c.provider === 'claude'),
      ).toMatchObject({ status: 'stale', sourceObservedAt: probedAt });
    });

    it('does not mask the claimant while its probe is still in flight, nor after it lands', async () => {
      saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      stubUpstream(
        vi.fn(async () => {
          await gate;
          return new Response(null, { status: 200, headers: probeHeaders('valid') });
        }),
      );
      const web = openDb({ path: t.path });
      try {
        const winner = run('scheduled');
        // Wait until the winner holds the claim and its request is open.
        await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));

        const loser = await run('manual', web);
        expect(loser.attempts).toEqual([{ provider: 'claude', outcome: 'deferred', code: null }]);
        // Nothing was ever collected, so the card honestly says so meanwhile.
        expect(claudeCard()?.status).toBe('unavailable');
        expect(claudeAttempts()).toEqual([]);

        release();
        expect((await winner).attempts).toEqual([
          { provider: 'claude', outcome: 'success', code: null },
        ]);
        expect(claudeCard()).toMatchObject({
          status: 'healthy',
          sourceVersion: CLAUDE_PROBE_SOURCE_VERSION,
        });
        expect(upstream).toHaveBeenCalledTimes(1);
      } finally {
        release();
        web.$client.close();
      }
    });

    it('keeps the claimant’s failure as the card state instead of hiding it', async () => {
      saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
      stubUpstream(respond(429, 'no-unified-headers'));
      await run('scheduled');
      await run('manual');

      expect(claudeAttempts()).toEqual([{ outcome: 'error', error_code: 'rate_limited' }]);
      expect(claudeCard()).toMatchObject({
        status: 'error',
        diagnostics: { errorCode: 'rate_limited' },
      });
      expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('stays unavailable when no probe result exists at all', async () => {
      saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
      // A claim left by a run that crashed before recording anything.
      claimClaudePoll(t.db, new Date().toISOString(), 5 * 60_000);

      expect((await run('manual')).attempts).toEqual([
        { provider: 'claude', outcome: 'deferred', code: null },
      ]);
      expect(upstream).not.toHaveBeenCalled();
      expect(claudeCard()).toMatchObject({ status: 'unavailable', sourceObservedAt: null });
    });
  });

  it('never logs the token or a quota value', async () => {
    saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
    const lines: string[] = [];
    const record = (message: string, fields?: Record<string, unknown>) => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
    };
    const logger: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
      child: () => logger,
    };
    for (const status of [200, 401]) {
      t.db.$client.exec('DELETE FROM claude_poll_state');
      stubUpstream(respond(status, status === 200 ? 'valid' : 'no-unified-headers'));
      await collectOnce({
        db: t.db,
        config: claudeConfig,
        trigger: 'manual',
        providers: ['claude'],
        logger,
      });
    }
    const logged = lines.join('\n');
    expect(logged).toContain('auth_rejected');
    expect(logged).not.toContain('fake-collector-token');
    expect(logged).not.toMatch(/12\.5|\b48\b|4093000000|2099-/);
  });
});

describe('OpenCode Go through the collector', () => {
  // Shaped like an OpenCode key, but not one.
  const OPENCODE_GO_KEY = 'sk-fake-collector-opencode-go-0003';
  let upstream: ReturnType<typeof vi.fn>;

  const run = () =>
    collectOnce({ db: t.db, config, trigger: 'manual', providers: ['opencode_go'] });
  const card = () => buildOverview(t.db, config).cards.find((c) => c.provider === 'opencode_go');

  function serve(status: number, fixture = 'valid'): void {
    upstream = vi.fn(
      async () =>
        new Response(status === 200 ? fixtureText('opencode-go', fixture) : '{}', {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
  }

  // The fixtures carry fixed reset times, and a card whose window has reset reads `stale`.
  // Pin the clock before the earliest one (rolling, 2026-09-30T16:30Z) so the cases stay
  // true after that date.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('with no key saved, is unavailable and sends nothing', async () => {
    serve(200);
    expect((await run()).attempts).toEqual([
      { provider: 'opencode_go', outcome: 'unavailable', code: 'not_configured' },
    ]);
    expect(upstream).not.toHaveBeenCalled();
    expect(card()?.status).toBe('unavailable');
  });

  it('with a key, stores three labelled windows and renders a healthy card', async () => {
    saveProviderCredential(t.db, 'opencode_go', OPENCODE_GO_KEY);
    serve(200);

    expect((await run()).attempts).toEqual([
      { provider: 'opencode_go', outcome: 'success', code: null },
    ]);
    const sent = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(sent[0]).toBe('https://opencode.ai/zen/go/v1/usage');
    expect((sent[1].headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${OPENCODE_GO_KEY}`,
    );

    const c = card();
    expect(c?.status).toBe('healthy');
    expect(c?.kind).toBe('quota');
    expect(c?.usageAllowed).toBeNull();
    expect(c?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5 hour', 7],
      ['7 day', 41],
      ['Monthly', 23],
    ]);
  });

  it('suggests switching when the source reports a rate-limited window', async () => {
    saveProviderCredential(t.db, 'opencode_go', OPENCODE_GO_KEY);
    serve(200, 'rate-limited');
    await run();

    const advisory = card()?.advisory;
    expect(advisory?.state).toBe('switch_suggested');
    expect(advisory?.reasons.map((r) => r.observed)).toContain('weekly_rate_limited');
  });

  it('renders a key without a Go subscription as unavailable, not as a broken key', async () => {
    saveProviderCredential(t.db, 'opencode_go', OPENCODE_GO_KEY);
    serve(403);

    expect((await run()).attempts).toEqual([
      { provider: 'opencode_go', outcome: 'unavailable', code: 'not_entitled' },
    ]);
    expect(card()?.status).toBe('unavailable');
  });

  it('renders a rejected key as an error', async () => {
    saveProviderCredential(t.db, 'opencode_go', OPENCODE_GO_KEY);
    serve(401);

    expect((await run()).attempts).toEqual([
      { provider: 'opencode_go', outcome: 'error', code: 'auth_rejected' },
    ]);
    expect(card()?.status).toBe('error');
  });
});
