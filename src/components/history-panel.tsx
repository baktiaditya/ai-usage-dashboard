'use client';

import { Fragment, useEffect, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ProviderCard } from '@/lib/queries/overview';
import type { CreditHistoryResult, HistoryRange, QuotaHistoryResult } from '@/lib/queries/history';
import { formatMoney } from '@/lib/money';
import type { MoneyString } from '@/lib/money';
import { cn } from '@/lib/cn';

type HistoryResult = QuotaHistoryResult | CreditHistoryResult;

const RANGES: readonly { value: HistoryRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

/**
 * Categorical series slots, assigned in fixed order and never cycled.
 *
 * These resolve to CSS custom properties so the light and dark steps — each
 * validated against its own chart surface — swap in one place rather than being
 * flipped algorithmically. See `--series-*` in globals.css.
 */
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

export interface HistoryPanelProps {
  readonly cards: readonly ProviderCard[];
  readonly timezone: string;
}

export function HistoryPanel({ cards, timezone }: HistoryPanelProps) {
  const [provider, setProvider] = useState(cards[0]?.provider ?? 'codex');
  const [range, setRange] = useState<HistoryRange>('7d');

  /*
   * One state cell keyed by the request it answers. Loading is *derived* from
   * the key not yet matching, so the effect only ever calls setState from its
   * async continuation — setting it synchronously in the effect body would
   * trigger a second render pass on every selection change.
   */
  const requestKey = `${provider}:${range}`;
  const [fetched, setFetched] = useState<{
    key: string;
    provider: typeof provider;
    data: HistoryResult | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `${provider}:${range}`;

    fetch(`/api/history?provider=${provider}&range=${range}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as HistoryResult;
      })
      .then((result) => {
        if (!cancelled) setFetched({ key, provider, data: result, error: null });
      })
      .catch(() => {
        if (!cancelled) setFetched({ key, provider, data: null, error: 'Could not load history.' });
      });

    return () => {
      cancelled = true;
    };
  }, [provider, range]);

  const loading = fetched?.key !== requestKey;
  // While the next selection loads, the previous result stays on screen, dimmed.
  // Swapping it for a one-line placeholder collapsed the panel and grew it back,
  // which shortened the page for a moment and moved the reader's scroll position.
  const data = fetched?.data ?? null;
  const error = fetched?.error ?? null;

  // Labelled by the provider the shown result belongs to, not the one loading.
  const shownCard = cards.find((c) => c.provider === (fetched?.provider ?? provider));

  return (
    <Card data-testid="history-panel">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>History</CardTitle>
          <div className="flex flex-wrap gap-1" role="group" aria-label="History range">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setRange(r.value)}
                aria-pressed={range === r.value}
                data-testid={`range-${r.value}`}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-xs font-medium',
                  range === r.value
                    ? 'bg-accent-bg text-accent'
                    : 'text-muted-foreground hover:bg-surface-muted',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Provider">
          {cards.map((c) => (
            <button
              key={c.provider}
              type="button"
              onClick={() => setProvider(c.provider)}
              aria-pressed={provider === c.provider}
              data-testid={`history-provider-${c.provider}`}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs font-medium',
                provider === c.provider
                  ? 'bg-accent-bg text-accent'
                  : 'text-muted-foreground hover:bg-surface-muted',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {fetched === null ? (
          <p
            className="text-muted-foreground py-8 text-center text-sm"
            data-testid="history-loading"
          >
            Loading history…
          </p>
        ) : (
          <div
            className={cn('transition-opacity', loading && 'pointer-events-none opacity-50')}
            aria-busy={loading}
            data-testid="history-content"
          >
            {loading && (
              <p className="sr-only" role="status" data-testid="history-loading">
                Loading history…
              </p>
            )}
            {error ? (
              <p className="text-danger py-8 text-center text-sm" role="alert">
                {error}
              </p>
            ) : !data ? null : !data.availability.available ? (
              // Insufficient history is stated, never rendered as a zero line.
              <div
                className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-sm"
                data-testid="history-insufficient"
              >
                <p className="text-foreground mb-1 font-medium">Insufficient history</p>
                <p className="mx-auto max-w-prose text-xs">{data.availability.reason}</p>
              </div>
            ) : data.metric === 'quota_utilization' ? (
              <QuotaChart result={data} />
            ) : (
              <CreditSummary
                result={data}
                label={shownCard?.label ?? fetched.provider}
                timezone={timezone}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuotaChart({ result }: { result: QuotaHistoryResult }) {
  // Quota is a gauge: daily latest / min / max, never a sum.
  const days = [...new Set(result.series.flatMap((s) => s.points.map((p) => p.day)))].sort();
  const rows = days.map((day) => {
    const row: Record<string, string | number | [number, number]> = { day };
    for (const s of result.series) {
      const key = `${s.bucketId}:${s.windowKind}`;
      const point = s.points.find((p) => p.day === day);
      if (point) {
        row[`${key}:latest`] = point.latestPercent;
        row[`${key}:range`] = [point.minPercent, point.maxPercent];
      }
    }
    return row;
  });
  // Source percentages are stored unclamped, so a drifting reading above 100
  // must stay on the plot rather than being cut off at the frame.
  const peak = Math.max(100, ...result.series.flatMap((s) => s.points.map((p) => p.maxPercent)));

  return (
    <div className="flex flex-col gap-3" data-testid="history-quota-chart">
      <p className="text-muted-foreground text-xs">
        The line is the latest utilisation observed each day, per window; the shaded band spans that
        day&apos;s lowest to highest reading. Quota is a gauge that resets, so daily samples are
        shown as levels and never summed into a daily total.
      </p>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* Right margin leaves room for the end-of-line value labels. */}
          <ComposedChart data={rows} margin={{ top: 8, right: 44, bottom: 4, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
            <YAxis
              domain={[0, peak]}
              unit="%"
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--foreground)',
              }}
              formatter={(value: unknown) =>
                Array.isArray(value)
                  ? `${formatPercent(value[0])} – ${formatPercent(value[1])}`
                  : formatPercent(value)
              }
            />
            {result.series.map((s, i) => (
              <Fragment key={`${s.bucketId}:${s.windowKind}`}>
                <Area
                  type="monotone"
                  dataKey={`${s.bucketId}:${s.windowKind}:range`}
                  name={`${s.bucketId} · ${s.windowKind} daily min–max`}
                  stroke="none"
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fillOpacity={0.14}
                  activeDot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey={`${s.bucketId}:${s.windowKind}:latest`}
                  name={`${s.bucketId} · ${s.windowKind} latest`}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                >
                  {/*
                  Label only the final point. Two slots in the light palette sit
                  below 3:1 against a white surface, so the chart owes a visible
                  label rather than relying on the stroke colour alone — and the
                  latest utilisation is the number worth reading anyway.
                */}
                  <LabelList
                    dataKey={`${s.bucketId}:${s.windowKind}:latest`}
                    content={(props: unknown) => (
                      <EndLabel {...(props as EndLabelProps)} lastIndex={rows.length - 1} />
                    )}
                  />
                </Line>
              </Fragment>
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-3 text-xs">
        {result.series.map((s, i) => (
          <li key={`${s.bucketId}:${s.windowKind}`} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            {s.bucketId} · {s.windowKind}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreditSummary({
  result,
  label,
  timezone,
}: {
  result: CreditHistoryResult;
  label: string;
  timezone: string;
}) {
  const isUsage = result.metric === 'usage_delta';

  return (
    <div className="flex flex-col gap-4" data-testid="history-credit-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{isUsage ? 'Usage delta' : 'Balance change'}</Badge>
        <p className="text-muted-foreground text-xs">
          {isUsage
            ? `Change in ${label}'s cumulative usage counter over the period, measured against a baseline observed before it began.`
            : `Change in ${label}'s balance over the period. A balance moves on top-ups and expiring grants as well as spend, so this is not a usage figure.`}
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {result.deltas.map((d) => (
          <li
            key={d.currency}
            className="bg-surface-muted rounded-lg px-3 py-2.5"
            data-testid={`delta-${d.currency}`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide uppercase">{d.currency}</span>
              {d.discontinuity ? <Badge tone="stale">Counter reset</Badge> : null}
            </div>
            {d.discontinuity ? (
              <p className="text-muted-foreground text-xs">
                The cumulative counter decreased, which means it was reset upstream. A delta across
                that boundary would be meaningless, so none is shown.
              </p>
            ) : d.change === null ? (
              <p className="text-muted-foreground text-xs">No comparable baseline value.</p>
            ) : (
              <>
                <p className="tabular text-lg font-semibold">
                  {isUsage ? '+' : ''}
                  {formatMoney(d.change as never)}{' '}
                  <span className="text-muted-foreground text-xs font-normal">{d.currency}</span>
                </p>
                <p className="text-muted-foreground tabular mt-0.5 text-[11px]">
                  {formatMoney(d.from as never)} → {formatMoney(d.to as never)}
                </p>
              </>
            )}
          </li>
        ))}
      </ul>

      <CreditTrend result={result} timezone={timezone} />

      <p className="text-muted-foreground text-[11px]">
        Period boundaries follow {timezone}. Timestamps are stored in UTC and converted only for
        display.
      </p>
    </div>
  );
}

function formatPercent(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
}

/**
 * The observations behind the delta, one small chart per currency: usage since
 * the period began (measured from the same baseline as the delta), or a balance
 * as observed.
 *
 * Currencies are never drawn on a shared axis: 30 CNY and 15 USD are different
 * magnitudes, and a second y-scale would invite comparing them. Values are
 * converted to numbers only to position the line; every figure a reader sees
 * comes from the exact decimal string.
 */
function CreditTrend({ result, timezone }: { result: CreditHistoryResult; timezone: string }) {
  const isUsage = result.metric === 'usage_delta';
  const tick = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
  });
  const full = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const byCurrency = new Map<string, { t: number; value: number; exact: MoneyString }[]>();
  for (const p of result.series) {
    if (p.value === null) continue;
    const points = byCurrency.get(p.currency) ?? [];
    points.push({ t: Date.parse(p.observedAt), value: Number(p.value), exact: p.value });
    byCurrency.set(p.currency, points);
  }
  if (byCurrency.size === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {[...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, points]) => (
          <figure
            key={currency}
            className="flex flex-col gap-1"
            data-testid={`history-credit-trend-${currency}`}
          >
            <figcaption className="text-muted-foreground text-xs">
              {currency} {isUsage ? 'usage since the period began' : 'balance as observed'}
            </figcaption>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t: number) => tick.format(t)}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  />
                  <YAxis
                    width={48}
                    domain={['auto', 'auto']}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'var(--foreground)',
                    }}
                    labelFormatter={(t: unknown) => full.format(Number(t))}
                    formatter={(_value: unknown, _name: unknown, item: { payload?: unknown }) => [
                      `${formatMoney((item.payload as { exact: MoneyString }).exact)} ${currency}`,
                      isUsage ? 'Usage since period start' : 'Balance',
                    ]}
                  />
                  <Line
                    type="linear"
                    dataKey="value"
                    name={currency}
                    stroke="var(--series-1)"
                    strokeWidth={2}
                    dot={
                      points.length <= 12
                        ? { r: 4, strokeWidth: 0, fill: 'var(--series-1)' }
                        : false
                    }
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </figure>
        ))}
    </div>
  );
}

/** Recharts' label content props, narrowed to what this renderer reads. */
interface EndLabelProps {
  x?: number | string;
  y?: number | string;
  value?: unknown;
  index?: number;
  lastIndex: number;
}

/**
 * Renders a value label at the last point of a line only.
 *
 * Recharts hands every point to the label content renderer, so the index check
 * is what keeps this a *selective* direct label rather than a number on every
 * point.
 */
function EndLabel(props: EndLabelProps) {
  const { x, y, value, index, lastIndex } = props;
  if (index !== lastIndex || value === null || value === undefined) return null;
  if (x === undefined || y === undefined) return null;
  // Recharts types `value` loosely (it also carries renderable nodes); only a
  // finite number is a utilisation reading worth drawing.
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return (
    <text
      x={Number(x) + 6}
      y={Number(y)}
      dy={4}
      // Text wears text ink, never the series colour; the stroke beside it
      // carries identity.
      fill="var(--muted-foreground)"
      fontSize={11}
      textAnchor="start"
    >
      {`${Math.round(numeric)}%`}
    </text>
  );
}
