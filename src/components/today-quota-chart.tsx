'use client';

import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { QuotaTodayResult } from '@/lib/queries/history';
import { EndLabel, SERIES_COLORS, formatPercent } from '@/components/chart-parts';
import type { EndLabelProps } from '@/components/chart-parts';

/**
 * Today's utilisation per local hour, one line per window.
 *
 * Each point is the latest reading in that hour, the level the window stood at
 * when the hour closed. Quota is a gauge, so hours are never summed, and an
 * hour with no reading stays a gap rather than being drawn as zero. Series take
 * the same fixed slots as the history chart, so a window keeps its colour in
 * both places.
 */
export function TodayQuotaChart({
  provider,
  today,
}: {
  provider: string;
  today: QuotaTodayResult;
}) {
  if (!today.availability.available) {
    return (
      <p
        className="text-muted-foreground bg-surface-muted rounded-lg p-3 text-xs"
        data-testid={`today-empty-${provider}`}
      >
        {today.availability.reason}
      </p>
    );
  }

  const rows = today.hours.map(({ startsAt, label }) => {
    const row: Record<string, string | number | null> = { hour: label };
    for (const s of today.series) {
      const point = s.points.find((p) => p.startsAt === startsAt);
      row[s.windowKind] = point ? point.latestPercent : null;
    }
    return row;
  });
  // The last hour each series has a reading in is where its value label sits.
  const lastIndex = (windowKind: string) =>
    rows.reduce((last, row, i) => (row[windowKind] === null ? last : i), -1);
  // Source percentages are stored unclamped; a drifting reading above 100 must
  // stay on the plot rather than being cut off at the frame.
  const peak = Math.max(100, ...today.series.flatMap((s) => s.points.map((p) => p.latestPercent)));

  return (
    <figure className="flex flex-col gap-2" data-testid={`today-chart-${provider}`}>
      <figcaption className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Today</span>
        <span className="text-muted-foreground text-xs">
          Utilisation at the end of each hour. Quota is a gauge, so hours are never summed.
        </span>
      </figcaption>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* Right margin leaves room for the end-of-line value labels. */}
          <LineChart data={rows} margin={{ top: 8, right: 40, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="hour"
              interval="preserveStartEnd"
              minTickGap={24}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            <YAxis
              domain={[0, peak]}
              ticks={[0, 50, 100]}
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
              formatter={(value: unknown) => formatPercent(value)}
            />
            {today.series.map((s, i) => (
              <Line
                key={`${s.bucketId}:${s.windowKind}`}
                type="monotone"
                dataKey={s.windowKind}
                name={s.label}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                // An hour with no reading on either side draws no line segment,
                // so it gets a marker instead of vanishing. Early in the day that
                // is every point.
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const { cx, cy, index } = props;
                  const key = `${s.windowKind}-${index ?? 'x'}`;
                  if (cx === undefined || cy === undefined || index === undefined) {
                    return <g key={key} />;
                  }
                  const isolated =
                    (rows[index - 1]?.[s.windowKind] ?? null) === null &&
                    (rows[index + 1]?.[s.windowKind] ?? null) === null;
                  return isolated ? (
                    <circle
                      key={key}
                      cx={cx}
                      cy={cy}
                      r={4}
                      fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                  ) : (
                    <g key={key} />
                  );
                }}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey={s.windowKind}
                  content={(props: unknown) => (
                    <EndLabel {...(props as EndLabelProps)} lastIndex={lastIndex(s.windowKind)} />
                  )}
                />
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-3 text-xs" data-testid={`today-legend-${provider}`}>
        {today.series.map((s, i) => (
          <li key={`${s.bucketId}:${s.windowKind}`} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
            />
            {s.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}
