/**
 * Overview projection — everything one dashboard screen needs, in one read.
 *
 * This is the only place where stored facts, the clock, and configuration meet.
 * The API layer serialises the result verbatim; the UI renders it without
 * recomputing any status. That keeps "why is this card orange" answerable in
 * exactly one file.
 */
import type { AppConfig } from '../config';
import type { Advisory, CardStatus, Provider, QuotaWindow, CreditBalance } from '../domain';
import { PROVIDERS, PROVIDER_KIND, PROVIDER_LABELS } from '../domain';
import type { Db } from '../db/client';
import {
  getLastSeenWindows,
  getLastSuccessAt,
  getLatestAttempts,
  getLatestSnapshots,
} from '../db/repository';
import { evaluateFreshness, maxAgeMs } from '../freshness';
import { computeAdvisory } from '../advisory';
import { ERROR_CODE_HINTS } from '../errors';
import type { ErrorCode } from '../errors';
import { labelWindow } from './labels';
import { buildQuotaToday } from './history';
import type { QuotaTodayResult } from './history';

/**
 * Providers whose card spans the full grid width and charts today's readings
 * per hour. OpenCode Go reports three windows, and its console charts the
 * same day, so the space beside the windows carries that view.
 */
const TODAY_CHART_PROVIDERS: ReadonlySet<Provider> = new Set(['opencode_go']);

// Re-exported so callers keep importing window labels from the overview.
export { labelWindow };

export interface OverviewWindow extends QuotaWindow {
  /** Derived at presentation time; `usedPercent` remains the stored truth. */
  readonly remainingPercent: number;
  readonly label: string;
  /** True when this window's reset time is already in the past. */
  readonly resetPassed: boolean;
}

/**
 * A window the source reported before but left out of its latest observation,
 * after that window had already reset. Claude Code does this between a reset
 * and the first request of the next window. No percentage is carried: the old
 * reading ended with its window, and the new one does not exist yet.
 */
export interface EndedWindow {
  readonly bucketId: string;
  readonly windowKind: string;
  readonly windowDurationMinutes: number | null;
  readonly label: string;
  /** When the last reported window reset. */
  readonly endedAt: string;
}

export interface ProviderCard {
  readonly provider: Provider;
  readonly label: string;
  readonly kind: 'quota' | 'credit';
  readonly status: CardStatus;
  readonly statusReason: string;
  readonly advisory: Advisory;
  /** When the *source* observed the data. */
  readonly sourceObservedAt: string | null;
  /** When the collector last succeeded for this provider. */
  readonly lastSuccessfulCollectionAt: string | null;
  readonly dataAgeMs: number | null;
  readonly freshnessBudgetMs: number;
  readonly sourceVersion: string | null;
  readonly schemaVersion: number | null;
  /** Present only for quota providers. */
  readonly windows: readonly OverviewWindow[];
  /** Quota providers only: windows that reset and have not been reported since. */
  readonly endedWindows: readonly EndedWindow[];
  /** Present only for credit providers. */
  readonly balances: readonly CreditBalance[];
  readonly usageAllowed: boolean | null;
  readonly limitReachedCode: string | null;
  readonly diagnostics: {
    readonly errorCode: ErrorCode | null;
    readonly hint: string | null;
    readonly safeMessage: string | null;
    readonly retryCount: number;
    readonly lastAttemptAt: string | null;
  };
  /**
   * True when values are shown from an observation that is no longer trusted
   * (error or stale). The UI must label these as last known, not current.
   */
  readonly showingLastKnownValues: boolean;
  /**
   * Today's readings per local hour, for providers whose card is wide enough to
   * chart them beside the windows. `null` for every other provider.
   */
  readonly today: QuotaTodayResult | null;
}

export interface Overview {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly collectIntervalMinutes: number;
  readonly cards: readonly ProviderCard[];
}

/**
 * Windows missing from the latest observation because they reset before it.
 *
 * A window counts only when its last reading reset at or before the latest
 * observation and less than one window length earlier. A window gone for longer
 * than its own length, one without a known length or reset, or one that went
 * missing before its reset, is left out: the source's silence then says
 * nothing this card can explain.
 */
