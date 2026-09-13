/**
 * Deterministic switch advisories.
 *
 * The dashboard never routes traffic; it only says "this provider is worth
 * looking at". Two properties make that trustworthy:
 *
 *   - **Determinism.** The same snapshot plus the same thresholds always yields
 *     the same state, and every state carries the reasons and the exact
 *     threshold that fired.
 *   - **No recommendation from stale data.** If the card is not `healthy`, the
 *     advisory is `unknown`. A `switch_suggested` computed from a two-day-old
 *     percentage would be a guess wearing the costume of a fact.
 */
import type { AppConfig } from '../config';
import type { Advisory, AdvisoryReason, CardStatus, Provider } from '../domain';
import type { StoredSnapshot } from '../db/repository';
import { compareMoney, formatMoney, toMoney } from '../money';

/** Ranked so the worst finding decides the overall state. */
const SEVERITY: Record<Advisory['state'], number> = {
  ok: 0,
  watch: 1,
  switch_suggested: 2,
  unknown: 3,
};

function worst(a: Advisory['state'], b: Advisory['state']): Advisory['state'] {
  // `unknown` is not "worse" than `switch_suggested` for escalation purposes;
  // it simply means we cannot tell. It is only produced wholesale, above.
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export interface AdvisoryInput {
  readonly provider: Provider;
  readonly status: CardStatus;
  readonly snapshot: StoredSnapshot | undefined;
  readonly config: AppConfig;
  readonly statusReason: string;
}

export function computeAdvisory(input: AdvisoryInput): Advisory {
  const { provider, status, snapshot, config } = input;

  // Rule zero: anything but a healthy card yields `unknown`, never a numeric
  // recommendation derived from an old value.
  if (status !== 'healthy' || !snapshot) {
    return {
      state: 'unknown',
      reasons: [
        {
          subject: provider,
          metric: 'freshness',
          observed: status,
          threshold: null,
          message: `No recommendation: data is ${status}. ${input.statusReason}`,
        },
      ],
    };
  }

  return snapshot.kind === 'quota'
    ? quotaAdvisory(provider, snapshot, config)
    : creditAdvisory(provider, snapshot, config);
}

/**
 * The most specific configured threshold for a quota window: the exact window,
 * then the window kind for the provider, then the provider, then `default`.
 */
function quotaThresholdsFor(
  config: AppConfig,
  provider: Provider,
  window?: { readonly bucketId: string; readonly windowKind: string },
) {
  const keys = window
    ? [`${provider}:${window.bucketId}:${window.windowKind}`, `${provider}:${window.windowKind}`]
    : [];
  for (const key of [...keys, provider, 'default']) {
    const threshold = config.thresholds.quota[key];
    if (threshold) return threshold;
  }
  return { watchAtOrBelowPercent: 20, switchAtOrBelowPercent: 10 };
}

function quotaAdvisory(provider: Provider, snapshot: StoredSnapshot, config: AppConfig): Advisory {
  const providerThreshold = quotaThresholdsFor(config, provider);
  const reasons: AdvisoryReason[] = [];
  let state: Advisory['state'] = 'ok';

  // A provider-reported hard block outranks any percentage: the backend has
  // already said ordinary usage is not permitted.
  if (snapshot.usageAllowed === false) {
    state = 'switch_suggested';
    reasons.push({
      subject: provider,
      metric: 'quota_remaining_percent',
      observed: 'usage not allowed',
      threshold: null,
      message: 'The provider reports that ordinary included usage is currently not allowed.',
    });
  }
  if (snapshot.limitReachedCode) {
    state = 'switch_suggested';
    reasons.push({
      subject: provider,
      metric: 'quota_remaining_percent',
      observed: snapshot.limitReachedCode,
      threshold: null,
      message: `The provider reports a rate limit condition: ${snapshot.limitReachedCode}.`,
    });
  }

  for (const w of snapshot.windows) {
    const t = quotaThresholdsFor(config, provider, w);
    const remaining = clampPercent(100 - w.usedPercent);
    const subject = `${w.bucketId}:${w.windowKind}`;
    if (remaining <= t.switchAtOrBelowPercent) {
      state = worst(state, 'switch_suggested');
      reasons.push({
        subject,
        metric: 'quota_remaining_percent',
        observed: `${remaining.toFixed(1)}%`,
        threshold: `<= ${t.switchAtOrBelowPercent}%`,
        message: `Only ${remaining.toFixed(1)}% of this window remains (switch threshold ${t.switchAtOrBelowPercent}%).`,
      });
    } else if (remaining <= t.watchAtOrBelowPercent) {
      state = worst(state, 'watch');
      reasons.push({
        subject,
        metric: 'quota_remaining_percent',
        observed: `${remaining.toFixed(1)}%`,
        threshold: `<= ${t.watchAtOrBelowPercent}%`,
        message: `${remaining.toFixed(1)}% of this window remains (watch threshold ${t.watchAtOrBelowPercent}%).`,
      });
    }
  }

  if (reasons.length === 0) {
    reasons.push({
      subject: provider,
      metric: 'quota_remaining_percent',
      observed: 'all windows above thresholds',
      threshold: `> ${providerThreshold.watchAtOrBelowPercent}%`,
      message: 'Every quota window is above the watch threshold.',
    });
  }

  return { state, reasons };
}

function creditAdvisory(provider: Provider, snapshot: StoredSnapshot, config: AppConfig): Advisory {
  const reasons: AdvisoryReason[] = [];
  let state: Advisory['state'] = 'ok';

  for (const balance of snapshot.balances) {
    // Thresholds are keyed per provider *and* currency: 20 CNY and 20 USD are
    // not the same amount of runway, so they never share a limit.
    const key = `${provider}:${balance.currency}`;
    const threshold = config.thresholds.balance[key];

    // DeepSeek exposes a balance; OpenRouter exposes remaining credit. Both are
    // "money left", which is what a threshold applies to.
    const amount = balance.remainingCredit ?? balance.totalBalance;

    if (amount === null) {
      state = worst(state, 'unknown');
      reasons.push({
        subject: balance.currency,
        metric: 'balance_remaining',
        observed: 'unavailable',
        threshold: null,
        message: `No remaining-balance figure was reported for ${balance.currency}.`,
      });
      continue;
    }

    if (!threshold) {
      // An unconfigured currency is reported, not silently judged against a
      // threshold borrowed from a different currency.
      reasons.push({
        subject: balance.currency,
        metric: 'balance_remaining',
        observed: formatMoney(amount),
        threshold: null,
        message: `No threshold is configured for ${key}; ${balance.currency} is shown without a recommendation.`,
      });
      continue;
    }

    const watch = toMoney(threshold.watchAtOrBelow);
    const stop = toMoney(threshold.switchAtOrBelow);

    if (compareMoney(amount, stop) <= 0) {
      state = worst(state, 'switch_suggested');
      reasons.push({
        subject: balance.currency,
        metric: 'balance_remaining',
        observed: formatMoney(amount),
        threshold: `<= ${formatMoney(stop)} ${balance.currency}`,
        message: `${formatMoney(amount)} ${balance.currency} remaining is at or below the switch threshold.`,
      });
    } else if (compareMoney(amount, watch) <= 0) {
      state = worst(state, 'watch');
      reasons.push({
        subject: balance.currency,
        metric: 'balance_remaining',
        observed: formatMoney(amount),
        threshold: `<= ${formatMoney(watch)} ${balance.currency}`,
        message: `${formatMoney(amount)} ${balance.currency} remaining is at or below the watch threshold.`,
      });
    }

    if (balance.isAvailable === false) {
      state = worst(state, 'switch_suggested');
      reasons.push({
        subject: balance.currency,
        metric: 'balance_remaining',
        observed: 'not available',
        threshold: null,
        message: 'The provider reports the balance is not sufficient for API calls.',
      });
    }
  }

  if (reasons.length === 0) {
    reasons.push({
      subject: provider,
      metric: 'balance_remaining',
      observed: 'above thresholds',
      threshold: null,
      message: 'Every reported balance is above its configured watch threshold.',
    });
  }

  return { state, reasons };
}

function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}
