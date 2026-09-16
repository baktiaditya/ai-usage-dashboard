/**
 * History projection, aggregated per metric type.
 *
 * The three metric kinds cannot share an aggregation:
 *
 *   - **Quota gauges** are sampled levels. The useful summary is latest / min /
 *     max utilisation per window per day. Summing them would produce a number
 *     with no meaning ("380% of Tuesday").
 *   - **Cumulative counters** (OpenRouter `total_usage`) are only meaningful as
 *     a delta, and a delta needs a baseline observed *before* the period starts.
 *     Without one the honest answer is "insufficient history", not zero.
 *   - **Balances** (DeepSeek) change for reasons other than usage — top-ups and
 *     expiring grants — so their delta is reported as *balance change* and is
 *     never called usage.
 */
import type { AppConfig } from '../config';
import { CLAUDE_USAGE_SOURCE_VERSION } from '../domain';
import type { Provider } from '../domain';
import type { Db } from '../db/client';
import { getCreditBaselineBefore, getCreditHistory, getQuotaHistory } from '../db/repository';
import type { MoneyString } from '../money';
import { compareMoney, subtractMoney } from '../money';
import { startOfLocalDayNDaysAgoUtc } from '../time';
import { labelWindow } from './overview';

export type HistoryRange = 'today' | '7d' | '30d';

export const HISTORY_RANGES: readonly HistoryRange[] = ['today', '7d', '30d'];

export function isHistoryRange(v: string): v is HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(v);
}

function rangeDays(range: HistoryRange): number {
  return range === 'today' ? 0 : range === '7d' ? 6 : 29;
}

export interface QuotaSeriesPoint {
  readonly day: string;
  readonly latestPercent: number;
  readonly minPercent: number;
  readonly maxPercent: number;
  readonly samples: number;
}

export interface QuotaSeries {
  readonly bucketId: string;
  readonly windowKind: string;
  /**
   * What the chart shows for this series. Claude series name their source, so a
   * status-line window and a polled one are never drawn as one line: nobody has
   * shown that `five_hour` and `session` measure the same window.
   */
  readonly label: string;
  readonly points: readonly QuotaSeriesPoint[];
}

/**
 * Why "insufficient" is a first-class result rather than an empty array:
 * a chart that renders zero for a period we never observed is a lie that looks
 * like data. The UI must say so instead.
 */
export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface QuotaHistoryResult {
  readonly metric: 'quota_utilization';
  readonly provider: Provider;
  readonly range: HistoryRange;
  readonly availability: Availability;
  readonly series: readonly QuotaSeries[];
}

export interface CreditDelta {
  readonly currency: string;
  /** Canonical decimal string. Null when no baseline exists. */
  readonly change: MoneyString | null;
  readonly from: MoneyString | null;
  readonly to: MoneyString | null;
  /**
   * A negative usage delta means the upstream counter was reset (billing cycle,
   * account change), not that usage was negative.
   */
  readonly discontinuity: boolean;
}

export interface CreditHistoryResult {
  readonly metric: 'usage_delta' | 'balance_change';
  readonly provider: Provider;
  readonly range: HistoryRange;
  readonly availability: Availability;
  readonly deltas: readonly CreditDelta[];
  readonly series: readonly {
    readonly observedAt: string;
    readonly currency: string;
    readonly value: MoneyString | null;
  }[];
}

/** Calendar day key such as 2026-09-12, computed in the configured timezone. */
function localDayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function buildQuotaHistory(
  db: Db,
  config: AppConfig,
  provider: Provider,
  range: HistoryRange,
  now: Date = new Date(),
): QuotaHistoryResult {
  const since = startOfLocalDayNDaysAgoUtc(config.timezone, rangeDays(range), now);
  const rows = getQuotaHistory(db, provider, since.toISOString());

  if (rows.length === 0) {
    return {
      metric: 'quota_utilization',
      provider,
      range,
      availability: {
        available: false,
        reason: `No quota observation was recorded for this provider in the selected ${range} period.`,
      },
      series: [],
    };
  }

  // Group by source and window, then by local calendar day. Rows arrive oldest
  // first, so the last row seen for a series carries its current duration.
  const bySeries = new Map<
    string,
    { bucketId: string; windowKind: string; label: string; days: Map<string, number[]> }
  >();
  for (const row of rows) {
    const source = sourceLabel(provider, row.sourceVersion);
    const key = [source ?? '', row.bucketId, row.windowKind].join('\u0000');
    const window = labelWindow({ ...row, resetsAt: null });
    const entry = bySeries.get(key) ?? {
      bucketId: row.bucketId,
      windowKind: row.windowKind,
      label: '',
      days: new Map<string, number[]>(),
    };
    entry.label = source ? `${window} (${source})` : window;
    const day = localDayKey(row.observedAt, config.timezone);
    const samples = entry.days.get(day) ?? [];
    samples.push(row.usedPercent);
    entry.days.set(day, samples);
    bySeries.set(key, entry);
  }

  // Two Codex buckets can both be "5 hour"; their own bucket name tells them
  // apart. Claude labels never collide, and its bucket ids are never shown.
  const labelCounts = new Map<string, number>();
  for (const { label } of bySeries.values()) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const series: QuotaSeries[] = [...bySeries.values()].map(
    ({ bucketId, windowKind, label, days }) => {
      return {
        bucketId,
        windowKind,
        label:
          provider !== 'claude' && (labelCounts.get(label) ?? 0) > 1
            ? `${label} · ${bucketId}`
            : label,
        points: [...days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, samples]) => ({
            day,
            // `latest` is the last sample of the day, which is the utilisation the
            // window actually ended at — not an average across a reset.
            latestPercent: samples[samples.length - 1] ?? 0,
            minPercent: Math.min(...samples),
            maxPercent: Math.max(...samples),
            samples: samples.length,
          })),
      };
    },
  );

  return {
    metric: 'quota_utilization',
    provider,
    range,
    availability: { available: true },
    series,
  };
}

