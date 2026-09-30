import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOverview, findEndedWindows, labelWindow } from '@/lib/queries/overview';
import { buildCreditHistory, buildQuotaHistory, buildQuotaToday } from '@/lib/queries/history';
import { recordAttempt, startRun } from '@/lib/db/repository';
import { CLAUDE_PROBE_SOURCE_VERSION } from '@/lib/domain';
import type { CreditSnapshot, Provider, QuotaSnapshot } from '@/lib/domain';
import type { MoneyString } from '@/lib/money';
import { createTestDb, testConfig } from '../helpers/db';
import type { TestDb } from '../helpers/db';

let t: TestDb;
const config = testConfig();
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function writeQuota(
  provider: Provider,
  observedAt: string,
  usedPercents: [number, number] = [37, 52],
) {
  const snap: QuotaSnapshot = {
    kind: 'quota',
    provider,
    observedAt,
    collectedAt: observedAt,
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    sourceEventId: null,
    windows: [
      {
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: usedPercents[0],
        windowDurationMinutes: 300,
        resetsAt: '2026-09-12T17:00:00.000Z',
      },
      {
        bucketId: 'codex',
        windowKind: 'secondary',
        usedPercent: usedPercents[1],
        windowDurationMinutes: 10080,
        resetsAt: '2026-09-19T00:00:00.000Z',
      },
    ],
  };
  return recordAttempt(t.db, {
    runId: startRun(t.db, 'scheduled'),
    provider,
    startedAt: observedAt,
    finishedAt: observedAt,
    retryCount: 0,
    result: { outcome: 'success', snapshot: snap },
  });
}

function writeCredit(provider: Provider, observedAt: string, credits: string, usage: string) {
  const snap: CreditSnapshot = {
    kind: 'credit',
    provider,
    observedAt,
    collectedAt: observedAt,
    sourceVersion: 'openrouter-api/v1-credits',
    schemaVersion: 1,
    sourceEventId: null,
    balances: [
      {
        currency: 'USD',
        totalBalance: provider === 'deepseek' ? (credits as MoneyString) : null,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits: provider === 'openrouter' ? (credits as MoneyString) : null,
        totalUsage: provider === 'openrouter' ? (usage as MoneyString) : null,
        remainingCredit: null,
        isAvailable: null,
      },
    ],
  };
  return recordAttempt(t.db, {
    runId: startRun(t.db, 'scheduled'),
    provider,
    startedAt: observedAt,
    finishedAt: observedAt,
    retryCount: 0,
    result: { outcome: 'success', snapshot: snap },
  });
}

function writeFailure(
  provider: Provider,
  code: string,
  outcome: 'error' | 'unavailable',
  at: string,
) {
  return recordAttempt(t.db, {
    runId: startRun(t.db, 'scheduled'),
    provider,
    startedAt: at,
    finishedAt: at,
    retryCount: 0,
    result: {
      outcome,
      failure: {
        provider,
        attemptedAt: at,
        code: code as never,
        safeMessage: `simulated ${code}`,
        retryable: false,
      },
    },
  });
}

describe('window labelling', () => {
  it('labels from the reported duration, never from array position', () => {
    expect(
      labelWindow({
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: 0,
        windowDurationMinutes: 300,
        resetsAt: null,
      }),
    ).toBe('5 hour');
    expect(
      labelWindow({
        bucketId: 'codex',
        windowKind: 'secondary',
        usedPercent: 0,
        windowDurationMinutes: 10080,
        resetsAt: null,
      }),
    ).toBe('7 day');
    expect(
      labelWindow({
        bucketId: 'x',
        windowKind: 'primary',
        usedPercent: 0,
        windowDurationMinutes: 1440,
        resetsAt: null,
      }),
    ).toBe('1 day');
    expect(
      labelWindow({
        bucketId: 'x',
        windowKind: 'primary',
        usedPercent: 0,
        windowDurationMinutes: 45,
        resetsAt: null,
      }),
    ).toBe('45 min');
  });

  it('falls back to the bucket name when no duration is reported', () => {
    expect(
      labelWindow({
        bucketId: 'spend_limit',
        windowKind: 'spend_limit',
        usedPercent: 0,
        windowDurationMinutes: null,
        resetsAt: null,
      }),
    ).toBe('Spend limit');
  });

  it('labels the OpenCode Go billing month, which has no fixed duration', () => {
    expect(
      labelWindow({
        bucketId: 'go',
        windowKind: 'monthly',
        usedPercent: 0,
        windowDurationMinutes: null,
        resetsAt: '2026-10-14T09:15:00.000Z',
      }),
    ).toBe('Monthly');
  });
});

