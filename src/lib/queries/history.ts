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
import type { Provider } from '../domain';
import type { Db } from '../db/client';
import { getCreditBaselineBefore, getCreditHistory, getQuotaHistory } from '../db/repository';
import type { QuotaHistoryPoint } from '../db/repository';
import type { MoneyString } from '../money';
import { compareMoney, subtractMoney } from '../money';
import { localHoursBetween, startOfLocalDayNDaysAgoUtc, startOfLocalHourUtc } from '../time';
import { labelWindow } from './labels';

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
   * What the chart shows for this series: the window's label, never its raw
   * bucket or kind. A Claude window is one series whichever source observed it,
   * because the status line and the quota probe report the same headers.
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

interface GroupedSeries {
  readonly key: string;
  readonly bucketId: string;
  readonly windowKind: string;
  readonly label: string;
  /** Samples per bucket key, oldest first, sorted by key. */
  readonly buckets: readonly (readonly [string, number[]])[];
}

/**
 * Group quota rows by window, then by `keyOf` (a local day or hour). Rows
 * arrive oldest first, so the last row seen for a series carries its current
 * duration and each bucket's last sample is the latest reading in it.
 */
function groupQuotaSeries(
  provider: Provider,
  rows: readonly QuotaHistoryPoint[],
  keyOf: (observedAt: string) => string,
): GroupedSeries[] {
  const bySeries = new Map<
    string,
    { bucketId: string; windowKind: string; label: string; buckets: Map<string, number[]> }
  >();
  for (const row of rows) {
    const key = [row.bucketId, row.windowKind].join('\u0000');
    const entry = bySeries.get(key) ?? {
      bucketId: row.bucketId,
      windowKind: row.windowKind,
      label: '',
      buckets: new Map<string, number[]>(),
    };
    entry.label = labelWindow({ ...row, resetsAt: null });
    const bucket = keyOf(row.observedAt);
    const samples = entry.buckets.get(bucket) ?? [];
    samples.push(row.usedPercent);
    entry.buckets.set(bucket, samples);
    bySeries.set(key, entry);
  }

  // Two Codex buckets can both be "5 hour"; their own bucket name tells them
  // apart. Claude's window labels are unique, so its bucket ids are never shown.
  const labelCounts = new Map<string, number>();
  for (const { label } of bySeries.values()) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  return [...bySeries.entries()].map(([key, { bucketId, windowKind, label, buckets }]) => ({
    key,
    bucketId,
    windowKind,
    label:
      provider !== 'claude' && (labelCounts.get(label) ?? 0) > 1 ? `${label} · ${bucketId}` : label,
    buckets: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }));
}

/**
 * `latest` is the last sample in the bucket, which is the utilisation the
 * window actually ended at — not an average across a reset.
 */
function summarise(samples: readonly number[]) {
  return {
    latestPercent: samples[samples.length - 1] ?? 0,
    minPercent: Math.min(...samples),
    maxPercent: Math.max(...samples),
    samples: samples.length,
  };
}

export interface QuotaTodayPoint {
  /** The UTC instant the local hour began, matching one of `hours`. */
  readonly startsAt: string;
  readonly latestPercent: number;
  readonly minPercent: number;
  readonly maxPercent: number;
  readonly samples: number;
}

export interface QuotaTodaySeries {
  readonly bucketId: string;
  readonly windowKind: string;
  readonly label: string;
  readonly points: readonly QuotaTodayPoint[];
}

export interface QuotaTodayHour {
  /** The UTC instant the local hour began, unique even in a repeated hour. */
  readonly startsAt: string;
  /** The local clock hour, such as `9:00`; a repeated hour names its zone. */
  readonly label: string;
}

export interface QuotaTodayResult {
  readonly availability: Availability;
  /** Every local hour from midnight to the one `now` falls in, oldest first. */
  readonly hours: readonly QuotaTodayHour[];
  readonly series: readonly QuotaTodaySeries[];
}

/**
 * Label each hour by its local clock. When the clocks go back the same hour
 * happens twice, so both occurrences carry their zone name (`1:00 EDT`,
 * `1:00 EST`) to stay distinguishable.
 */
function labelHours(hours: readonly Date[], timezone: string): QuotaTodayHour[] {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' });
  const clocks = hours.map((h) => `${Number(clock.format(h))}:00`);
  const repeated = new Set(clocks.filter((c, i) => clocks.indexOf(c) !== i));
  return hours.map((h, i) => {
    const label = clocks[i]!;
    const zoneName = zone.formatToParts(h).find((p) => p.type === 'timeZoneName')?.value;
    return {
      startsAt: h.toISOString(),
      label: repeated.has(label) && zoneName ? `${label} ${zoneName}` : label,
    };
  });
}

/**
 * Today's quota readings per local hour, for the card's intraday chart.
 *
 * The collector samples every few minutes, so an hour usually holds several
 * readings. Like the daily history, each hour keeps latest / min / max and is
 * never summed: a gauge that resets mid-hour would otherwise add up to a
 * number no window ever reached. Hours are keyed by the instant they began, so
 * the two occurrences of a repeated hour stay separate.
 */
export function buildQuotaToday(
  db: Db,
  config: AppConfig,
  provider: Provider,
  now: Date = new Date(),
): QuotaTodayResult {
  const since = startOfLocalDayNDaysAgoUtc(config.timezone, 0, now);
  const rows = getQuotaHistory(db, provider, since.toISOString());
  const hours = labelHours(localHoursBetween(config.timezone, since, now), config.timezone);

  if (rows.length === 0) {
    return {
      availability: { available: false, reason: 'No quota observation was recorded today.' },
      hours,
      series: [],
    };
  }

  const series = groupQuotaSeries(provider, rows, (iso) =>
    startOfLocalHourUtc(config.timezone, new Date(iso)).toISOString(),
  ).map(({ key: _key, buckets, ...rest }) => ({
    ...rest,
    points: buckets.map(([startsAt, samples]) => ({ startsAt, ...summarise(samples) })),
  }));

  return { availability: { available: true }, hours, series };
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

  const series: QuotaSeries[] = groupQuotaSeries(provider, rows, (iso) =>
    localDayKey(iso, config.timezone),
  ).map(({ key: _key, buckets, ...rest }) => ({
    ...rest,
    points: buckets.map(([day, samples]) => ({ day, ...summarise(samples) })),
  }));

  return {
    metric: 'quota_utilization',
    provider,
    range,
    availability: { available: true },
    series,
  };
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
