import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@/lib/config';
import {
  ageMs,
  epochSecondsToIso,
  formatAge,
  hasPassed,
  startOfLocalDayNDaysAgoUtc,
  startOfLocalDayUtc,
} from '@/lib/time';

describe('configuration', () => {
  it('starts with an entirely empty environment', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3838);
    expect(c.timezone).toBe('Asia/Jakarta');
    expect(c.retentionDays).toBe(90);
    // Absent credentials must be a normal state, not a boot failure.
    expect(c.credentials.deepseekApiKey).toBeNull();
    expect(c.credentials.openrouterManagementKey).toBeNull();
  });

  it('treats a blank credential as absent rather than as an invalid key', () => {
    const c = loadConfig({ DEEPSEEK_API_KEY: '   ' });
    expect(c.credentials.deepseekApiKey).toBeNull();
  });

  it('refuses to bind anywhere but loopback', () => {
    expect(() => loadConfig({ AUD_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUD_HOST: '192.168.1.10' })).toThrow(ConfigError);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(loadConfig({ AUD_HOST: host }).host).toBe(host);
    }
  });

  it('rejects an invalid timezone instead of silently falling back', () => {
    expect(() => loadConfig({ AUD_TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
  });

  it('rejects out-of-range numeric settings', () => {
    expect(() => loadConfig({ AUD_PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUD_RETENTION_DAYS: '0' })).toThrow(ConfigError);
  });

  it('merges AUD_THRESHOLDS over the defaults key by key', () => {
    const c = loadConfig({
      AUD_THRESHOLDS: JSON.stringify({
        quota: { 'codex:secondary': { watchAtOrBelowPercent: 30, switchAtOrBelowPercent: 15 } },
        balance: { 'deepseek:USD': { watchAtOrBelow: '10', switchAtOrBelow: '2.5' } },
      }),
    });
    expect(c.thresholds.quota['codex:secondary']).toEqual({
      watchAtOrBelowPercent: 30,
      switchAtOrBelowPercent: 15,
    });
    // Untouched keys keep their shipped defaults.
    expect(c.thresholds.quota['default']).toEqual({
      watchAtOrBelowPercent: 20,
      switchAtOrBelowPercent: 10,
    });
    expect(c.thresholds.balance['deepseek:USD']).toEqual({
      watchAtOrBelow: '10',
      switchAtOrBelow: '2.5',
    });
    expect(c.thresholds.balance['deepseek:CNY']).toEqual({
      watchAtOrBelow: '35',
      switchAtOrBelow: '7',
    });
  });

  it.each([
    ['not JSON', '{quota:'],
    [
      'switch above watch',
      '{"quota":{"codex":{"watchAtOrBelowPercent":10,"switchAtOrBelowPercent":20}}}',
    ],
    [
      'a non-decimal amount',
      '{"balance":{"deepseek:USD":{"watchAtOrBelow":"ten","switchAtOrBelow":"1"}}}',
    ],
    [
      'an unknown provider key',
      '{"balance":{"acme:USD":{"watchAtOrBelow":"5","switchAtOrBelow":"1"}}}',
    ],
    ['an unknown section', '{"quotas":{}}'],
  ])('rejects a threshold override with %s instead of ignoring it', (_label, raw) => {
    expect(() => loadConfig({ AUD_THRESHOLDS: raw })).toThrow(ConfigError);
  });

  it('keeps USD and CNY balance thresholds separate', () => {
    const c = loadConfig({});
    expect(c.thresholds.balance['deepseek:USD']).not.toEqual(c.thresholds.balance['deepseek:CNY']);
  });
});

describe('time conversion', () => {
  it('converts unix seconds to UTC ISO-8601', () => {
    expect(epochSecondsToIso(1773554400)).toBe('2026-03-15T06:00:00.000Z');
  });

  it('returns null for absent or nonsensical timestamps', () => {
    expect(epochSecondsToIso(null)).toBeNull();
    expect(epochSecondsToIso(undefined)).toBeNull();
    expect(epochSecondsToIso(Number.NaN)).toBeNull();
    expect(epochSecondsToIso(-1)).toBeNull();
    // A value far beyond year 2100 is drift, not a date.
    expect(epochSecondsToIso(99999999999)).toBeNull();
  });

  it('clamps negative ages caused by clock skew', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    expect(ageMs('2026-09-12T12:05:00.000Z', now)).toBe(0);
    expect(ageMs('2026-09-12T11:00:00.000Z', now)).toBe(3_600_000);
  });

  it('never treats a null reset time as passed', () => {
    expect(hasPassed(null)).toBe(false);
    expect(hasPassed('2020-01-01T00:00:00.000Z')).toBe(true);
  });

  it('formats ages compactly', () => {
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
});

describe('calendar boundaries follow the configured timezone', () => {
  it('places local midnight at the right UTC instant', () => {
    // Asia/Jakarta is UTC+7, so 2026-09-12 00:00 local is 2026-09-11 17:00 UTC.
    const start = startOfLocalDayUtc('Asia/Jakarta', new Date('2026-09-12T05:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-11T17:00:00.000Z');
  });

  it('rolls the day over correctly just before local midnight', () => {
    // 16:59 UTC is still 2026-09-11 in Jakarta (23:59 local).
    const start = startOfLocalDayUtc('Asia/Jakarta', new Date('2026-09-11T16:59:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-10T17:00:00.000Z');
  });

  it('handles a UTC timezone', () => {
    const start = startOfLocalDayUtc('UTC', new Date('2026-09-12T05:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });

  it('handles a half-hour offset zone', () => {
    // Asia/Kolkata is UTC+5:30.
    const start = startOfLocalDayUtc('Asia/Kolkata', new Date('2026-09-12T05:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-11T18:30:00.000Z');
  });

  it('walks back whole local days', () => {
    const start = startOfLocalDayNDaysAgoUtc(
      'Asia/Jakarta',
      6,
      new Date('2026-09-12T05:00:00.000Z'),
    );
    expect(start.toISOString()).toBe('2026-09-05T17:00:00.000Z');
  });

  it('uses the offset in force at local midnight on a DST transition day', () => {
    // US spring-forward, 2026-03-08: midnight is still EST (UTC-5) though 11:00 is EDT.
    expect(
      startOfLocalDayUtc('America/New_York', new Date('2026-03-08T15:00:00.000Z')).toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    // US fall-back, 2026-11-01: midnight is still EDT (UTC-4) though 11:00 is EST.
    expect(
      startOfLocalDayUtc('America/New_York', new Date('2026-11-01T16:00:00.000Z')).toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z');
    // UK spring-forward, 2026-03-29: midnight is GMT, noon is BST.
    expect(
      startOfLocalDayUtc('Europe/London', new Date('2026-03-29T12:00:00.000Z')).toISOString(),
    ).toBe('2026-03-29T00:00:00.000Z');
  });

  it('walks back calendar days, not 24-hour blocks, across a DST transition', () => {
    // From 2026-03-09 (EDT), one local day back is 2026-03-08 00:00 EST.
    expect(
      startOfLocalDayNDaysAgoUtc(
        'America/New_York',
        1,
        new Date('2026-03-09T15:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    // Seven days back from 2026-03-12 lands before the transition, in EST.
    expect(
      startOfLocalDayNDaysAgoUtc(
        'America/New_York',
        7,
        new Date('2026-03-12T15:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-05T05:00:00.000Z');
  });
});
