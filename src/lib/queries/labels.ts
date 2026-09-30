/**
 * Window labels, shared by the overview and the history queries.
 *
 * It lives apart from both so that neither query module imports the other.
 */
import type { QuotaWindow } from '../domain';

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 hour',
  seven_day: '7 day',
  spend_limit: 'Spend limit',
  primary: 'Primary',
  secondary: 'Secondary',
  // OpenCode Go's billing month runs from the subscription anniversary, so it
  // has no fixed duration to label from.
  monthly: 'Monthly',
};

/**
 * Label a window from what it *is*, never from where it sat in an array.
 *
 * Codex reports a duration in minutes, so 300 becomes "5 hour" wherever it
 * appears; Claude names its buckets directly. A positional label would silently
 * mislabel every window the day a provider reorders them.
 */
export function labelWindow(w: QuotaWindow): string {
  const byKind = WINDOW_LABELS[w.windowKind];
  const minutes = w.windowDurationMinutes;
  if (minutes !== null && minutes !== undefined) {
    // 10080 minutes is 7 days, 300 minutes is 5 hours — both fall out of plain
    // division, so no provider-specific special case is needed.
    if (minutes % 1440 === 0) return `${minutes / 1440} day`;
    if (minutes % 60 === 0) return `${minutes / 60} hour`;
    return `${minutes} min`;
  }
  return byKind ?? w.windowKind;
}
