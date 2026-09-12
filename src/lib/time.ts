/**
 * Time handling.
 *
 * Everything is stored and compared in UTC. The configured timezone is applied
 * only when a *calendar* boundary is needed — "today" in the history view —
 * because that is the one question whose answer depends on where the user is.
 */

/** Unix epoch seconds -> UTC ISO-8601, or `null` for absent/invalid input. */
export function epochSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isFinite(seconds)) return null;
  const ms = seconds * 1000;
  // Reject values outside a sane window rather than emitting "Invalid Date".
  if (ms < 0 || ms > 4102444800000) return null; // > year 2100
  return new Date(ms).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoToEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Age of an observation in milliseconds, clamped at zero for clock skew. */
export function ageMs(iso: string, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - isoToEpochMs(iso));
}

/** `true` when `iso` is strictly in the past. `null` input is never "passed". */
export function hasPassed(iso: string | null, now: Date = new Date()): boolean {
  if (iso === null) return false;
  return isoToEpochMs(iso) <= now.getTime();
}

/** Compact, locale-independent age string for the UI: `4m`, `2h 5m`, `3d`. */
export function formatAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/**
 * Start of the local calendar day, returned as a UTC instant.
 *
 * Uses `Intl` parts rather than string slicing so DST and non-hour offsets
 * behave. The result is what history queries compare against.
 */
export function startOfLocalDayUtc(timezone: string, at: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const localMidnightAsUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
  );
  // How far the zone is ahead of UTC at this instant.
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) === 24 ? 0 : Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  const offsetMs = asUtc - at.getTime();
  return new Date(localMidnightAsUtc - offsetMs);
}

/** Start of the local day `days` days ago, as a UTC instant. */
export function startOfLocalDayNDaysAgoUtc(
  timezone: string,
  days: number,
  at: Date = new Date(),
): Date {
  const todayStart = startOfLocalDayUtc(timezone, at);
  return new Date(todayStart.getTime() - days * 86_400_000);
}
