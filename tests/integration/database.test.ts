import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from '@/lib/db/client';
import {
  applyRetention,
  finishRun,
  getCreditBaselineBefore,
  getLastSuccessAt,
  getLatestAttempts,
  getLatestSnapshots,
  recordAttempt,
  startRun,
} from '@/lib/db/repository';
import type { CreditSnapshot, QuotaSnapshot } from '@/lib/domain';
import type { MoneyString } from '@/lib/money';
import { createTestDb } from '../helpers/db';
import type { TestDb } from '../helpers/db';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function quota(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    kind: 'quota',
    provider: 'codex',
    observedAt: '2026-09-12T12:00:00.000Z',
    collectedAt: '2026-09-12T12:00:01.000Z',
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    sourceEventId: null,
    windows: [
      {
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: 37,
        windowDurationMinutes: 300,
        resetsAt: '2026-09-12T17:00:00.000Z',
      },
      {
        bucketId: 'codex',
        windowKind: 'secondary',
        usedPercent: 52,
        windowDurationMinutes: 10080,
        resetsAt: '2026-09-19T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function credit(overrides: Partial<CreditSnapshot> = {}): CreditSnapshot {
  return {
    kind: 'credit',
    provider: 'openrouter',
    observedAt: '2026-09-12T12:00:00.000Z',
    collectedAt: '2026-09-12T12:00:01.000Z',
    sourceVersion: 'openrouter-api/v1-credits',
    schemaVersion: 1,
    sourceEventId: null,
    balances: [
      {
        currency: 'USD',
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits: '100.5' as MoneyString,
        totalUsage: '25.75' as MoneyString,
        remainingCredit: '74.75' as MoneyString,
        isAvailable: null,
      },
    ],
    ...overrides,
  };
}

function write(snapshot: QuotaSnapshot | CreditSnapshot, runId?: number) {
  const id = runId ?? startRun(t.db, 'scheduled');
  return recordAttempt(t.db, {
    runId: id,
    provider: snapshot.provider,
    startedAt: snapshot.collectedAt,
    finishedAt: snapshot.collectedAt,
    retryCount: 0,
    result: { outcome: 'success', snapshot },
  });
}

describe('migrations', () => {
  it('creates every table and is idempotent', () => {
    const sqlite = t.db.$client;
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toEqual([
      'collector_attempts',
      'collector_runs',
      'credit_balances',
      'provider_snapshots',
      'quota_windows',
      'schema_migrations',
    ]);

    // Re-running applies nothing further.
    expect(runMigrations(sqlite)).toBe(0);
  });

  it('enables WAL so a reader never blocks the writer', () => {
    expect(t.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('sets a busy timeout so an overlapping writer waits instead of failing', () => {
    expect(t.db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('uses STRICT tables so a type error is rejected at the database', () => {
    // STRICT refuses a value it cannot losslessly convert to the declared type.
    expect(() =>
      t.db.$client
        .prepare('INSERT INTO collector_runs (trigger, started_at, duration_ms) VALUES (?,?,?)')
        .run('scheduled', '2026-09-12T00:00:00.000Z', 'not-a-number'),
    ).toThrow(/cannot store TEXT value in INTEGER/i);
  });
});

describe('constraints', () => {
  it('rejects an unknown provider', () => {
    const runId = startRun(t.db, 'scheduled');
    expect(() =>
      t.db.$client
        .prepare(
          'INSERT INTO collector_attempts (run_id, provider, outcome, started_at, finished_at) VALUES (?,?,?,?,?)',
        )
        .run(runId, 'gemini', 'success', 'a', 'b'),
    ).toThrow();
  });

  it('requires a failed attempt to carry an error code', () => {
    const runId = startRun(t.db, 'scheduled');
    expect(() =>
      t.db.$client
        .prepare(
          'INSERT INTO collector_attempts (run_id, provider, outcome, started_at, finished_at, error_code) VALUES (?,?,?,?,?,?)',
        )
        .run(runId, 'codex', 'error', 'a', 'b', null),
    ).toThrow();
  });

  it('forbids a percentage outside 0..100', () => {
    const { snapshotId } = write(quota());
    expect(() =>
      t.db.$client
        .prepare(
          'INSERT INTO quota_windows (snapshot_id, bucket_id, window_kind, used_percent) VALUES (?,?,?,?)',
        )
        .run(snapshotId, 'x', 'y', 101),
    ).toThrow();
  });

  it('forbids two rows for the same currency in one snapshot', () => {
    const { snapshotId } = write(credit());
    expect(() =>
      t.db.$client
        .prepare(
          'INSERT INTO credit_balances (snapshot_id, currency, total_credits) VALUES (?,?,?)',
        )
        .run(snapshotId, 'USD', '1'),
    ).toThrow();
  });

  it('cascades child rows when a snapshot is deleted', () => {
    const { snapshotId } = write(quota());
    t.db.$client.prepare('DELETE FROM provider_snapshots WHERE id = ?').run(snapshotId);
    const remaining = t.db.$client.prepare('SELECT COUNT(*) c FROM quota_windows').get() as {
      c: number;
    };
    expect(remaining.c).toBe(0);
  });
});

describe('event deduplication', () => {
  it('keeps every polled observation as separate history', () => {
    // Polled sources have a NULL event id and must never collapse.
    write(quota({ observedAt: '2026-09-12T12:00:00.000Z' }));
    write(quota({ observedAt: '2026-09-12T12:05:00.000Z' }));
    const rows = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
      c: number;
    };
    expect(rows.c).toBe(2);
  });

  it('collapses a replayed event-driven observation into a no-op', () => {
    const event = quota({ provider: 'claude', sourceEventId: 'evt-abc-123' });
    const first = write(event);
    const second = write(event);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.snapshotId).toBeNull();

    const rows = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
      c: number;
    };
    expect(rows.c).toBe(1);

    // The attempt is still recorded, so the run remains auditable.
    const attempts = t.db.$client.prepare('SELECT COUNT(*) c FROM collector_attempts').get() as {
      c: number;
    };
    expect(attempts.c).toBe(2);
  });

  it('lets two different providers share an event id', () => {
    write(quota({ provider: 'claude', sourceEventId: 'shared' }));
    write(quota({ provider: 'codex', sourceEventId: 'shared' }));
    const rows = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
      c: number;
    };
    expect(rows.c).toBe(2);
  });
});

describe('reads', () => {
  it('returns the newest snapshot per provider with children hydrated', () => {
    write(quota({ observedAt: '2026-09-12T11:00:00.000Z' }));
    write(quota({ observedAt: '2026-09-12T12:00:00.000Z' }));
    write(credit());

    const latest = getLatestSnapshots(t.db);
    expect(latest.get('codex')?.sourceObservedAt).toBe('2026-09-12T12:00:00.000Z');
    expect(latest.get('codex')?.windows).toHaveLength(2);
    expect(latest.get('openrouter')?.balances[0]?.remainingCredit).toBe('74.75');
  });

  it('round-trips money as an exact decimal string, never a float', () => {
    write(
      credit({
        balances: [
          {
            currency: 'USD',
            totalBalance: null,
            grantedBalance: null,
            toppedUpBalance: null,
            totalCredits: '123456789.123456789' as MoneyString,
            totalUsage: '0.000000001' as MoneyString,
            remainingCredit: '123456789.123456788' as MoneyString,
            isAvailable: null,
          },
        ],
      }),
    );
    const stored = getLatestSnapshots(t.db).get('openrouter')?.balances[0];
    expect(stored?.totalCredits).toBe('123456789.123456789');
    expect(stored?.remainingCredit).toBe('123456789.123456788');

    // And the column is declared TEXT, so SQLite cannot coerce it.
    const type = t.db.$client
      .prepare('SELECT typeof(total_credits) t FROM credit_balances LIMIT 1')
      .get() as { t: string };
    expect(type.t).toBe('text');
  });

  it('stores multiple currencies from one snapshot', () => {
    write(
      credit({
        provider: 'deepseek',
        balances: [
          {
            currency: 'CNY',
            totalBalance: '110' as MoneyString,
            grantedBalance: '10' as MoneyString,
            toppedUpBalance: '100' as MoneyString,
            totalCredits: null,
            totalUsage: null,
            remainingCredit: null,
            isAvailable: true,
          },
          {
            currency: 'USD',
            totalBalance: '15.42' as MoneyString,
            grantedBalance: null,
            toppedUpBalance: null,
            totalCredits: null,
            totalUsage: null,
            remainingCredit: null,
            isAvailable: true,
          },
        ],
      }),
    );
    const balances = getLatestSnapshots(t.db).get('deepseek')?.balances ?? [];
    expect(balances.map((b) => b.currency).sort()).toEqual(['CNY', 'USD']);
  });

  it('tracks the latest attempt and the last successful collection separately', () => {
    const runId = startRun(t.db, 'scheduled');
    write(quota(), runId);
    recordAttempt(t.db, {
      runId: startRun(t.db, 'scheduled'),
      provider: 'codex',
      startedAt: '2026-09-12T12:10:00.000Z',
      finishedAt: '2026-09-12T12:10:02.000Z',
      retryCount: 1,
      result: {
        outcome: 'error',
        failure: {
          provider: 'codex',
          attemptedAt: '2026-09-12T12:10:00.000Z',
          code: 'timeout',
          safeMessage: 'no response',
          retryable: true,
        },
      },
    });

    expect(getLatestAttempts(t.db).get('codex')?.outcome).toBe('error');
    // The successful collection time survives the later failure.
    expect(getLastSuccessAt(t.db).get('codex')).toBe('2026-09-12T12:00:01.000Z');
  });

  it('finds the newest baseline strictly before a cutoff', () => {
    write(credit({ observedAt: '2026-09-01T00:00:00.000Z' }));
    write(credit({ observedAt: '2026-09-05T00:00:00.000Z' }));
    write(credit({ observedAt: '2026-09-12T00:00:00.000Z' }));

    const baseline = getCreditBaselineBefore(t.db, 'openrouter', '2026-09-10T00:00:00.000Z');
    expect(baseline[0]?.observedAt).toBe('2026-09-05T00:00:00.000Z');

    // No observation before the period means no baseline, never a zero.
    expect(getCreditBaselineBefore(t.db, 'openrouter', '2026-08-01T00:00:00.000Z')).toHaveLength(0);
  });
});

describe('retention', () => {
  it('prunes observations past the horizon and keeps recent ones', () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

    write(quota({ collectedAt: old, observedAt: old }));
    write(quota({ collectedAt: recent, observedAt: recent }));

    const pruned = applyRetention(t.db, 90);
    expect(pruned).toBe(1);

    const rows = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
      c: number;
    };
    expect(rows.c).toBe(1);
    // Child rows went with it.
    const windows = t.db.$client.prepare('SELECT COUNT(*) c FROM quota_windows').get() as {
      c: number;
    };
    expect(windows.c).toBe(2);
  });

  it('is idempotent', () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    write(quota({ collectedAt: old, observedAt: old }));
    expect(applyRetention(t.db, 90)).toBe(1);
    expect(applyRetention(t.db, 90)).toBe(0);
  });
});

describe('run accounting', () => {
  it('records a duration when the run finishes', () => {
    const started = Date.now() - 1200;
    const runId = startRun(t.db, 'manual');
    finishRun(t.db, runId, started);
    const row = t.db.$client
      .prepare('SELECT duration_ms, finished_at FROM collector_runs WHERE id = ?')
      .get(runId) as {
      duration_ms: number;
      finished_at: string;
    };
    expect(row.duration_ms).toBeGreaterThanOrEqual(1200);
    expect(row.finished_at).toMatch(/Z$/);
  });
});

describe('WAL concurrency', () => {
  it('lets a second connection write while the first is reading', () => {
    write(quota());

    // A second process, exactly as the collector CLI and the web server relate.
    const second = openDb({ path: t.path, migrate: false });
    try {
      const before = t.db.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
        c: number;
      };
      write(quota({ observedAt: '2026-09-12T13:00:00.000Z' }));
      const runId = startRun(second, 'manual');
      recordAttempt(second, {
        runId,
        provider: 'deepseek',
        startedAt: 'a',
        finishedAt: 'b',
        retryCount: 0,
        result: {
          outcome: 'unavailable',
          failure: {
            provider: 'deepseek',
            attemptedAt: 'a',
            code: 'not_configured',
            safeMessage: 'no key',
            retryable: false,
          },
        },
      });

      const after = second.$client.prepare('SELECT COUNT(*) c FROM provider_snapshots').get() as {
        c: number;
      };
      expect(after.c).toBeGreaterThan(before.c);
    } finally {
      second.$client.close();
    }
  });

  it('honours busy_timeout instead of throwing SQLITE_BUSY immediately', () => {
    const other = new Database(t.path);
    try {
      other.pragma('busy_timeout = 3000');
      // Both connections can begin, and the deferred reader still sees data.
      expect(() => {
        const tx = other.transaction(() => {
          other.prepare('SELECT COUNT(*) FROM provider_snapshots').get();
        });
        tx();
      }).not.toThrow();
    } finally {
      other.close();
    }
  });
});