/** Claude's two sources are named; every other provider has one source. */
function sourceLabel(provider: Provider, sourceVersion: string): string | null {
  if (provider !== 'claude') return null;
  return sourceVersion === CLAUDE_USAGE_SOURCE_VERSION ? 'usage poll' : 'status line';
}

export function buildCreditHistory(
  db: Db,
  config: AppConfig,
  provider: Provider,
  range: HistoryRange,
  now: Date = new Date(),
): CreditHistoryResult {
  // DeepSeek has no usage endpoint: its movement is a balance change, which can
  // be caused by a top-up just as easily as by spend.
  const metric = provider === 'openrouter' ? 'usage_delta' : 'balance_change';
  const since = startOfLocalDayNDaysAgoUtc(config.timezone, rangeDays(range), now);
  const sinceIso = since.toISOString();

  const rows = getCreditHistory(db, provider, sinceIso);
  const baseline = getCreditBaselineBefore(db, provider, sinceIso);

  const metricValue = (r: { totalUsage: MoneyString | null; totalBalance: MoneyString | null }) =>
    metric === 'usage_delta' ? r.totalUsage : r.totalBalance;

  // A balance is plotted as observed. A usage counter is plotted as usage since
  // the period began — the same quantity as the delta — so, like the delta, it
  // has nothing honest to show without a pre-period baseline.
  const series = rows.map((r) => ({
    observedAt: r.observedAt,
    currency: r.currency,
    value: metricValue(r),
  }));

  if (rows.length === 0) {
    return {
      metric,
      provider,
      range,
      availability: {
        available: false,
        reason: `No observation was recorded for this provider in the selected ${range} period.`,
      },
      deltas: [],
      series,
    };
  }

  // The delta is only honest with a reading from *before* the period began.
  if (baseline.length === 0) {
    return {
      metric,
      provider,
      range,
      availability: {
        available: false,
        reason:
          'Insufficient history: no observation exists from before this period, so a change cannot be computed. Collection needs to run across a full period boundary first.',
      },
      deltas: [],
      series: metric === 'usage_delta' ? [] : series,
    };
  }

  const baseByCurrency = new Map(baseline.map((b) => [b.currency, metricValue(b)]));

  const latestByCurrency = new Map<string, MoneyString | null>();
  // For a cumulative counter, only an increase is possible in normal operation;
  // any decrease between two consecutive readings means the counter restarted
  // upstream. Comparing only the endpoints would miss a reset that has already
  // climbed back above the baseline (10 → 80 → 5 → 20 reads as "+10").
  const resetByCurrency = new Set<string>();
  const previousByCurrency = new Map(baseByCurrency);
  const usageSeries: CreditHistoryResult['series'][number][] = [];
  for (const r of rows) {
    const value = metricValue(r);
    latestByCurrency.set(r.currency, value);
    if (value === null) continue;
    const previous = previousByCurrency.get(r.currency) ?? null;
    if (metric === 'usage_delta' && previous !== null && compareMoney(value, previous) < 0) {
      resetByCurrency.add(r.currency);
    }
    previousByCurrency.set(r.currency, value);

    // Past a reset the counter measures from an unknown origin, so the line
    // stops there, exactly as the delta refuses to span it.
    const from = baseByCurrency.get(r.currency) ?? null;
    if (from !== null && !resetByCurrency.has(r.currency)) {
      usageSeries.push({
        observedAt: r.observedAt,
        currency: r.currency,
        value: subtractMoney(value, from),
      });
    }
  }

  const deltas: CreditDelta[] = [...latestByCurrency.entries()].map(([currency, to]) => {
    const from = baseByCurrency.get(currency) ?? null;
    if (from === null || to === null) {
      return { currency, change: null, from, to, discontinuity: false };
    }
    const change = subtractMoney(to, from);
    const discontinuity = resetByCurrency.has(currency);
    return {
      currency,
      change: discontinuity ? null : change,
      from,
      to,
      discontinuity,
    };
  });

  return {
    metric,
    provider,
    range,
    availability: { available: true },
    deltas,
    series: metric === 'usage_delta' ? usageSeries : series,
  };
}
