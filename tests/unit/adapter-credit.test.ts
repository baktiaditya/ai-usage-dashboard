import { describe, expect, it } from 'vitest';
import { normalizeDeepseekResponse } from '@/lib/adapters/deepseek';
import { normalizeOpenrouterResponse } from '@/lib/adapters/openrouter';
import { CollectionError } from '@/lib/errors';
import { fixtureLossless } from '../helpers/fixtures';

describe('deepseek normalisation', () => {
  it('keeps every currency separately and never converts between them', () => {
    const snap = normalizeDeepseekResponse(fixtureLossless('deepseek', 'valid-multi-currency'));

    expect(snap.kind).toBe('credit');
    expect(snap.balances).toHaveLength(2);

    const cny = snap.balances.find((b) => b.currency === 'CNY');
    const usd = snap.balances.find((b) => b.currency === 'USD');
    expect(cny).toMatchObject({
      totalBalance: '110',
      grantedBalance: '10',
      toppedUpBalance: '100',
      isAvailable: true,
    });
    expect(usd?.totalBalance).toBe('15.42');

    // DeepSeek's endpoint exposes no usage at all; claiming one would be fiction.
    for (const b of snap.balances) {
      expect(b.totalUsage).toBeNull();
      expect(b.totalCredits).toBeNull();
      expect(b.remainingCredit).toBeNull();
    }
  });

  it('carries the insufficient-balance flag through', () => {
    const snap = normalizeDeepseekResponse(fixtureLossless('deepseek', 'unavailable-balance'));
    expect(snap.balances[0]?.isAvailable).toBe(false);
    expect(snap.balances[0]?.totalBalance).toBe('0');
  });

  it('preserves decimal digits exactly', () => {
    const snap = normalizeDeepseekResponse(fixtureLossless('deepseek', 'precision-edge'));
    expect(snap.balances[0]?.totalBalance).toBe('0.30000000000000004');
  });

  it('ignores unknown fields introduced by a newer API', () => {
    const snap = normalizeDeepseekResponse(
      fixtureLossless('deepseek', 'version-drift-extra-fields'),
    );
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]?.totalBalance).toBe('42');
  });

  it('rejects a balance that is present but not a decimal, instead of storing it as absent', () => {
    const raw = {
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: 'oops', granted_balance: '0' }],
    };
    try {
      normalizeDeepseekResponse(raw);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('schema_mismatch');
      expect((err as CollectionError).message).toContain('total_balance');
    }
  });

  it('still records a field the provider omitted as absent', () => {
    const snap = normalizeDeepseekResponse({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1.5' }],
    });
    expect(snap.balances[0]).toMatchObject({ totalBalance: '1.5', grantedBalance: null });
  });

  it.each([
    ['malformed-missing-balance-infos', 'schema_mismatch'],
    ['malformed-empty-currencies', 'not_entitled'],
    ['malformed-duplicate-currency', 'schema_mismatch'],
  ])('maps %s to %s', (fixture, code) => {
    try {
      normalizeDeepseekResponse(fixtureLossless('deepseek', fixture));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe(code);
    }
  });
});

describe('openrouter normalisation', () => {
  it('computes remaining with exact decimal arithmetic', () => {
    const snap = normalizeOpenrouterResponse(fixtureLossless('openrouter', 'valid'));
    const usd = snap.balances[0];

    expect(usd?.currency).toBe('USD');
    expect(usd?.totalCredits).toBe('100.5');
    expect(usd?.totalUsage).toBe('25.75');
    expect(usd?.remainingCredit).toBe('74.75');

    // A balance field belongs to DeepSeek's shape, not this one.
    expect(usd?.totalBalance).toBeNull();
  });

  it('avoids the floating-point result a naive implementation would produce', () => {
    const snap = normalizeOpenrouterResponse(fixtureLossless('openrouter', 'precision-hazard'));
    expect(snap.balances[0]?.remainingCredit).toBe('0.2');
    expect(0.3 - 0.1).toBe(0.19999999999999998);
  });

  it('keeps precision beyond what a double can represent', () => {
    const snap = normalizeOpenrouterResponse(fixtureLossless('openrouter', 'high-precision'));
    expect(snap.balances[0]?.totalCredits).toBe('123456789.123456789');
    expect(snap.balances[0]?.remainingCredit).toBe('123456789.123456788');
  });

  it('reports an overdrawn account as negative rather than clamping to zero', () => {
    const snap = normalizeOpenrouterResponse(fixtureLossless('openrouter', 'overdrawn'));
    expect(snap.balances[0]?.remainingCredit).toBe('-2.5');
  });

  it('accepts decimal strings if the API switches wire types', () => {
    const snap = normalizeOpenrouterResponse(fixtureLossless('openrouter', 'string-numbers'));
    expect(snap.balances[0]?.remainingCredit).toBe('74.75');
  });

  it.each([
    ['malformed-missing-data', 'schema_mismatch'],
    ['malformed-null-usage', 'schema_mismatch'],
  ])('maps %s to %s', (fixture, code) => {
    try {
      normalizeOpenrouterResponse(fixtureLossless('openrouter', fixture));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe(code);
    }
  });
});