describe('today per hour', () => {
  // NOW is 19:00 in Asia/Jakarta (UTC+7), so local today began at 17:00 UTC
  // the day before.
  it('keeps latest, min and max per local hour, and leaves out yesterday', () => {
    writeQuota('codex', '2026-09-11T16:50:00.000Z', [90, 90]); // 23:50 yesterday
    writeQuota('codex', '2026-09-12T02:10:00.000Z', [10, 40]); // 09:10
    writeQuota('codex', '2026-09-12T02:40:00.000Z', [15, 41]); // 09:40
    writeQuota('codex', '2026-09-12T11:55:00.000Z', [30, 50]); // 18:55

    const today = buildQuotaToday(t.db, config, 'codex', NOW);

    expect(today.availability).toEqual({ available: true });
    expect(today.hours).toHaveLength(20);
    expect(today.hours[0]).toEqual({ startsAt: '2026-09-11T17:00:00.000Z', label: '0:00' });
    expect(today.hours.at(-1)).toEqual({ startsAt: '2026-09-12T12:00:00.000Z', label: '19:00' });
    expect(today.series.map((s) => s.label)).toEqual(['5 hour', '7 day']);
    expect(today.series[0]!.points).toEqual([
      {
        startsAt: '2026-09-12T02:00:00.000Z',
        latestPercent: 15,
        minPercent: 10,
        maxPercent: 15,
        samples: 2,
      },
      {
        startsAt: '2026-09-12T11:00:00.000Z',
        latestPercent: 30,
        minPercent: 30,
        maxPercent: 30,
        samples: 1,
      },
    ]);
  });

  it('keeps both occurrences of the hour repeated when the clocks go back', () => {
    // New York leaves EDT at 06:00 UTC on 1 November 2026, so 01:00-02:00
    // local happens twice. NOW is 07:00 EST.
    const newYork = testConfig({ AUD_TIMEZONE: 'America/New_York' });
    writeQuota('codex', '2026-11-01T05:59:00.000Z', [80, 50]); // 01:59 EDT
    writeQuota('codex', '2026-11-01T06:59:00.000Z', [10, 51]); // 01:59 EST

    const today = buildQuotaToday(t.db, newYork, 'codex', new Date('2026-11-01T12:00:00.000Z'));

    expect(today.hours.map((h) => h.label)).toEqual([
      '0:00',
      '1:00 EDT',
      '1:00 EST',
      '2:00',
      '3:00',
      '4:00',
      '5:00',
      '6:00',
      '7:00',
    ]);
    expect(today.series[0]!.points.map((p) => [p.startsAt, p.latestPercent, p.samples])).toEqual([
      ['2026-11-01T05:00:00.000Z', 80, 1],
      ['2026-11-01T06:00:00.000Z', 10, 1],
    ]);
  });

  it('leaves out the hour skipped when the clocks go forward', () => {
    const newYork = testConfig({ AUD_TIMEZONE: 'America/New_York' });
    writeQuota('codex', '2026-03-08T07:30:00.000Z'); // 03:30 EDT

    const today = buildQuotaToday(t.db, newYork, 'codex', new Date('2026-03-08T08:00:00.000Z'));

    expect(today.hours.map((h) => h.label)).toEqual(['0:00', '1:00', '3:00', '4:00']);
    expect(today.series[0]!.points.map((p) => p.startsAt)).toEqual(['2026-03-08T07:00:00.000Z']);
  });

  it('says so, instead of drawing zeros, when nothing was observed today', () => {
    writeQuota('codex', '2026-09-11T16:50:00.000Z');

    const today = buildQuotaToday(t.db, config, 'codex', NOW);

    expect(today.availability.available).toBe(false);
    expect(today.series).toEqual([]);
    expect(today.hours).toHaveLength(20);
  });

  it('is charted on the OpenCode Go card only', () => {
    const overview = buildOverview(t.db, config, NOW);
    for (const card of overview.cards) {
      if (card.provider === 'opencode_go') expect(card.today).not.toBeNull();
      else expect(card.today).toBeNull();
    }
  });
});

