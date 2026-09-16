/**
 * Persistence seam.
 *
 * Writes are short transactions: begin, insert one attempt plus at most one
 * snapshot and its child rows, commit. Nothing derived is written — no card
 * status, no advisory, no freshness flag — because those depend on
 * configuration and on *now*, and a stored copy would silently go wrong the
 * moment either changed.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  collectorAttempts,
  collectorRuns,
  creditBalances,
  providerSnapshots,
  quotaWindows,
} from './schema';
import type {
  CollectionFailure,
  CreditBalance,
  Provider,
  ProviderSnapshot,
  QuotaWindow,
} from '../domain';
import type { MoneyString } from '../money';
import { nowIso } from '../time';

export type RunTrigger = 'scheduled' | 'manual';

export function startRun(db: Db, trigger: RunTrigger, startedAt = nowIso()): number {
  const [row] = db
    .insert(collectorRuns)
    .values({ trigger, startedAt })
    .returning({ id: collectorRuns.id })
    .all();
  if (!row) throw new Error('failed to create collector run');
  return row.id;
}

export function finishRun(db: Db, runId: number, startedAtMs: number, finishedAt = nowIso()): void {
  db.update(collectorRuns)
    .set({ finishedAt, durationMs: Math.max(0, Date.now() - startedAtMs) })
    .where(eq(collectorRuns.id, runId))
    .run();
}

/**
 * Record one provider attempt and, on success, the observation it produced.
 *
 * The attempt row is written even when the snapshot is a duplicate event, so a
 * "nothing new arrived" run is still auditable.
 */
export function recordAttempt(
  db: Db,
  params: {
    runId: number;
    provider: Provider;
    startedAt: string;
    finishedAt: string;
    retryCount: number;
    result:
      | { outcome: 'success'; snapshot: ProviderSnapshot }
      | { outcome: 'unavailable' | 'error'; failure: CollectionFailure };
  },
): { attemptId: number; snapshotId: number | null; deduplicated: boolean } {
  return db.transaction((tx) => {
    const [attempt] = tx
      .insert(collectorAttempts)
      .values({
        runId: params.runId,
        provider: params.provider,
        outcome: params.result.outcome,
        startedAt: params.startedAt,
        finishedAt: params.finishedAt,
        retryCount: params.retryCount,
        errorCode: params.result.outcome === 'success' ? null : params.result.failure.code,
        safeMessage: params.result.outcome === 'success' ? null : params.result.failure.safeMessage,
      })
      .returning({ id: collectorAttempts.id })
      .all();
    if (!attempt) throw new Error('failed to create collector attempt');

    if (params.result.outcome !== 'success') {
      return { attemptId: attempt.id, snapshotId: null, deduplicated: false };
    }

    const snap = params.result.snapshot;

    // Event-driven sources deduplicate on (provider, source_event_id) via a
    // partial unique index. `onConflictDoNothing` turns a replayed event into a
    // no-op rather than an error, which is what makes the collector idempotent.
    const inserted = tx
      .insert(providerSnapshots)
      .values({
        collectorAttemptId: attempt.id,
        provider: snap.provider,
        kind: snap.kind,
        sourceObservedAt: snap.observedAt,
        collectedAt: snap.collectedAt,
        sourceVersion: snap.sourceVersion,
        schemaVersion: snap.schemaVersion,
        sourceEventId: snap.sourceEventId,
        usageAllowed: snap.kind === 'quota' ? boolToInt(snap.usageAllowed) : null,
        limitReachedCode: snap.kind === 'quota' ? snap.limitReachedCode : null,
      })
      .onConflictDoNothing()
      .returning({ id: providerSnapshots.id })
      .all();

    const snapshotRow = inserted[0];
    if (!snapshotRow) {
      return { attemptId: attempt.id, snapshotId: null, deduplicated: true };
    }

    if (snap.kind === 'quota' && snap.windows.length > 0) {
      tx.insert(quotaWindows)
        .values(
          snap.windows.map((w) => ({
            snapshotId: snapshotRow.id,
            bucketId: w.bucketId,
            windowKind: w.windowKind,
            // Stored as the source reported it; only the derived remaining
            // percentage is clamped, at presentation time.
            usedPercent: w.usedPercent,
            windowDurationMinutes: w.windowDurationMinutes,
            resetAt: w.resetsAt,
          })),
        )
        .run();
    }

    if (snap.kind === 'credit' && snap.balances.length > 0) {
      tx.insert(creditBalances)
        .values(
          snap.balances.map((b) => ({
            snapshotId: snapshotRow.id,
            currency: b.currency,
            totalBalance: b.totalBalance,
            grantedBalance: b.grantedBalance,
            toppedUpBalance: b.toppedUpBalance,
            totalCredits: b.totalCredits,
            totalUsage: b.totalUsage,
            remainingCredit: b.remainingCredit,
            isAvailable: boolToInt(b.isAvailable),
          })),
        )
        .run();
    }

    return { attemptId: attempt.id, snapshotId: snapshotRow.id, deduplicated: false };
  });
}

