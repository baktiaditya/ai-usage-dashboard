import { describe, expect, it } from 'vitest';
import { normalizeCodexResponse } from '@/lib/adapters/codex';
import { CollectionError } from '@/lib/errors';
import { fixtureJson } from '../helpers/fixtures';

const VERSION = 'codex-cli/0.154.0';

describe('codex normalisation', () => {
  it('reads both windows from the multi-bucket view', () => {
    const snap = normalizeCodexResponse(fixtureJson('codex', 'valid-0.154.0'), VERSION);

    expect(snap.kind).toBe('quota');
    expect(snap.provider).toBe('codex');
    expect(snap.sourceVersion).toBe(VERSION);
    expect(snap.usageAllowed).toBe(true);
    expect(snap.limitReachedCode).toBeNull();
    // Polled sources never deduplicate: every successful poll is history.
    expect(snap.sourceEventId).toBeNull();

    expect(snap.windows).toHaveLength(2);
    const primary = snap.windows.find((w) => w.windowKind === 'primary');
    expect(primary).toMatchObject({
      bucketId: 'codex',
      usedPercent: 37,
      windowDurationMinutes: 300,
    });
    // Unix seconds are converted to UTC ISO-8601 at the boundary.
    expect(primary?.resetsAt).toBe('2026-03-15T06:00:00.000Z');
  });

  it('falls back to the legacy single-bucket shape', () => {
    const snap = normalizeCodexResponse(fixtureJson('codex', 'legacy-single-bucket'), VERSION);
    expect(snap.windows).toHaveLength(2);
    expect(snap.windows.every((w) => w.bucketId === 'codex')).toBe(true);
  });

  it('keeps a partial response rather than discarding the window it did get', () => {
    const snap = normalizeCodexResponse(fixtureJson('codex', 'partial-no-secondary'), VERSION);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]).toMatchObject({
      windowKind: 'primary',
      usedPercent: 80,
      windowDurationMinutes: null,
      resetsAt: null,
    });
    // "The source did not say" must stay distinct from "the source said no".
    expect(snap.usageAllowed).toBeNull();
  });

  it('carries the backend cut-off signals through', () => {
    const snap = normalizeCodexResponse(fixtureJson('codex', 'limit-reached'), VERSION);
    expect(snap.usageAllowed).toBe(false);
    expect(snap.limitReachedCode).toBe('rate_limit_reached');
  });

  it('ignores unknown fields and picks up a new bucket', () => {
    const snap = normalizeCodexResponse(
      fixtureJson('codex', 'version-drift-unknown-fields'),
      VERSION,
    );
    const buckets = new Set(snap.windows.map((w) => w.bucketId));
    expect(buckets).toEqual(new Set(['codex', 'codex-mini']));
    // A brand-new bucket is labelled by its own id, never by array position.
    expect(snap.windows.find((w) => w.bucketId === 'codex-mini')?.windowDurationMinutes).toBe(1440);
  });

  it.each([
    ['malformed-missing-ratelimits', 'schema_mismatch'],
    ['malformed-wrong-types', 'schema_mismatch'],
    ['empty-no-windows', 'not_entitled'],
  ])('maps %s to %s', (fixture, code) => {
    try {
      normalizeCodexResponse(fixtureJson('codex', fixture), VERSION);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CollectionError);
      expect((err as CollectionError).code).toBe(code);
    }
  });

  it('never copies account identity out of the payload', () => {
    const raw = {
      ...(fixtureJson('codex', 'valid-0.154.0') as Record<string, unknown>),
      accountId: 'acct_should_not_survive',
    };
    const snap = normalizeCodexResponse(raw, VERSION);
    expect(JSON.stringify(snap)).not.toContain('acct_should_not_survive');
  });

  it('drops reset-credit detail, which carries backend ids and marketing copy', () => {
    const raw = {
      ...(fixtureJson('codex', 'valid-0.154.0') as Record<string, unknown>),
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [
          {
            id: 'credit_secret_id',
            title: 'A title',
            grantedAt: 1,
            resetType: 'codexRateLimits',
            status: 'available',
          },
        ],
      },
    };
    const snap = normalizeCodexResponse(raw, VERSION);
    expect(JSON.stringify(snap)).not.toContain('credit_secret_id');
    expect(JSON.stringify(snap)).not.toContain('A title');
  });
});