describe('overview', () => {
  it('always returns all five providers, even with an empty database', () => {
    const overview = buildOverview(t.db, config, NOW);
    expect(overview.cards.map((c) => c.provider)).toEqual([
      'codex',
      'claude',
      'opencode_go',
      'deepseek',
      'openrouter',
    ]);
    expect(overview.cards.every((c) => c.status === 'unavailable')).toBe(true);
    // An empty dashboard must not pretend to have advice.
    expect(overview.cards.every((c) => c.advisory.state === 'unknown')).toBe(true);
  });

  it('derives remaining percent at presentation while keeping usedPercent intact', () => {
    writeQuota('codex', '2026-09-12T11:58:00.000Z', [37, 52]);
    const card = buildOverview(t.db, config, NOW).cards.find((c) => c.provider === 'codex')!;
    const primary = card.windows.find((w) => w.windowKind === 'primary')!;
    expect(primary.usedPercent).toBe(37);
    expect(primary.remainingPercent).toBe(63);
    expect(primary.label).toBe('5 hour');
  });

  it('does not block healthy providers when another has failed', () => {
    writeQuota('codex', '2026-09-12T11:58:00.000Z');
    writeFailure('openrouter', 'upstream_error', 'error', '2026-09-12T11:59:00.000Z');
    writeFailure('deepseek', 'not_configured', 'unavailable', '2026-09-12T11:59:00.000Z');

    const cards = buildOverview(t.db, config, NOW).cards;
    expect(cards.find((c) => c.provider === 'codex')?.status).toBe('healthy');
    expect(cards.find((c) => c.provider === 'openrouter')?.status).toBe('error');
    expect(cards.find((c) => c.provider === 'deepseek')?.status).toBe('unavailable');
    expect(cards.find((c) => c.provider === 'claude')?.status).toBe('unavailable');
  });

  it('keeps last known values visible on an error card and flags them', () => {
    writeQuota('codex', '2026-09-12T11:58:00.000Z');
    writeFailure('codex', 'timeout', 'error', '2026-09-12T11:59:00.000Z');

    const card = buildOverview(t.db, config, NOW).cards.find((c) => c.provider === 'codex')!;
    expect(card.status).toBe('error');
    expect(card.windows).toHaveLength(2);
    expect(card.showingLastKnownValues).toBe(true);
    // The last successful collection time survives the failure.
    expect(card.lastSuccessfulCollectionAt).toBe('2026-09-12T11:58:00.000Z');
    expect(card.advisory.state).toBe('unknown');
  });

  it('exposes a safe diagnostic code and hint but no upstream text', () => {
    writeFailure('openrouter', 'insufficient_scope', 'error', '2026-09-12T11:59:00.000Z');
    const card = buildOverview(t.db, config, NOW).cards.find((c) => c.provider === 'openrouter')!;
    expect(card.diagnostics.errorCode).toBe('insufficient_scope');
    expect(card.diagnostics.hint).toContain('privilege');
  });

  it('reports stale once the observation exceeds the budget', () => {
    writeQuota('codex', '2026-09-12T11:00:00.000Z');
    const card = buildOverview(t.db, config, NOW).cards.find((c) => c.provider === 'codex')!;
    expect(card.status).toBe('stale');
    expect(card.showingLastKnownValues).toBe(true);
    expect(card.advisory.state).toBe('unknown');
  });

  it('never emits a secret or PII in the serialised payload', () => {
    writeQuota('codex', '2026-09-12T11:58:00.000Z');
    writeCredit('openrouter', '2026-09-12T11:58:00.000Z', '100.5', '25.75');
    const json = JSON.stringify(buildOverview(t.db, config, NOW));

    expect(json).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(json).not.toMatch(/Bearer\s+\S+/);
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(json).not.toContain('accountId');
  });
});

function writeClaude(observedAt: string, windows: QuotaSnapshot['windows']) {
  const snap: QuotaSnapshot = {
    kind: 'quota',
    provider: 'claude',
    observedAt,
    collectedAt: observedAt,
    sourceVersion: 'claude-code/2.1.270',
    schemaVersion: 1,
    usageAllowed: null,
    limitReachedCode: null,
    sourceEventId: null,
    windows,
  };
  return recordAttempt(t.db, {
    runId: startRun(t.db, 'scheduled'),
    provider: 'claude',
    startedAt: observedAt,
    finishedAt: observedAt,
    retryCount: 0,
    result: { outcome: 'success', snapshot: snap },
  });
}

function fiveHour(resetsAt: string) {
  return {
    bucketId: 'five_hour',
    windowKind: 'five_hour',
    usedPercent: 90,
    windowDurationMinutes: 300,
    resetsAt,
  };
}

