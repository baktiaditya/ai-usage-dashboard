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

/** An ISO-8601 instant with an explicit `Z` or `±HH:MM` offset. */
export const ISO_8601_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Is this an instant that actually exists?
 *
 * `Date.parse` is not enough on its own: it silently rolls an impossible
 * calendar date forward, so `2026-02-31T00:00:00Z` becomes 3 March and passes.
 * A reset time that moves three days when it is read is worse than one that is
 * rejected. Validate the written calendar components before parsing, without
 * comparing its local date to UTC — a legitimate offset may cross midnight.
 */
export function isRealInstant(value: string): boolean {
  const match = ISO_8601_INSTANT.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] ? Number(match[9]) : 0;
  const offsetMinute = match[8] ? Number(match[10]) : 0;

  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  return !Number.isNaN(Date.parse(value));
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

const HOUR_MS = 3_600_000;

function dateKey(date: LocalDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

/**
 * The first UTC instant whose local calendar date is `date`.
 *
 * Usually 00:00, but not when a transition skips midnight itself (Havana,
 * Santiago and the Azores spring forward from 00:00 to 01:00): then the day
 * begins at the transition. Every zone offset lies within ±14h, so the local
 * date is still the previous one 15h before UTC midnight and already reached
 * 15h after it; a binary search at one-second resolution — transitions fall on
 * whole seconds — finds the boundary exactly.
 */
function firstInstantOfLocalDate(timezone: string, date: LocalDate, midnightAsUtc: number): Date {
  const target = dateKey(date);
  let before = midnightAsUtc - 15 * HOUR_MS;
  let reached = midnightAsUtc + 15 * HOUR_MS;
  while (reached - before > 1000) {
    const mid = Math.floor((before + reached) / 2000) * 1000;
    if (dateKey(localParts(timezone, new Date(mid))) >= target) reached = mid;
    else before = mid;
  }
  return new Date(reached);
}

/**
 * The UTC instant at which a local calendar date begins.
 *
 * The offset must be the one in force *at that midnight*, not at the moment of
 * the query: on a DST transition day they differ by an hour. The first guess
 * uses the offset at UTC midnight of the same date; one refinement with the
 * offset at the guessed instant settles it on either side of a transition. If
 * the result does not read 00:00 on that date, midnight does not exist there
 * and the day starts at the transition instead.
 */
function localMidnightUtc(timezone: string, date: LocalDate): Date {
  const midnightAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  const guess = midnightAsUtc - offsetAt(timezone, new Date(midnightAsUtc));
  const refined = midnightAsUtc - offsetAt(timezone, new Date(guess));
  if (localParts(timezone, new Date(refined)).wallClockAsUtc === midnightAsUtc) {
    return new Date(refined);
  }
  return firstInstantOfLocalDate(timezone, date, midnightAsUtc);
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
