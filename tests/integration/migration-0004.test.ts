/**
 * Migration 0004 rebuilds collector_attempts and provider_snapshots, which are
 * parents of ON DELETE CASCADE keys. Run with enforcement on, the drops would
 * delete the whole history. These tests prove the rebuild keeps every row and
 * id, and that a rebuild leaving a dangling reference rolls back.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/client';
import { MIGRATIONS } from '@/lib/db/migrations.generated';

const TABLES = [
  'collector_runs',
  'collector_attempts',
  'provider_snapshots',
  'quota_windows',
  'credit_balances',
  'provider_credentials',
  'claude_poll_state',
] as const;

let dir: string;
let raw: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-m0004-'));
  raw = new Database(join(dir, 'usage.db'));
  raw.pragma('foreign_keys = ON');
  raw.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT',
  );
  for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
    raw.exec(migration.sql);
    raw
      .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
      .run(migration.version, '2026-09-17T00:00:00.000Z');
  }
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Rows in every table, with ids deliberately not starting at 1. */
function seed(): void {
  raw.exec(`
    INSERT INTO collector_runs (id, trigger, started_at, finished_at, duration_ms)
      VALUES (41, 'scheduled', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:02.000Z', 2000);
    INSERT INTO collector_attempts
      (id, run_id, provider, outcome, started_at, finished_at, error_code, safe_message, retry_count)
      VALUES
      (101, 41, 'codex', 'success', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', NULL, NULL, 0),
      (102, 41, 'deepseek', 'success', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', NULL, NULL, 1),
      (103, 41, 'openrouter', 'error', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', 'upstream_error', 'HTTP 502', 2),
      (104, 41, 'claude', 'success', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', NULL, NULL, 0);
    INSERT INTO provider_snapshots
      (id, collector_attempt_id, provider, kind, source_observed_at, collected_at, source_version,
       schema_version, source_event_id, usage_allowed, limit_reached_code)
      VALUES
      (201, 101, 'codex', 'quota', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', 'codex-cli/0.154.0', 1, NULL, 1, NULL),
      (202, 102, 'deepseek', 'credit', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', 'deepseek-api/user-balance', 1, NULL, NULL, NULL),
      (203, 104, 'claude', 'quota', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z', 'claude-code/2.1.0', 1, 'evt-1', NULL, NULL);
    INSERT INTO quota_windows
      (id, snapshot_id, bucket_id, window_kind, used_percent, window_duration_minutes, reset_at)
      VALUES
      (301, 201, 'codex', 'primary', 37, 300, '2026-09-17T05:00:00.000Z'),
      (302, 201, 'codex', 'secondary', 52, 10080, '2026-09-24T00:00:00.000Z'),
      (303, 203, 'claude', 'five_hour', 12.5, 300, NULL);
    INSERT INTO credit_balances
      (id, snapshot_id, currency, total_balance, granted_balance, topped_up_balance, total_credits,
       total_usage, remaining_credit, is_available)
      VALUES (401, 202, 'USD', '15.42', '0.00', '15.42', NULL, NULL, NULL, 1);
    INSERT INTO provider_credentials (provider, secret, updated_at)
      VALUES ('deepseek', 'sk-test-deepseek-0000000000', '2026-09-15T00:00:00.000Z'),
             ('claude', 'sk-ant-oat01-test-0000000000', '2026-09-17T00:00:00.000Z');
    INSERT INTO claude_poll_state (id, last_attempted_at) VALUES (1, '2026-09-17T00:00:00.000Z');
  `);
}

function dump(): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
  );
}

describe('migration 0004', () => {
  it('keeps every row and id in every table, and admits opencode_go', () => {
    seed();
    const before = dump();

    expect(runMigrations(raw)).toBe(MIGRATIONS.length - 4);

    expect(dump()).toEqual(before);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);

    // AUTOINCREMENT continues from the highest copied id.
    const nextAttempt = raw
      .prepare(
        `INSERT INTO collector_attempts (run_id, provider, outcome, started_at, finished_at)
         VALUES (41, 'opencode_go', 'success', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:01.000Z')`,
      )
      .run().lastInsertRowid;
    expect(Number(nextAttempt)).toBe(105);
    raw
      .prepare(
        `INSERT INTO provider_snapshots
           (collector_attempt_id, provider, kind, source_observed_at, collected_at, source_version, schema_version)
         VALUES (?, 'opencode_go', 'quota', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:01.000Z',
                 'opencode-api/zen-go-v1-usage', 1)`,
      )
      .run(nextAttempt);
    raw
      .prepare(
        `INSERT INTO provider_credentials (provider, secret, updated_at)
         VALUES ('opencode_go', 'sk-test-opencode-0000000000', '2026-09-30T00:00:00.000Z')`,
      )
      .run();

    // Unknown providers are still refused.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO collector_attempts (run_id, provider, outcome, started_at, finished_at)
           VALUES (41, 'gemini', 'success', 'a', 'b')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('keeps foreign keys pointing at the rebuilt tables, so cascades still work', () => {
    seed();
    runMigrations(raw);

    const children = raw
      .prepare(
        `SELECT m.name AS child, f."table" AS parent
         FROM sqlite_master m, pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table' ORDER BY 1, 2`,
      )
      .all();
    expect(children).toEqual([
      { child: 'collector_attempts', parent: 'collector_runs' },
      { child: 'credit_balances', parent: 'provider_snapshots' },
      { child: 'provider_snapshots', parent: 'collector_attempts' },
      { child: 'quota_windows', parent: 'provider_snapshots' },
    ]);

    raw.prepare('DELETE FROM collector_runs WHERE id = 41').run();
    for (const table of [
      'collector_attempts',
      'provider_snapshots',
      'quota_windows',
      'credit_balances',
    ]) {
      expect(raw.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
  });

  it('recreates every index 0000 defined on the rebuilt tables', () => {
    runMigrations(raw);
    const indexes = raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name IN ('collector_attempts', 'provider_snapshots')
           AND name NOT LIKE 'sqlite_autoindex_%'
         ORDER BY name`,
      )
      .pluck()
      .all();
    expect(indexes).toEqual([
      'idx_collector_attempts_provider_started',
      'idx_collector_attempts_run',
      'idx_provider_snapshots_collected',
      'idx_provider_snapshots_provider_observed',
      'uq_provider_snapshots_event',
    ]);
  });

  it('rolls the whole pending set back when it leaves a dangling reference', () => {
    seed();
    // A database whose history already points at a missing attempt: the check
    // after the rebuild must refuse to commit it.
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM collector_attempts WHERE id = 101').run();
    raw.pragma('foreign_keys = ON');
    const before = dump();

    expect(() => runMigrations(raw)).toThrow(/foreign key violation/);

    expect(dump()).toEqual(before);
    expect(raw.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(3);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