const SEVEN_DAY = {
  bucketId: 'seven_day',
  windowKind: 'seven_day',
  usedPercent: 27,
  windowDurationMinutes: 10080,
  resetsAt: '2026-09-15T23:00:00.000Z',
};

function claudeCard() {
  return buildOverview(t.db, config, NOW).cards.find((c) => c.provider === 'claude')!;
}

describe('ended windows', () => {
  it('lists a window the source dropped at its reset, with no percentage', () => {
    // Claude Code omits five_hour between a reset and the next window's first request.
    writeClaude('2026-09-12T11:30:00.000Z', [fiveHour('2026-09-12T11:50:00.000Z'), SEVEN_DAY]);
    writeClaude('2026-09-12T11:50:01.000Z', [SEVEN_DAY]);

    const card = claudeCard();
    expect(card.windows.map((w) => w.windowKind)).toEqual(['seven_day']);
    expect(card.endedWindows).toEqual([
      {
        bucketId: 'five_hour',
        windowKind: 'five_hour',
        windowDurationMinutes: 300,
        label: '5 hour',
        endedAt: '2026-09-12T11:50:00.000Z',
      },
    ]);
    expect(card.endedWindows[0]).not.toHaveProperty('usedPercent');
  });

  it('stops listing it once the source reports the next window', () => {
    writeClaude('2026-09-12T11:30:00.000Z', [fiveHour('2026-09-12T11:50:00.000Z'), SEVEN_DAY]);
    writeClaude('2026-09-12T11:50:01.000Z', [SEVEN_DAY]);
    writeClaude('2026-09-12T11:52:00.000Z', [fiveHour('2026-09-12T16:50:00.000Z'), SEVEN_DAY]);

    const card = claudeCard();
    expect(card.windows.map((w) => w.windowKind)).toEqual(['five_hour', 'seven_day']);
    expect(card.endedWindows).toEqual([]);
  });

  it('follows the newest observation, not the newest row', () => {
    // A late-persisted older reading must not hide the gap or invent one.
    writeClaude('2026-09-12T11:50:01.000Z', [SEVEN_DAY]);
    writeClaude('2026-09-12T11:30:00.000Z', [fiveHour('2026-09-12T11:50:00.000Z'), SEVEN_DAY]);

    expect(claudeCard().endedWindows.map((w) => w.windowKind)).toEqual(['five_hour']);
  });

  it('explains only a gap that the reset accounts for', () => {
    const latest = [SEVEN_DAY];
    const at = '2026-09-12T11:50:01.000Z';

    // Missing before its reset: the silence is not explained by a reset.
    expect(findEndedWindows(latest, [fiveHour('2026-09-12T15:00:00.000Z')], at)).toEqual([]);
    // Gone for longer than its own length: no longer a gap between two windows.
    expect(findEndedWindows(latest, [fiveHour('2026-09-12T06:50:01.000Z')], at)).toEqual([]);
    expect(findEndedWindows(latest, [fiveHour('2026-09-12T06:50:02.000Z')], at)).toHaveLength(1);
    // A reset at the observation instant counts.
    expect(findEndedWindows(latest, [fiveHour(at)], at)).toHaveLength(1);
    // No reset time or no known length: nothing to reason from.
    expect(findEndedWindows(latest, [{ ...fiveHour(at), resetsAt: null }], at)).toEqual([]);
    expect(
      findEndedWindows(latest, [{ ...fiveHour(at), windowDurationMinutes: null }], at),
    ).toEqual([]);
  });

  it('keeps ended windows out of freshness and of every non-quota card', () => {
    writeClaude('2026-09-12T11:30:00.000Z', [fiveHour('2026-09-12T11:50:00.000Z'), SEVEN_DAY]);
    writeClaude('2026-09-12T11:50:01.000Z', [SEVEN_DAY]);
    writeCredit('openrouter', '2026-09-12T11:58:00.000Z', '100.5', '25.75');

    const cards = buildOverview(t.db, config, NOW).cards;
    // The dropped window's past reset would otherwise read as a reset with no new observation.
    expect(cards.find((c) => c.provider === 'claude')!.status).toBe('healthy');
    expect(cards.find((c) => c.provider === 'openrouter')!.endedWindows).toEqual([]);
  });
});

