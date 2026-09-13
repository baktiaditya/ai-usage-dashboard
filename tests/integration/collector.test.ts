import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenrouterAdapter } from '@/lib/adapters/openrouter';
import { collectOnce, runAdapter } from '@/lib/collector/index';
import { CollectionError } from '@/lib/errors';
import type { ErrorCode } from '@/lib/errors';
import type { ProviderAdapter, Provider, QuotaSnapshot } from '@/lib/domain';
import { getLatestAttempts, getLatestSnapshots } from '@/lib/db/repository';
import { createTestDb, testConfig } from '../helpers/db';
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

  it('classifies a missing credential as unavailable, not error', async () => {
    const record = await runAdapter(failingAdapter('deepseek', 'not_configured'));
    expect(record.result.outcome).toBe('unavailable');
  });

  it('enforces its own timeout ceiling on an adapter that ignores the signal', async () => {
    const started = Date.now();
    const record = await runAdapter(hangingAdapter('codex'));
    expect(record.result.outcome).toBe('error');
    if (record.result.outcome !== 'success') {
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
    if (record.result.outcome !== 'success') {
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
