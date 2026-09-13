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

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localParts(timezone: string, at: Date): LocalDate & { readonly wallClockAsUtc: number } {
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
  const year = Number(parts['year']);
  const month = Number(parts['month']);
  const day = Number(parts['day']);
  const wallClockAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number(parts['hour']) === 24 ? 0 : Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return { year, month, day, wallClockAsUtc };
}

/** How far the zone's wall clock is ahead of UTC at `at`, to the second. */
function offsetAt(timezone: string, at: Date): number {
  const whole = Math.floor(at.getTime() / 1000) * 1000;
  return localParts(timezone, new Date(whole)).wallClockAsUtc - whole;
}

/**
 * The UTC instant of 00:00 on a local calendar date.
 *
 * The offset must be the one in force *at that midnight*, not at the moment of
 * the query: on a DST transition day they differ by an hour. The first guess
 * uses the offset at UTC midnight of the same date; one refinement with the
 * offset at the guessed instant settles it on either side of a transition.
 */
function localMidnightUtc(timezone: string, date: LocalDate): Date {
  const midnightAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  const guess = midnightAsUtc - offsetAt(timezone, new Date(midnightAsUtc));
  return new Date(midnightAsUtc - offsetAt(timezone, new Date(guess)));
}

/**
 * Start of the local calendar day, returned as a UTC instant.
 *
 * Uses `Intl` parts rather than string slicing so DST and non-hour offsets
 * behave. The result is what history queries compare against.
 */
export function startOfLocalDayUtc(timezone: string, at: Date = new Date()): Date {
  return localMidnightUtc(timezone, localParts(timezone, at));
}

/**
 * Start of the local day `days` calendar days ago, as a UTC instant.
 *
 * Steps back whole calendar days, never `days × 24h`: a range that crosses a
 * DST transition contains one 23- or 25-hour day.
 */
export function startOfLocalDayNDaysAgoUtc(
  timezone: string,
  days: number,
  at: Date = new Date(),
): Date {
  const today = localParts(timezone, at);
  // Date.UTC normalises an out-of-range day into the correct month and year.
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day - days));
  return localMidnightUtc(timezone, {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
  });
}