describe('quota history', () => {
  it('reports insufficient history rather than an empty chart', () => {
    const result = buildQuotaHistory(t.db, config, 'codex', '7d', NOW);
    expect(result.availability.available).toBe(false);
    expect(result.series).toEqual([]);
  });

  it('aggregates per window per local day as levels, not sums', () => {
    // Three samples on the same Jakarta day.
    writeQuota('codex', '2026-09-12T01:00:00.000Z', [10, 20]);
    writeQuota('codex', '2026-09-12T05:00:00.000Z', [30, 25]);
    writeQuota('codex', '2026-09-12T09:00:00.000Z', [20, 30]);

    const result = buildQuotaHistory(t.db, config, 'codex', '7d', NOW);
    expect(result.availability.available).toBe(true);

    const primary = result.series.find((s) => s.windowKind === 'primary')!;
    expect(primary.points).toHaveLength(1);
    const day = primary.points[0]!;
    expect(day.samples).toBe(3);
    expect(day.minPercent).toBe(10);
    expect(day.maxPercent).toBe(30);
    // The latest sample, not an average and certainly not a sum of 60.
    expect(day.latestPercent).toBe(20);
  });

  it('splits days on the configured timezone boundary', () => {
    // 16:00 UTC is 23:00 Jakarta on the 11th; 17:30 UTC is 00:30 on the 12th.
    writeQuota('codex', '2026-09-11T16:00:00.000Z', [10, 10]);
    writeQuota('codex', '2026-09-11T17:30:00.000Z', [20, 20]);

    const result = buildQuotaHistory(t.db, config, 'codex', '7d', NOW);
    const primary = result.series.find((s) => s.windowKind === 'primary')!;
    expect(primary.points.map((p) => p.day)).toEqual(['2026-09-11', '2026-09-12']);
  });
});

describe('quota history labels', () => {
  function writeSnapshot(snapshot: Omit<QuotaSnapshot, 'kind' | 'collectedAt' | 'schemaVersion'>) {
    return recordAttempt(t.db, {
      runId: startRun(t.db, 'scheduled'),
      provider: snapshot.provider,
      startedAt: snapshot.observedAt,
      finishedAt: snapshot.observedAt,
      retryCount: 0,
      result: {
        outcome: 'success',
        snapshot: {
          ...snapshot,
          kind: 'quota',
          collectedAt: snapshot.observedAt,
          schemaVersion: 1,
        },
      },
    });
  }

  const gauge = (bucketId: string, windowKind: string, windowDurationMinutes: number | null) => ({
    bucketId,
    windowKind,
    usedPercent: 40,
    windowDurationMinutes,
    resetsAt: null,
  });

  it('draws a Claude window as one labelled series whichever source observed it', () => {
    writeSnapshot({
      provider: 'claude',
      observedAt: '2026-09-12T01:00:00.000Z',
      sourceVersion: 'claude-code/2.1.269',
      usageAllowed: null,
      limitReachedCode: null,
      sourceEventId: 'event-0000000001',
      windows: [gauge('five_hour', 'five_hour', 300), gauge('seven_day', 'seven_day', 10080)],
    });
    writeSnapshot({
      provider: 'claude',
      observedAt: '2026-09-12T02:00:00.000Z',
      sourceVersion: CLAUDE_PROBE_SOURCE_VERSION,
      usageAllowed: null,
      limitReachedCode: null,
      sourceEventId: null,
      windows: [gauge('five_hour', 'five_hour', 300), gauge('seven_day', 'seven_day', 10080)],
    });

    const result = buildQuotaHistory(t.db, config, 'claude', '7d', NOW);
    // The probe reads the same headers the status line forwards, so one line per window.
    expect(result.series.map((s) => s.label)).toEqual(['5 hour', '7 day']);
    expect(result.series.map((s) => s.points[0]?.samples)).toEqual([2, 2]);
  });

  it('names a Codex bucket only when two series would otherwise share a label', () => {
    writeSnapshot({
      provider: 'codex',
      observedAt: '2026-09-12T01:00:00.000Z',
      sourceVersion: 'codex-cli/0.154.0',
      usageAllowed: true,
      limitReachedCode: null,
      sourceEventId: null,
      windows: [
        gauge('codex', 'primary', 300),
        gauge('codex_other', 'primary', 300),
        gauge('codex', 'secondary', 10080),
      ],
    });

    const labels = buildQuotaHistory(t.db, config, 'codex', '7d', NOW).series.map((s) => s.label);
    expect(labels.sort()).toEqual(['5 hour · codex', '5 hour · codex_other', '7 day']);
  });
});