function boolToInt(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

function intToBool(v: number | null): boolean | null {
  return v === null ? null : v === 1;
}

const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Atomically claim the next permitted Claude usage poll.
 *
 * Returns true, and records `attemptedAt`, only when no poll was claimed within
 * `intervalMs` before it. One `INSERT … ON CONFLICT … DO UPDATE … WHERE`
 * statement decides and writes together; a read followed by a write would let
 * the scheduled collector and a manual refresh both see an old claim and both
 * call the endpoint. The caller claims *before* its request, so a refusal, a
 * network failure, or a crash still spends the interval.
 *
 * Timestamps must be canonical UTC ISO-8601 (`Date#toISOString`), which is what
 * makes SQLite's text comparison chronological.
 */
export function claimClaudePoll(db: Db, attemptedAt: string, intervalMs: number): boolean {
  if (!CANONICAL_UTC_ISO.test(attemptedAt) || Number.isNaN(Date.parse(attemptedAt))) {
    throw new Error('claimClaudePoll needs a canonical UTC ISO-8601 timestamp');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('claimClaudePoll needs a non-negative interval');
  }
  const cutoff = new Date(Date.parse(attemptedAt) - intervalMs).toISOString();
  const result = db.$client
    .prepare(
      `INSERT INTO claude_poll_state (id, last_attempted_at) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET last_attempted_at = excluded.last_attempted_at
       WHERE claude_poll_state.last_attempted_at <= ?`,
    )
    .run(attemptedAt, cutoff);
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface StoredSnapshot {
  readonly id: number;
  readonly provider: Provider;
  readonly kind: 'quota' | 'credit';
  readonly sourceObservedAt: string;
  readonly collectedAt: string;
  readonly sourceVersion: string;
  readonly schemaVersion: number;
  readonly usageAllowed: boolean | null;
  readonly limitReachedCode: string | null;
  readonly windows: readonly QuotaWindow[];
  readonly balances: readonly CreditBalance[];
}

export interface StoredAttempt {
  readonly provider: Provider;
  readonly outcome: 'success' | 'unavailable' | 'error';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly errorCode: string | null;
  readonly safeMessage: string | null;
  readonly retryCount: number;
}

/** Newest snapshot per provider, with its child rows hydrated. */
export function getLatestSnapshots(db: Db): Map<Provider, StoredSnapshot> {
  // One row per provider: the newest *observation*, not the newest row. Two runs
  // can overlap (a manual refresh during a scheduled run), and the one that
  // persists last may carry the older reading; ordering by id would let it
  // replace fresher data. `id` only breaks ties between equal timestamps.
  const latestIds = db.$client
    .prepare(
      `SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY provider ORDER BY source_observed_at DESC, id DESC
         ) AS rn
         FROM provider_snapshots
       ) WHERE rn = 1`,
    )
    .pluck()
    .all() as number[];

  if (latestIds.length === 0) return new Map();

  const snaps = db
    .select()
    .from(providerSnapshots)
    .where(inArray(providerSnapshots.id, latestIds))
    .all();

  const windows = db
    .select()
    .from(quotaWindows)
    .where(inArray(quotaWindows.snapshotId, latestIds))
    .all();

  const balances = db
    .select()
    .from(creditBalances)
    .where(inArray(creditBalances.snapshotId, latestIds))
    .all();

  const out = new Map<Provider, StoredSnapshot>();
  for (const s of snaps) {
    out.set(s.provider, {
      id: s.id,
      provider: s.provider,
      kind: s.kind,
      sourceObservedAt: s.sourceObservedAt,
      collectedAt: s.collectedAt,
      sourceVersion: s.sourceVersion,
      schemaVersion: s.schemaVersion,
      usageAllowed: intToBool(s.usageAllowed),
      limitReachedCode: s.limitReachedCode,
      windows: windows
        .filter((w) => w.snapshotId === s.id)
        .map((w) => ({
          bucketId: w.bucketId,
          windowKind: w.windowKind,
          usedPercent: w.usedPercent,
          windowDurationMinutes: w.windowDurationMinutes,
          resetsAt: w.resetAt,
        })),
      balances: balances
        .filter((b) => b.snapshotId === s.id)
        .map((b) => ({
          currency: b.currency,
          totalBalance: b.totalBalance as MoneyString | null,
          grantedBalance: b.grantedBalance as MoneyString | null,
          toppedUpBalance: b.toppedUpBalance as MoneyString | null,
          totalCredits: b.totalCredits as MoneyString | null,
          totalUsage: b.totalUsage as MoneyString | null,
          remainingCredit: b.remainingCredit as MoneyString | null,
          isAvailable: intToBool(b.isAvailable),
        })),
    });
  }
  return out;
}

/**
 * The newest stored reading of every quota window each provider has ever
 * reported, one per bucket and kind.
 *
 * A source can stop reporting a window without saying why: Claude Code omits
 * `five_hour` between the moment a window resets and the first request of the
 * next one. Comparing this against the latest snapshot is how the overview
 * tells that gap apart from a window that simply does not exist.
 */
export function getLastSeenWindows(db: Db): Map<Provider, QuotaWindow[]> {
  const rows = db.$client
    .prepare(
      `SELECT provider, bucket_id, window_kind, used_percent, window_duration_minutes, reset_at
       FROM (
         SELECT s.provider, w.bucket_id, w.window_kind, w.used_percent,
                w.window_duration_minutes, w.reset_at,
                ROW_NUMBER() OVER (
                  PARTITION BY s.provider, w.bucket_id, w.window_kind
                  ORDER BY s.source_observed_at DESC, s.id DESC
                ) AS rn
         FROM quota_windows w
         JOIN provider_snapshots s ON s.id = w.snapshot_id
       ) WHERE rn = 1`,
    )
    .all() as {
    provider: Provider;
    bucket_id: string;
    window_kind: string;
    used_percent: number;
    window_duration_minutes: number | null;
    reset_at: string | null;
  }[];

  const out = new Map<Provider, QuotaWindow[]>();
  for (const r of rows) {
    const list = out.get(r.provider) ?? [];
    list.push({
      bucketId: r.bucket_id,
      windowKind: r.window_kind,
      usedPercent: r.used_percent,
      windowDurationMinutes: r.window_duration_minutes,
      resetsAt: r.reset_at,
    });
    out.set(r.provider, list);
  }
  return out;
}

/**
 * Most recent attempt per provider — the basis for the `error` card state.
 *
 * Resolved with a grouped MAX rather than by scanning a fixed slice of recent
 * rows. Manual refresh is provider-scoped, so a run of refreshes against one
 * provider would otherwise push another provider's latest attempt outside the
 * scanned window and silently drop its error state and diagnostics.
 */
export function getLatestAttempts(db: Db): Map<Provider, StoredAttempt> {
  // The latest attempt is the one that *started* last. Insertion order is not:
  // a slow scheduled attempt that times out can be written after a manual
  // refresh that began later and succeeded, and must not mask it.
  const latestIds = db.$client
    .prepare(
      `SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY provider ORDER BY started_at DESC, id DESC
         ) AS rn
         FROM collector_attempts
       ) WHERE rn = 1`,
    )
    .pluck()
    .all() as number[];

  if (latestIds.length === 0) return new Map();

  const rows = db
    .select()
    .from(collectorAttempts)
    .where(inArray(collectorAttempts.id, latestIds))
    .all();

  const out = new Map<Provider, StoredAttempt>();
  for (const r of rows) {
    out.set(r.provider, {
      provider: r.provider,
      outcome: r.outcome,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      errorCode: r.errorCode,
      safeMessage: r.safeMessage,
      retryCount: r.retryCount,
    });
  }
  return out;
}

/** Timestamp of the last *successful* collection per provider. */
export function getLastSuccessAt(db: Db): Map<Provider, string> {
  const rows = db
    .select({
      provider: collectorAttempts.provider,
      finishedAt: sql<string>`MAX(${collectorAttempts.finishedAt})`,
    })
    .from(collectorAttempts)
    .where(eq(collectorAttempts.outcome, 'success'))
    .groupBy(collectorAttempts.provider)
    .all();
  return new Map(rows.filter((r) => r.finishedAt).map((r) => [r.provider, r.finishedAt]));
}

export interface QuotaHistoryPoint {
  readonly observedAt: string;
  readonly bucketId: string;
  readonly windowKind: string;
  readonly usedPercent: number;
  readonly windowDurationMinutes: number | null;
  readonly sourceVersion: string;
}

/** Raw quota observations in a window, oldest first. Aggregation happens above. */
export function getQuotaHistory(
  db: Db,
  provider: Provider,
  sinceIso: string,
): readonly QuotaHistoryPoint[] {
  return db
    .select({
      observedAt: providerSnapshots.sourceObservedAt,
      bucketId: quotaWindows.bucketId,
      windowKind: quotaWindows.windowKind,
      usedPercent: quotaWindows.usedPercent,
      windowDurationMinutes: quotaWindows.windowDurationMinutes,
      sourceVersion: providerSnapshots.sourceVersion,
    })
    .from(quotaWindows)
    .innerJoin(providerSnapshots, eq(quotaWindows.snapshotId, providerSnapshots.id))
    .where(
      and(
        eq(providerSnapshots.provider, provider),
        gte(providerSnapshots.sourceObservedAt, sinceIso),
      ),
    )
    .orderBy(providerSnapshots.sourceObservedAt)
    .all();
}

export interface CreditHistoryPoint {
  readonly observedAt: string;
  readonly currency: string;
  readonly totalBalance: MoneyString | null;
  readonly totalUsage: MoneyString | null;
  readonly remainingCredit: MoneyString | null;
}

export function getCreditHistory(
  db: Db,
  provider: Provider,
  sinceIso: string,
): readonly CreditHistoryPoint[] {
  return db
    .select({
      observedAt: providerSnapshots.sourceObservedAt,
      currency: creditBalances.currency,
      totalBalance: creditBalances.totalBalance,
      totalUsage: creditBalances.totalUsage,
      remainingCredit: creditBalances.remainingCredit,
    })
    .from(creditBalances)
    .innerJoin(providerSnapshots, eq(creditBalances.snapshotId, providerSnapshots.id))
    .where(
      and(
        eq(providerSnapshots.provider, provider),
        gte(providerSnapshots.sourceObservedAt, sinceIso),
      ),
    )
    .orderBy(providerSnapshots.sourceObservedAt)
    .all() as readonly CreditHistoryPoint[];
}

/**
 * The newest observation *at or before* `beforeIso`.
 *
 * This is the baseline a cumulative-counter delta needs. Without it a "usage in
 * the last 7 days" figure would silently become "usage since we started
 * collecting", which is a different and much smaller number.
 */
export function getCreditBaselineBefore(
  db: Db,
  provider: Provider,
  beforeIso: string,
): readonly CreditHistoryPoint[] {
  const [latest] = db
    .select({ id: providerSnapshots.id })
    .from(providerSnapshots)
    .where(
      and(
        eq(providerSnapshots.provider, provider),
        lt(providerSnapshots.sourceObservedAt, beforeIso),
      ),
    )
    .orderBy(desc(providerSnapshots.sourceObservedAt))
    .limit(1)
    .all();

  if (!latest) return [];

  return db
    .select({
      observedAt: providerSnapshots.sourceObservedAt,
      currency: creditBalances.currency,
      totalBalance: creditBalances.totalBalance,
      totalUsage: creditBalances.totalUsage,
      remainingCredit: creditBalances.remainingCredit,
    })
    .from(creditBalances)
    .innerJoin(providerSnapshots, eq(creditBalances.snapshotId, providerSnapshots.id))
    .where(eq(creditBalances.snapshotId, latest.id))
    .all() as readonly CreditHistoryPoint[];
}

/**
 * Delete observations older than the retention horizon.
 *
 * Child rows go via ON DELETE CASCADE; runs are pruned only once no attempt
 * references them, so an audit trail is never orphaned mid-way.
 */
export function applyRetention(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.transaction((tx) => {
    const snapshots = tx
      .delete(providerSnapshots)
      .where(lt(providerSnapshots.collectedAt, cutoff))
      .returning({ id: providerSnapshots.id })
      .all();

    tx.delete(collectorAttempts).where(lt(collectorAttempts.finishedAt, cutoff)).run();
    tx.run(
      sql`DELETE FROM ${collectorRuns} WHERE ${collectorRuns.startedAt} < ${cutoff} AND NOT EXISTS (SELECT 1 FROM ${collectorAttempts} WHERE ${collectorAttempts.runId} = ${collectorRuns.id})`,
    );
    return snapshots.length;
  });
}
