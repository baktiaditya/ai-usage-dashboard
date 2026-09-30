import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  RETIRED_CREDENTIAL_ENV_VARS,
  loadConfig,
  retiredCredentialEnvVars,
} from '@/lib/config';
import {
  ageMs,
  epochSecondsToIso,
  formatAge,
  hasPassed,
  localHoursBetween,
  startOfLocalDayNDaysAgoUtc,
  startOfLocalDayUtc,
  startOfLocalHourUtc,
} from '@/lib/time';

describe('configuration', () => {
  it('starts with an entirely empty environment', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3838);
    expect(c.timezone).toBe('Asia/Jakarta');
    expect(c.retentionDays).toBe(90);
  });

  it('probes Claude quota no more often than every five minutes by default', () => {
    expect(loadConfig({}).claudePollIntervalMinutes).toBe(5);
    expect(loadConfig({ AUD_CLAUDE_POLL_INTERVAL_MINUTES: '' }).claudePollIntervalMinutes).toBe(5);
    expect(loadConfig({ AUD_CLAUDE_POLL_INTERVAL_MINUTES: '15' }).claudePollIntervalMinutes).toBe(
      15,
    );
  });

  it('rejects a Claude probe interval below the five-minute floor instead of clamping it', () => {
    for (const value of ['4', '0', '-5', '4.9', 'five']) {
      expect(() => loadConfig({ AUD_CLAUDE_POLL_INTERVAL_MINUTES: value }), value).toThrow(
        ConfigError,
      );
    }
    // The floor is the probe's own, not the timer's: a faster timer does not lower it.
    expect(() =>
      loadConfig({ AUD_COLLECT_INTERVAL_MINUTES: '1', AUD_CLAUDE_POLL_INTERVAL_MINUTES: '1' }),
    ).toThrow(/AUD_CLAUDE_POLL_INTERVAL_MINUTES/);
  });

  it('reads no provider key from the environment', () => {
    // Fake keys only.
    const c = loadConfig({
      DEEPSEEK_API_KEY: 'sk-fake-config-deepseek-0000',
      OPENROUTER_MANAGEMENT_KEY: 'sk-or-fake-config-openrouter-0000',
    });
    expect(c).not.toHaveProperty('credentials');
    expect(JSON.stringify(c)).not.toMatch(/sk-(or-)?fake-config/);
  });

  it('names the retired provider key variables that are still set, never their values', () => {
    expect(RETIRED_CREDENTIAL_ENV_VARS).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_MANAGEMENT_KEY']);
    expect(retiredCredentialEnvVars({})).toEqual([]);
    expect(
      retiredCredentialEnvVars({ DEEPSEEK_API_KEY: '', OPENROUTER_MANAGEMENT_KEY: '  ' }),
    ).toEqual([]);
    expect(retiredCredentialEnvVars({ OPENROUTER_MANAGEMENT_KEY: 'sk-or-fake' })).toEqual([
      'OPENROUTER_MANAGEMENT_KEY',
    ]);
    expect(
      retiredCredentialEnvVars({
        OPENROUTER_MANAGEMENT_KEY: 'sk-or-fake',
        DEEPSEEK_API_KEY: 'sk-fake',
        AUD_PORT: '3838',
      }),
    ).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_MANAGEMENT_KEY']);
  });

  it('refuses to bind anywhere but loopback', () => {
    expect(() => loadConfig({ AUD_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUD_HOST: '192.168.1.10' })).toThrow(ConfigError);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(loadConfig({ AUD_HOST: host }).host).toBe(host);
    }
  });

  it('requires an absolute data directory, expanding a leading ~/', () => {
    // A relative path would open a different database in each working directory.
    for (const raw of ['relative-data', './data', '../data', '~other/data']) {
      expect(() => loadConfig({ AUD_DATA_DIR: raw })).toThrow(ConfigError);
    }
    expect(loadConfig({ AUD_DATA_DIR: '~/aud-data' }).databasePath).toBe(
      join(homedir(), 'aud-data', 'usage.db'),
    );
    expect(loadConfig({ AUD_DATA_DIR: '/srv/aud/' }).dataDir).toBe('/srv/aud');
    // A blank line in collector.env means "unset", never the current directory.
    expect(loadConfig({ AUD_DATA_DIR: '' }).dataDir).toBe(
      join(homedir(), '.local', 'share', 'ai-usage-dashboard'),
    );
  });

  it('honours an absolute XDG_DATA_HOME and ignores a relative one', () => {
    expect(loadConfig({ XDG_DATA_HOME: '/xdg' }).dataDir).toBe('/xdg/ai-usage-dashboard');
    expect(loadConfig({ XDG_DATA_HOME: 'relative' }).dataDir).toBe(
      join(homedir(), '.local', 'share', 'ai-usage-dashboard'),
    );
  });

  it('rejects an invalid timezone instead of silently falling back', () => {
    expect(() => loadConfig({ AUD_TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
  });

  it('rejects out-of-range numeric settings', () => {
    expect(() => loadConfig({ AUD_PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUD_RETENTION_DAYS: '0' })).toThrow(ConfigError);
  });

  it('enables manual refresh unless the internal AUD_REFRESH_ENABLED turns it off', () => {
    // Production never sets it, so production refresh stays on.
    expect(loadConfig({}).refreshEnabled).toBe(true);
    expect(loadConfig({ AUD_REFRESH_ENABLED: '1' }).refreshEnabled).toBe(true);
    expect(loadConfig({ AUD_REFRESH_ENABLED: '0' }).refreshEnabled).toBe(false);
    for (const value of ['', 'true', 'yes', '2', ' 0']) {
      expect(() => loadConfig({ AUD_REFRESH_ENABLED: value }), value).toThrow(ConfigError);
    }
  });

  it('ignores development launcher settings, so a malformed one cannot stop production', () => {
    const c = loadConfig({
      AUD_DEV_PORT: 'abc',
      AUD_DEV_DATA_DIR: 'relative',
      AUD_DEV_LIVE_REFRESH: 'yes',
    });
    expect(c.port).toBe(3838);
    expect(c.dataDir).toBe(join(homedir(), '.local', 'share', 'ai-usage-dashboard'));
    expect(c.refreshEnabled).toBe(true);
    expect(Object.keys(c).filter((key) => /dev/i.test(key))).toEqual([]);
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

  it('starts the day at the transition when a zone skips midnight itself', () => {
    // Havana springs forward 00:00 CST -> 01:00 CDT: 04:00Z would be 23:00 the day before.
    expect(
      startOfLocalDayUtc('America/Havana', new Date('2026-03-08T15:00:00.000Z')).toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    // Azores springs forward 00:00 -01:00 -> 01:00 +00:00.
    expect(
      startOfLocalDayUtc('Atlantic/Azores', new Date('2026-03-29T12:00:00.000Z')).toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
    // Santiago springs forward 00:00 -04:00 -> 01:00 -03:00.
    expect(
      startOfLocalDayUtc('America/Santiago', new Date('2026-09-06T15:00:00.000Z')).toISOString(),
    ).toBe('2026-09-06T04:00:00.000Z');
    // Santiago falls back 00:00 -03:00 -> 23:00 -04:00: the day's first 00:00 is at 04:00Z.
    expect(
      startOfLocalDayUtc('America/Santiago', new Date('2026-04-05T15:00:00.000Z')).toISOString(),
    ).toBe('2026-04-05T04:00:00.000Z');
    // The same boundary when reached by walking back from a later day.
    expect(
      startOfLocalDayNDaysAgoUtc(
        'America/Havana',
        2,
        new Date('2026-03-10T15:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
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

describe('local clock hours', () => {
  it("starts a half-hour zone's hours at :30 UTC", () => {
    // 10:59 in Asia/Kolkata (UTC+5:30).
    const start = startOfLocalHourUtc('Asia/Kolkata', new Date('2026-09-12T05:29:59.500Z'));
    expect(start.toISOString()).toBe('2026-09-12T04:30:00.000Z');
  });

  it('gives each occurrence of a repeated hour its own start', () => {
    // 01:30 EDT, then 01:30 EST an hour later.
    expect(
      startOfLocalHourUtc('America/New_York', new Date('2026-11-01T05:30:00.000Z')).toISOString(),
    ).toBe('2026-11-01T05:00:00.000Z');
    expect(
      startOfLocalHourUtc('America/New_York', new Date('2026-11-01T06:30:00.000Z')).toISOString(),
    ).toBe('2026-11-01T06:00:00.000Z');
  });

  it('lists 25 hours on the day the clocks go back and 23 on the day they go forward', () => {
    const hoursIn = (from: string, to: string) =>
      localHoursBetween('America/New_York', new Date(from), new Date(to)).length;
    expect(hoursIn('2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.000Z')).toBe(25);
    expect(hoursIn('2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.000Z')).toBe(23);
  });
});