describe('credit history', () => {
  it('refuses to compute a delta without a baseline before the period', () => {
    // Only in-period observations exist: a delta here would understate usage.
    writeCredit('openrouter', '2026-09-10T00:00:00.000Z', '100', '20');
    writeCredit('openrouter', '2026-09-12T00:00:00.000Z', '100', '35');

    const result = buildCreditHistory(t.db, config, 'openrouter', '7d', NOW);
    expect(result.availability.available).toBe(false);
    if (!result.availability.available) {
      expect(result.availability.reason).toContain('Insufficient history');
    }
    expect(result.deltas).toEqual([]);
  });

  it('computes an exact decimal usage delta once a baseline exists', () => {
    writeCredit('openrouter', '2026-09-01T00:00:00.000Z', '100.5', '10.1');
    writeCredit('openrouter', '2026-09-12T00:00:00.000Z', '100.5', '10.4');

    const result = buildCreditHistory(t.db, config, 'openrouter', '7d', NOW);
    expect(result.metric).toBe('usage_delta');
    expect(result.availability.available).toBe(true);
    // 10.4 - 10.1 would be 0.30000000000000071 in binary floating point.
    expect(result.deltas[0]?.change).toBe('0.3');
    // The trend plots the same quantity as the delta, not the raw counter (10.4).
    expect(result.series.map((p) => p.value)).toEqual(['0.3']);
  });

  it('plots no usage trend without a baseline, as it reports no delta', () => {
    writeCredit('openrouter', '2026-09-10T00:00:00.000Z', '100', '20');
    writeCredit('openrouter', '2026-09-12T00:00:00.000Z', '100', '35');

    const result = buildCreditHistory(t.db, config, 'openrouter', '7d', NOW);
    expect(result.availability.available).toBe(false);
    expect(result.series).toEqual([]);
  });

  it('treats a decreasing cumulative counter as a discontinuity, not negative usage', () => {
    writeCredit('openrouter', '2026-09-01T00:00:00.000Z', '100', '80');
    writeCredit('openrouter', '2026-09-12T00:00:00.000Z', '100', '5');

    const result = buildCreditHistory(t.db, config, 'openrouter', '7d', NOW);
    expect(result.deltas[0]?.discontinuity).toBe(true);
    // No number at all is reported, rather than "-75 usage".
    expect(result.deltas[0]?.change).toBeNull();
  });

  it('detects a counter reset inside the period even after the counter climbs back', () => {
    // Endpoints alone read 10 -> 20 as "+10"; the drop from 80 to 5 says the
    // counter restarted in between, so no delta across it is honest.
    writeCredit('openrouter', '2026-09-01T00:00:00.000Z', '100', '10');
    writeCredit('openrouter', '2026-09-08T00:00:00.000Z', '100', '80');
    writeCredit('openrouter', '2026-09-10T00:00:00.000Z', '100', '5');
    writeCredit('openrouter', '2026-09-12T00:00:00.000Z', '100', '20');

    const result = buildCreditHistory(t.db, config, 'openrouter', '7d', NOW);
    expect(result.deltas[0]?.discontinuity).toBe(true);
    expect(result.deltas[0]?.change).toBeNull();
    // The trend stops at the reset: +70 before it, nothing measured across it.
    expect(result.series.map((p) => p.value)).toEqual(['70']);
  });

  it('labels DeepSeek movement as balance change, never as usage', () => {
    writeCredit('deepseek', '2026-09-01T00:00:00.000Z', '50', '0');
    writeCredit('deepseek', '2026-09-12T00:00:00.000Z', '45', '0');

    const result = buildCreditHistory(t.db, config, 'deepseek', '7d', NOW);
    expect(result.metric).toBe('balance_change');
    expect(result.deltas[0]?.change).toBe('-5');
    // A balance is still plotted as observed.
    expect(result.series.map((p) => p.value)).toEqual(['45']);
    // A balance can rise on a top-up, so a decrease is not flagged as a reset.
    expect(result.deltas[0]?.discontinuity).toBe(false);
  });

  it('reports no observation in the period distinctly from no baseline', () => {
    writeCredit('openrouter', '2026-01-01T00:00:00.000Z', '100', '10');
    const result = buildCreditHistory(t.db, config, 'openrouter', 'today', NOW);
    expect(result.availability.available).toBe(false);
    if (!result.availability.available) {
      expect(result.availability.reason).toContain('No observation was recorded');
    }
  });
});
