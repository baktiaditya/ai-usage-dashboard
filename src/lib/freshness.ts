/**
 * Freshness and card status, derived at query time.
 *
 * None of this is stored. Card status depends on the current clock and on
 * configurable thresholds, so a persisted copy would be wrong the moment either
 * moved — and it would quietly claim a two-day-old number was healthy.
 *
 * Precedence, per the plan:
 *   1. the latest attempt failed              -> `error`
 *   2. the source is unconfigured / never seen -> `unavailable`
 *   3. the observation is past its freshness    -> `stale`
 *   4. otherwise                                -> `healthy`
 *
 * `error` and `unavailable` still carry the last known values so the user can
 * see what was true before the failure — clearly labelled with its age.
 */
import type { AppConfig } from './config';
import { CLAUDE_PROBE_SOURCE_VERSION } from './domain';
import type { CardStatus, Provider } from './domain';
import type { StoredAttempt, StoredSnapshot } from './db/repository';
import { ageMs, hasPassed } from './time';

/**
 * Providers the collector always polls. Claude is not one of them: its spool is
 * event-driven and has its own budget, and only an observation from the
 * optional quota probe is judged as a pull. Adding `claude` here would silently
 * shorten how long a spool-only install stays fresh.
 */
const PULL_PROVIDERS: ReadonlySet<Provider> = new Set(['codex', 'deepseek', 'openrouter']);

export interface FreshnessInput {
  readonly provider: Provider;
  readonly snapshot: StoredSnapshot | undefined;
  readonly attempt: StoredAttempt | undefined;
  readonly config: AppConfig;
  readonly now?: Date;
}

export interface FreshnessResult {
  readonly status: CardStatus;
  /** Age of the *source observation*, not of our collection attempt. */
  readonly dataAgeMs: number | null;
  /** Why the status is what it is, safe to render. */
  readonly reason: string;
  /** True when a quota window reset without a newer observation arriving. */
  readonly resetPassedWithoutObservation: boolean;
}

/**
 * How old an observation may be before it is stale. Keyed on the source as well
 * as the provider, because one Claude card can hold a spool event in one run
 * and a polled reading in the next. `sourceVersion` is the stored snapshot's,
 * or `null` when there is none.
 */
export function maxAgeMs(
  provider: Provider,
  sourceVersion: string | null,
  config: AppConfig,
): number {
  const polled = provider === 'claude' && sourceVersion === CLAUDE_PROBE_SOURCE_VERSION;
  if (PULL_PROVIDERS.has(provider) || polled) {
    return config.freshness.pullMissedIntervals * config.collectIntervalMinutes * 60_000;
  }
  return config.freshness.claudeEventMaxAgeMinutes * 60_000;
}

export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const now = input.now ?? new Date();
  const { snapshot, attempt, provider, config } = input;

  // 1. A failed attempt dominates: the number on screen, if any, is historical.
  if (attempt?.outcome === 'error') {
    return {
      status: 'error',
      dataAgeMs: snapshot ? ageMs(snapshot.sourceObservedAt, now) : null,
      reason: attempt.safeMessage ?? 'the most recent collection attempt failed',
      resetPassedWithoutObservation: false,
    };
  }

  // 2. Nothing configured, or nothing ever collected.
  if (attempt?.outcome === 'unavailable') {
    return {
      status: 'unavailable',
      dataAgeMs: snapshot ? ageMs(snapshot.sourceObservedAt, now) : null,
      reason: attempt.safeMessage ?? 'this source is not available yet',
      resetPassedWithoutObservation: false,
    };
  }
  if (!snapshot) {
    return {
      status: 'unavailable',
      dataAgeMs: null,
      reason: 'no observation has been collected yet',
      resetPassedWithoutObservation: false,
    };
  }

  const age = ageMs(snapshot.sourceObservedAt, now);
  const limit = maxAgeMs(provider, snapshot.sourceVersion, config);

  // 3a. A quota window that has already reset makes the stored percentage
  //     meaningless: the real value is whatever accrued since the reset, and we
  //     have not observed that yet.
  const resetPassed =
    snapshot.kind === 'quota' &&
    snapshot.windows.some((w) => w.resetsAt !== null && hasPassed(w.resetsAt, now));

  if (resetPassed) {
    return {
      status: 'stale',
      dataAgeMs: age,
      reason: 'a quota window reset after this observation; the displayed usage predates the reset',
      resetPassedWithoutObservation: true,
    };
  }

  // 3b. Ordinary age-based staleness.
  if (age > limit) {
    return {
      status: 'stale',
      dataAgeMs: age,
      reason: `the last observation is older than the ${Math.round(limit / 60_000)} minute freshness budget`,
      resetPassedWithoutObservation: false,
    };
  }

  return {
    status: 'healthy',
    dataAgeMs: age,
    reason: 'collected recently and within the freshness budget',
    resetPassedWithoutObservation: false,
  };
}
