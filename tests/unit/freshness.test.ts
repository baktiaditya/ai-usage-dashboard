import { describe, expect, it } from 'vitest';
import { evaluateFreshness, maxAgeMs } from '@/lib/freshness';
import type { StoredAttempt, StoredSnapshot } from '@/lib/db/repository';
import { testConfig } from '../helpers/db';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const config = testConfig();

function snapshot(overrides: Partial<StoredSnapshot> = {}): StoredSnapshot {
  return {
    id: 1,
    provider: 'codex',
    kind: 'quota',
    sourceObservedAt: '2026-09-12T11:58:00.000Z',
    collectedAt: '2026-09-12T11:58:00.000Z',
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    windows: [
      {
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: 40,
        windowDurationMinutes: 300,
        resetsAt: '2026-09-12T15:00:00.000Z',
      },
    ],
    balances: [],
    ...overrides,
  };
}

function attempt(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    provider: 'codex',
    outcome: 'success',
    startedAt: '2026-09-12T11:58:00.000Z',
    finishedAt: '2026-09-12T11:58:01.000Z',
    errorCode: null,
    safeMessage: null,
    retryCount: 0,
    ...overrides,
  };
}

describe('freshness budgets', () => {
  it('gives polled sources three missed intervals', () => {
    // 3 missed intervals x 5 minutes.
    expect(maxAgeMs('codex', config)).toBe(15 * 60_000);
    expect(maxAgeMs('deepseek', config)).toBe(15 * 60_000);
  });

  it('gives the event-driven source its own, longer budget', () => {
    // Claude only emits while a session is live, so a gap is not a fault.
    expect(maxAgeMs('claude', config)).toBe(12 * 60 * 60_000);
    expect(maxAgeMs('claude', config)).toBeGreaterThan(maxAgeMs('codex', config));
  });
});

describe('card status precedence', () => {
  it('is healthy when recent and within budget', () => {
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot(),
      attempt: attempt(),
      config,
      now: NOW,
    });
    expect(r.status).toBe('healthy');
    expect(r.dataAgeMs).toBe(2 * 60_000);
  });

  it('lets a failed attempt outrank an otherwise fresh snapshot', () => {
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot(),
      attempt: attempt({ outcome: 'error', errorCode: 'timeout', safeMessage: 'no response' }),
      config,
      now: NOW,
    });
    expect(r.status).toBe('error');
    // The old value is still reported so the UI can show it, clearly labelled.
    expect(r.dataAgeMs).toBe(2 * 60_000);
  });

  it('reports an unconfigured source as unavailable, not error', () => {
    const r = evaluateFreshness({
      provider: 'deepseek',
      snapshot: undefined,
      attempt: attempt({
        provider: 'deepseek',
        outcome: 'unavailable',
        errorCode: 'not_configured',
        safeMessage: 'key not set',
      }),
      config,
      now: NOW,
    });
    expect(r.status).toBe('unavailable');
    expect(r.dataAgeMs).toBeNull();
  });

  it('reports a never-collected source as unavailable', () => {
    const r = evaluateFreshness({
      provider: 'claude',
      snapshot: undefined,
      attempt: undefined,
      config,
      now: NOW,
    });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toContain('no observation');
  });

  it('goes stale once the observation exceeds the budget', () => {
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot({ sourceObservedAt: '2026-09-12T11:40:00.000Z' }),
      attempt: attempt(),
      config,
      now: NOW,
    });
    expect(r.status).toBe('stale');
    expect(r.reason).toContain('freshness budget');
  });

  it('goes stale when a quota window reset without a newer observation', () => {
    // The stored percentage describes a window that no longer exists. Treating
    // it as current would show usage that has already been wiped.
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot({
        sourceObservedAt: '2026-09-12T11:58:00.000Z',
        windows: [
          {
            bucketId: 'codex',
            windowKind: 'primary',
            usedPercent: 95,
            windowDurationMinutes: 300,
            resetsAt: '2026-09-12T11:59:00.000Z',
          },
        ],
      }),
      attempt: attempt(),
      config,
      now: NOW,
    });
    expect(r.status).toBe('stale');
    expect(r.resetPassedWithoutObservation).toBe(true);
  });

  it('does not treat a null reset time as passed', () => {
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot({
        windows: [
          {
            bucketId: 'codex',
            windowKind: 'primary',
            usedPercent: 5,
            windowDurationMinutes: null,
            resetsAt: null,
          },
        ],
      }),
      attempt: attempt(),
      config,
      now: NOW,
    });
    expect(r.status).toBe('healthy');
  });

  it('clamps a future observation to zero age rather than reporting negative age', () => {
    const r = evaluateFreshness({
      provider: 'codex',
      snapshot: snapshot({ sourceObservedAt: '2026-09-12T12:05:00.000Z' }),
      attempt: attempt(),
      config,
      now: NOW,
    });
    expect(r.dataAgeMs).toBe(0);
  });
});
