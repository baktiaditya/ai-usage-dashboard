import { describe, expect, it } from 'vitest';
import { computeAdvisory } from '@/lib/advisory';
import type { StoredSnapshot } from '@/lib/db/repository';
import type { MoneyString } from '@/lib/money';
import { testConfig } from '../helpers/db';

const config = testConfig();

function quotaSnapshot(
  usedPercents: number[],
  extra: Partial<StoredSnapshot> = {},
): StoredSnapshot {
  return {
    id: 1,
    provider: 'codex',
    kind: 'quota',
    sourceObservedAt: '2026-09-12T12:00:00.000Z',
    collectedAt: '2026-09-12T12:00:00.000Z',
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    windows: usedPercents.map((usedPercent, i) => ({
      bucketId: 'codex',
      windowKind: i === 0 ? 'primary' : 'secondary',
      usedPercent,
      windowDurationMinutes: i === 0 ? 300 : 10080,
      resetsAt: null,
    })),
    balances: [],
    ...extra,
  };
}

function creditSnapshot(
  provider: 'deepseek' | 'openrouter',
  balances: {
    currency: string;
    totalBalance?: string;
    remainingCredit?: string;
    isAvailable?: boolean;
  }[],
): StoredSnapshot {
  return {
    id: 1,
    provider,
    kind: 'credit',
    sourceObservedAt: '2026-09-12T12:00:00.000Z',
    collectedAt: '2026-09-12T12:00:00.000Z',
    sourceVersion: 'x',
    schemaVersion: 1,
    usageAllowed: null,
    limitReachedCode: null,
    windows: [],
    balances: balances.map((b) => ({
      currency: b.currency,
      totalBalance: (b.totalBalance ?? null) as MoneyString | null,
      grantedBalance: null,
      toppedUpBalance: null,
      totalCredits: null,
      totalUsage: null,
      remainingCredit: (b.remainingCredit ?? null) as MoneyString | null,
      isAvailable: b.isAvailable ?? null,
    })),
  };
}

const healthy = (snapshot: StoredSnapshot) =>
  computeAdvisory({
    provider: snapshot.provider,
    status: 'healthy',
    snapshot,
    config,
    statusReason: 'fresh',
  });

describe('quota advisories', () => {
  it('is ok while every window is above the watch threshold', () => {
    const a = healthy(quotaSnapshot([40, 55]));
    expect(a.state).toBe('ok');
    expect(a.reasons).not.toHaveLength(0);
  });

  it('watches at exactly the boundary (<= 20% remaining)', () => {
    const a = healthy(quotaSnapshot([80]));
    expect(a.state).toBe('watch');
    expect(a.reasons[0]).toMatchObject({
      metric: 'quota_remaining_percent',
      observed: '20.0%',
      threshold: '<= 20%',
    });
  });

  it('suggests switching at exactly the switch boundary (<= 10% remaining)', () => {
    const a = healthy(quotaSnapshot([90]));
    expect(a.state).toBe('switch_suggested');
    expect(a.reasons[0]?.threshold).toBe('<= 10%');
  });

  it('lets the worst window decide the overall state', () => {
    const a = healthy(quotaSnapshot([95, 10]));
    expect(a.state).toBe('switch_suggested');
    // Both windows are named, so the reason is actionable.
    expect(a.reasons.some((r) => r.subject.includes('primary'))).toBe(true);
  });

  it('escalates on a backend cut-off regardless of percentages', () => {
    const a = healthy(quotaSnapshot([1, 1], { usageAllowed: false }));
    expect(a.state).toBe('switch_suggested');
    expect(a.reasons.some((r) => r.observed === 'usage not allowed')).toBe(true);
  });

  it('escalates on a reported rate-limit code', () => {
    const a = healthy(quotaSnapshot([2], { limitReachedCode: 'rate_limit_reached' }));
    expect(a.state).toBe('switch_suggested');
  });
});

