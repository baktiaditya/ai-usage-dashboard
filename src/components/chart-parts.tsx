/**
 * Pieces shared by every quota chart: the categorical slots, percent
 * formatting, and the end-of-line value label.
 */

/**
 * Categorical series slots, assigned in fixed order and never cycled.
 *
 * These resolve to CSS custom properties so the light and dark steps — each
 * validated against its own chart surface — swap in one place rather than being
 * flipped algorithmically. See `--series-*` in globals.css.
 */
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
];

export function formatPercent(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
}

export interface EndLabelProps {
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
export function EndLabel(props: EndLabelProps) {
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