export function findEndedWindows(
  latest: readonly QuotaWindow[],
  lastSeen: readonly QuotaWindow[],
  observedAt: string,
): EndedWindow[] {
  const observedMs = Date.parse(observedAt);
  const present = new Set(latest.map((w) => `${w.bucketId}\u0000${w.windowKind}`));
  const ended: EndedWindow[] = [];
  for (const w of lastSeen) {
    if (present.has(`${w.bucketId}\u0000${w.windowKind}`)) continue;
    if (w.resetsAt === null || w.windowDurationMinutes === null) continue;
    const resetMs = Date.parse(w.resetsAt);
    if (!(resetMs <= observedMs && resetMs > observedMs - w.windowDurationMinutes * 60_000)) {
      continue;
    }
    ended.push({
      bucketId: w.bucketId,
      windowKind: w.windowKind,
      windowDurationMinutes: w.windowDurationMinutes,
      label: labelWindow(w),
      endedAt: w.resetsAt,
    });
  }
  return ended;
}

export function buildOverview(db: Db, config: AppConfig, now: Date = new Date()): Overview {
  const snapshots = getLatestSnapshots(db);
  const attempts = getLatestAttempts(db);
  const lastSuccess = getLastSuccessAt(db);
  const lastSeenWindows = getLastSeenWindows(db);

  const cards: ProviderCard[] = PROVIDERS.map((provider) => {
    const snapshot = snapshots.get(provider);
    const attempt = attempts.get(provider);

    const freshness = evaluateFreshness({ provider, snapshot, attempt, config, now });
    const advisory = computeAdvisory({
      provider,
      status: freshness.status,
      snapshot,
      config,
      statusReason: freshness.reason,
    });

    const errorCode = (attempt?.errorCode ?? null) as ErrorCode | null;

    const windows: OverviewWindow[] =
      snapshot?.kind === 'quota'
        ? snapshot.windows.map((w) => ({
            ...w,
            remainingPercent: clamp(100 - w.usedPercent, 0, 100),
            label: labelWindow(w),
            resetPassed: w.resetsAt !== null && Date.parse(w.resetsAt) <= now.getTime(),
          }))
        : [];
    const endedWindows =
      snapshot?.kind === 'quota'
        ? findEndedWindows(
            snapshot.windows,
            lastSeenWindows.get(provider) ?? [],
            snapshot.sourceObservedAt,
          )
        : [];

    return {
      provider,
      label: PROVIDER_LABELS[provider],
      kind: PROVIDER_KIND[provider],
      status: freshness.status,
      statusReason: freshness.reason,
      advisory,
      sourceObservedAt: snapshot?.sourceObservedAt ?? null,
      lastSuccessfulCollectionAt: lastSuccess.get(provider) ?? null,
      dataAgeMs: freshness.dataAgeMs,
      freshnessBudgetMs: maxAgeMs(provider, snapshot?.sourceVersion ?? null, config),
      sourceVersion: snapshot?.sourceVersion ?? null,
      schemaVersion: snapshot?.schemaVersion ?? null,
      windows,
      endedWindows,
      balances: snapshot?.kind === 'credit' ? snapshot.balances : [],
      usageAllowed: snapshot?.usageAllowed ?? null,
      limitReachedCode: snapshot?.limitReachedCode ?? null,
      diagnostics: {
        errorCode,
        hint: errorCode ? (ERROR_CODE_HINTS[errorCode] ?? null) : null,
        safeMessage: attempt?.safeMessage ?? null,
        retryCount: attempt?.retryCount ?? 0,
        lastAttemptAt: attempt?.finishedAt ?? null,
      },
      showingLastKnownValues: snapshot !== undefined && freshness.status !== 'healthy',
      today: TODAY_CHART_PROVIDERS.has(provider)
        ? buildQuotaToday(db, config, provider, now)
        : null,
    };
  });

  return {
    generatedAt: now.toISOString(),
    timezone: config.timezone,
    collectIntervalMinutes: config.collectIntervalMinutes,
    cards,
  };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
