import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  formatMoney,
  isMoneyNegative,
  MoneyError,
  parseJsonLossless,
  rawToInteger,
  rawToMoney,
  subtractMoney,
  toMoney,
  toMoneyOrNull,
} from '@/lib/money';
import { fixtureLossless } from '../helpers/fixtures';

describe('decimal canonicalisation', () => {
  it('normalises decimal literals', () => {
    expect(toMoney('100.50')).toBe('100.5');
    expect(toMoney('  42  ')).toBe('42');
    expect(toMoney('-3.250')).toBe('-3.25');
    expect(toMoney('0')).toBe('0');
  });

  it('rejects anything that is not a plain decimal literal', () => {
    for (const bad of [
      'NaN',
      'Infinity',
      '-Infinity',
      '',
      'abc',
      '1,000',
      '0x10',
      '1.2.3',
      '--1',
    ]) {
      expect(() => toMoney(bad), bad).toThrow(MoneyError);
    }
  });

  it('yields null rather than throwing via toMoneyOrNull', () => {
    expect(toMoneyOrNull(null)).toBeNull();
    expect(toMoneyOrNull(undefined)).toBeNull();
    expect(toMoneyOrNull('nonsense')).toBeNull();
    expect(toMoneyOrNull('7.5')).toBe('7.5');
  });
});

describe('decimal arithmetic', () => {
  it('subtracts exactly where binary floating point would not', () => {
    // 0.3 - 0.1 === 0.19999999999999998 as a double.
    expect(subtractMoney(toMoney('0.3'), toMoney('0.1'))).toBe('0.2');
    expect(0.3 - 0.1).not.toBe(0.2);
  });

  it('adds exactly where binary floating point would not', () => {
    expect(addMoney(toMoney('0.1'), toMoney('0.2'))).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('preserves precision past the 53-bit mantissa', () => {
    const result = subtractMoney(toMoney('123456789.123456789'), toMoney('0.000000001'));
    expect(result).toBe('123456789.123456788');
  });

  it('compares without coercing through a double', () => {
    expect(compareMoney(toMoney('0.1'), toMoney('0.10'))).toBe(0);
    expect(compareMoney(toMoney('1.0000000000000001'), toMoney('1'))).toBe(1);
    expect(compareMoney(toMoney('-5'), toMoney('0'))).toBe(-1);
  });

  it('reports negative remainders without clamping', () => {
    const remaining = subtractMoney(toMoney('10'), toMoney('12.5'));
    expect(remaining).toBe('-2.5');
    expect(isMoneyNegative(remaining)).toBe(true);
  });

  it('formats for display at a fixed scale without mutating the stored value', () => {
    expect(formatMoney(toMoney('100.5'))).toBe('100.50');
    expect(formatMoney(toMoney('0.005'), 2)).toBe('0.01');
    expect(formatMoney(toMoney('1'), 4)).toBe('1.0000');
  });
});

describe('lossless JSON parsing', () => {
  it('captures the source text of JSON numbers', () => {
    const parsed = parseJsonLossless('{"a": 100.50, "b": 1e3}') as Record<string, unknown>;
    expect(parsed['a']).toEqual({ __rawNumber: '100.50' });
    expect(parsed['b']).toEqual({ __rawNumber: '1e3' });
  });

  it('keeps precision that JSON.parse would silently destroy', () => {
    const text = '{"v": 0.1000000000000000055511151231257827}';
    expect(rawToMoney((parseJsonLossless(text) as Record<string, unknown>)['v'])).toBe(
      '0.1000000000000000055511151231257827',
    );
    // The ordinary parse collapses it to the nearest double.
    expect(String((JSON.parse(text) as { v: number }).v)).toBe('0.1');
  });

  it('accepts both string and number wire types for money', () => {
    expect(rawToMoney({ __rawNumber: '2.50' })).toBe('2.5');
    expect(rawToMoney('2.50')).toBe('2.5');
    expect(rawToMoney(null)).toBeNull();
    expect(rawToMoney(true)).toBeNull();
  });

  it('reads integers only when they are safe integers', () => {
    expect(rawToInteger({ __rawNumber: '1773554400' })).toBe(1773554400);
    expect(rawToInteger({ __rawNumber: '1.5' })).toBeNull();
    expect(rawToInteger({ __rawNumber: '99999999999999999999' })).toBeNull();
    expect(rawToInteger('nope')).toBeNull();
  });

  it('survives a real provider payload with a precision hazard', () => {
    const raw = fixtureLossless('openrouter', 'precision-hazard') as {
      data: { total_credits: unknown; total_usage: unknown };
    };
    const credits = rawToMoney(raw.data.total_credits);
    const usage = rawToMoney(raw.data.total_usage);
    expect(subtractMoney(credits!, usage!)).toBe('0.2');
  });
});
