import { describe, expect, it } from 'vitest';
import { parseSpoolEvent, spoolEventToSnapshot } from '@/lib/ingestors/claude-statusline';
import { CollectionError } from '@/lib/errors';
import { fixtureText } from '../helpers/fixtures';

function load(name: string) {
  return parseSpoolEvent(fixtureText('claude', name));
}

describe('claude spool parsing', () => {
  it('accepts a well-formed event and maps both official windows', () => {
    const snap = spoolEventToSnapshot(load('valid-spool'));

    expect(snap.provider).toBe('claude');
    expect(snap.sourceVersion).toBe('claude-code/2.1.269');
    expect(snap.observedAt).toBe('2026-09-12T04:00:00.000Z');
    // Event-driven sources dedupe on this id.
    expect(snap.sourceEventId).toBe('84cfbc12ad55ba41d052809be0ae4564');

    const five = snap.windows.find((w) => w.bucketId === 'five_hour');
    const seven = snap.windows.find((w) => w.bucketId === 'seven_day');
    expect(five).toMatchObject({ usedPercent: 23.5, windowDurationMinutes: 300 });
    expect(seven).toMatchObject({ usedPercent: 41.2, windowDurationMinutes: 10080 });
    expect(five?.resetsAt).toBe('2026-03-15T06:00:00.000Z');
  });

  it('includes the spend-limit window when the account reports one', () => {
    const snap = spoolEventToSnapshot(load('with-spend-limit'));
    const spend = snap.windows.find((w) => w.bucketId === 'spend_limit');
    expect(spend).toMatchObject({ usedPercent: 62.8, windowDurationMinutes: null });
  });

  it('drops a window this build does not know how to label', () => {
    const snap = spoolEventToSnapshot(load('unknown-window'));
    expect(snap.windows.map((w) => w.bucketId)).toEqual(['five_hour']);
  });

  it('reports an ineligible account as not_entitled, not as an error', () => {
    try {
      spoolEventToSnapshot(load('no-rate-limits'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('not_entitled');
    }
  });

  it('refuses a spool format newer than it understands', () => {
    try {
      load('future-schema');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('version_unsupported');
    }
  });

  it.each([['malformed-missing-fields', 'schema_mismatch']])('maps %s to %s', (fixture, code) => {
    try {
      load(fixture);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe(code);
    }
  });

  it('rejects a non-JSON spool file', () => {
    try {
      parseSpoolEvent('not json at all');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('schema_mismatch');
    }
  });

  it('rejects an unparsable observedAt', () => {
    const bad = JSON.stringify({
      spoolSchemaVersion: 1,
      eventId: 'abcdefgh12345678',
      observedAt: 'yesterday afternoon!!',
      cliVersion: null,
      hasRateLimits: true,
      rateLimits: { five_hour: { usedPercentage: 1, resetsAt: null } },
    });
    try {
      parseSpoolEvent(bad);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('schema_mismatch');
    }
  });
});