describe('configured threshold overrides', () => {
  const tuned = testConfig({
    AUD_THRESHOLDS: JSON.stringify({
      quota: { 'codex:secondary': { watchAtOrBelowPercent: 50, switchAtOrBelowPercent: 30 } },
      balance: { 'deepseek:USD': { watchAtOrBelow: '50', switchAtOrBelow: '10' } },
    }),
  });

  it('applies a per-window quota threshold without changing the other windows', () => {
    // 60% and 45% remaining: fine under the default 20%, but the secondary
    // window was tuned to watch at 50%.
    const a = computeAdvisory({
      provider: 'codex',
      status: 'healthy',
      snapshot: quotaSnapshot([40, 55]),
      config: tuned,
      statusReason: '',
    });
    expect(a.state).toBe('watch');
    expect(a.reasons).toHaveLength(1);
    expect(a.reasons[0]).toMatchObject({ subject: 'codex:secondary', threshold: '<= 50%' });
  });

  it('applies an overridden balance threshold for its currency', () => {
    const a = computeAdvisory({
      provider: 'deepseek',
      status: 'healthy',
      snapshot: creditSnapshot('deepseek', [{ currency: 'USD', totalBalance: '40' }]),
      config: tuned,
      statusReason: '',
    });
    expect(a.state).toBe('watch');
    expect(a.reasons[0]?.threshold).toBe('<= 50.00 USD');
  });
});

describe('balance advisories', () => {
  it('applies per-currency thresholds without mixing USD and CNY', () => {
    // 20 CNY is above the CNY watch level of 35? No — it is below it, so it
    // watches; 20 USD is far above the USD watch level of 5, so it is ok.
    const cny = healthy(creditSnapshot('deepseek', [{ currency: 'CNY', totalBalance: '20' }]));
    const usd = healthy(creditSnapshot('deepseek', [{ currency: 'USD', totalBalance: '20' }]));
    expect(cny.state).toBe('watch');
    expect(usd.state).toBe('ok');
  });

  it('uses exact decimal comparison at the threshold boundary', () => {
    const at = healthy(creditSnapshot('openrouter', [{ currency: 'USD', remainingCredit: '5' }]));
    const just = healthy(
      creditSnapshot('openrouter', [{ currency: 'USD', remainingCredit: '5.000000000000001' }]),
    );
    expect(at.state).toBe('watch');
    expect(just.state).toBe('ok');
  });

  it('suggests switching on a negative remaining balance', () => {
    const a = healthy(creditSnapshot('openrouter', [{ currency: 'USD', remainingCredit: '-2.5' }]));
    expect(a.state).toBe('switch_suggested');
  });

  it('escalates when the provider says the balance is insufficient', () => {
    const a = healthy(
      creditSnapshot('deepseek', [{ currency: 'CNY', totalBalance: '500', isAvailable: false }]),
    );
    expect(a.state).toBe('switch_suggested');
  });

  it('reports an unconfigured currency instead of borrowing another threshold', () => {
    const a = healthy(creditSnapshot('deepseek', [{ currency: 'EUR', totalBalance: '0.01' }]));
    expect(a.state).toBe('ok');
    expect(a.reasons[0]?.message).toContain('No threshold is configured');
  });
});

describe('advisories never derive a recommendation from untrusted data', () => {
  it.each(['stale', 'error', 'unavailable'] as const)(
    'returns unknown when the card is %s',
    (status) => {
      const a = computeAdvisory({
        provider: 'codex',
        status,
        // A snapshot that would otherwise scream "switch".
        snapshot: quotaSnapshot([99]),
        config,
        statusReason: 'the last observation is too old',
      });
      expect(a.state).toBe('unknown');
      expect(a.reasons[0]?.metric).toBe('freshness');
      expect(a.reasons.every((r) => r.metric === 'freshness')).toBe(true);
    },
  );

  it('returns unknown when there is no snapshot at all', () => {
    const a = computeAdvisory({
      provider: 'claude',
      status: 'healthy',
      snapshot: undefined,
      config,
      statusReason: 'nothing collected',
    });
    expect(a.state).toBe('unknown');
  });
});

describe('determinism', () => {
  it('produces an identical result for identical inputs', () => {
    const snap = quotaSnapshot([85, 92]);
    const a = healthy(snap);
    const b = healthy(snap);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
