/**
 * Drizzle table definitions.
 *
 * These mirror drizzle/*.sql, which stays the source of truth for DDL. Writing
 * the migrations by hand keeps the constructs SQLite actually needs here —
 * STRICT tables, CHECK constraints, and the partial unique index that lets
 * polled snapshots accumulate while event snapshots deduplicate — all of which
 * a generator round-trips poorly.
 */
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const collectorRuns = sqliteTable(
  'collector_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trigger: text('trigger', { enum: ['scheduled', 'manual'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('idx_collector_runs_started_at').on(t.startedAt)],
);

export const collectorAttempts = sqliteTable(
  'collector_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => collectorRuns.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['codex', 'claude', 'deepseek', 'openrouter'] }).notNull(),
    outcome: text('outcome', { enum: ['success', 'unavailable', 'error'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    errorCode: text('error_code'),
    safeMessage: text('safe_message'),
    retryCount: integer('retry_count').notNull().default(0),
  },
  (t) => [
    index('idx_collector_attempts_provider_started').on(t.provider, t.startedAt),
    index('idx_collector_attempts_run').on(t.runId),
  ],
);

export const providerSnapshots = sqliteTable(
  'provider_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectorAttemptId: integer('collector_attempt_id')
      .notNull()
      .references(() => collectorAttempts.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['codex', 'claude', 'deepseek', 'openrouter'] }).notNull(),
    kind: text('kind', { enum: ['quota', 'credit'] }).notNull(),
    sourceObservedAt: text('source_observed_at').notNull(),
    collectedAt: text('collected_at').notNull(),
    sourceVersion: text('source_version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    sourceEventId: text('source_event_id'),
    /** Nullable tri-state: 1 allowed, 0 blocked, NULL "source did not say". */
    usageAllowed: integer('usage_allowed'),
    limitReachedCode: text('limit_reached_code'),
  },
  (t) => [
    index('idx_provider_snapshots_provider_observed').on(t.provider, t.sourceObservedAt),
    index('idx_provider_snapshots_collected').on(t.collectedAt),
  ],
);

export const quotaWindows = sqliteTable(
  'quota_windows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => providerSnapshots.id, { onDelete: 'cascade' }),
    bucketId: text('bucket_id').notNull(),
    windowKind: text('window_kind').notNull(),
    /** A gauge, not money — REAL is the correct type here. */
    usedPercent: real('used_percent').notNull(),
    windowDurationMinutes: integer('window_duration_minutes'),
    resetAt: text('reset_at'),
  },
  (t) => [
    unique('uq_quota_windows_snapshot_bucket').on(t.snapshotId, t.bucketId, t.windowKind),
    index('idx_quota_windows_snapshot').on(t.snapshotId),
  ],
);

export const creditBalances = sqliteTable(
  'credit_balances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => providerSnapshots.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    // Every column below is a canonical decimal string, never a float.
    totalBalance: text('total_balance'),
    grantedBalance: text('granted_balance'),
    toppedUpBalance: text('topped_up_balance'),
    totalCredits: text('total_credits'),
    totalUsage: text('total_usage'),
    remainingCredit: text('remaining_credit'),
    isAvailable: integer('is_available'),
  },
  (t) => [
    unique('uq_credit_balances_snapshot_currency').on(t.snapshotId, t.currency),
    index('idx_credit_balances_snapshot').on(t.snapshotId),
  ],
);

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const CURRENT_TIMESTAMP = sql`CURRENT_TIMESTAMP`;
