import { describe, expect, it } from 'vitest';
import { redactText, redactValue, safeErrorMessage } from '@/lib/redact';

/**
 * These assertions are the contract that nothing sensitive reaches a log, the
 * database, an API response, or the browser. Each case uses a *shaped* secret
 * rather than a real one.
 */
describe('redactText', () => {
  const cases: [string, string, string][] = [
    ['bearer token', 'Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789'],
    ['lowercase header', 'authorization=Bearer sk-xyzxyzxyzxyzxyzxyz', 'sk-xyzxyzxyzxyzxyzxyz'],
    ['openrouter key', 'key sk-or-v1-0123456789abcdef0123', 'sk-or-v1-0123456789abcdef0123'],
    ['generic api key', 'sk-0123456789abcdefghij', 'sk-0123456789abcdefghij'],
    // OpenCode Go keys are not documented; these cover a shaped key in every
    // place one could surface: a header, a bearer string, an assignment, bare.
    [
      'opencode key in a header',
      'Authorization: Bearer sk-OpEnCoDe0123456789abcdefXYZ',
      'sk-OpEnCoDe0123456789abcdefXYZ',
    ],
    [
      'opencode key as bearer',
      'sent bearer sk-OpEnCoDe0123456789abcdefXYZ upstream',
      'sk-OpEnCoDe0123456789abcdefXYZ',
    ],
    [
      'opencode key assignment',
      'opencode_go api_key=sk-OpEnCoDe0123456789abcdefXYZ',
      'sk-OpEnCoDe0123456789abcdefXYZ',
    ],
    [
      'opencode key bare',
      'rejected sk-OpEnCoDe0123456789abcdefXYZ',
      'sk-OpEnCoDe0123456789abcdefXYZ',
    ],
    [
      'claude setup token',
      'rejected sk-ant-oat01-0123456789abcdef-ghij',
      'sk-ant-oat01-0123456789abcdef-ghij',
    ],
    [
      'jwt',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NQ.SflKxwRJSMeKKF2QT4',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    ['apiKey assignment', 'apiKey="supersecretvalue"', 'supersecretvalue'],
    ['access_token json', '"access_token": "atk_9f8e7d6c5b4a"', 'atk_9f8e7d6c5b4a'],
    ['email', 'failed for user@example.com', 'user@example.com'],
    ['accountId', 'accountId=acct_9f8e7d6c', 'acct_9f8e7d6c'],
    [
      'uuid',
      'org 00000000-1111-4222-8333-444444444444 failed',
      '00000000-1111-4222-8333-444444444444',
    ],
    ['home path', 'ENOENT: /home/someuser/.codex/auth.json', '/home/someuser'],
  ];

  it.each(cases)('removes %s', (_label, input, secret) => {
    const out = redactText(input);
    expect(out).not.toContain(secret);
  });

  it('clamps runaway messages', () => {
    const out = redactText('x'.repeat(5000));
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('[truncated]');
  });

  it('leaves ordinary diagnostics readable', () => {
    expect(redactText('provider responded with HTTP 403')).toBe('provider responded with HTTP 403');
  });
});

describe('redactValue', () => {
  it('drops denied keys wholesale regardless of value shape', () => {
    const out = redactValue({
      apiKey: 'sk-live-abcdefghijklmnop',
      email: 'a@b.com',
      accountId: 'acct_1',
      session_id: 'sess_1',
      transcript_path: '/home/u/t.jsonl',
      safe: 'keep me',
    }) as Record<string, unknown>;

    expect(out['apiKey']).toBe('[redacted]');
    expect(out['email']).toBe('[redacted]');
    expect(out['accountId']).toBe('[redacted]');
    expect(out['session_id']).toBe('[redacted]');
    expect(out['transcript_path']).toBe('[redacted]');
    expect(out['safe']).toBe('keep me');
  });

  it('recurses into nested structures', () => {
    const out = redactValue({ a: { b: { c: { token: 'tok_abcdef123456' } } } });
    expect(JSON.stringify(out)).not.toContain('tok_abcdef123456');
  });

  it('stops at a bounded depth instead of recursing forever', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 30; i += 1) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).toContain('[redacted:depth]');
  });

  it('caps arrays so one huge payload cannot flood a log line', () => {
    const out = redactValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(50);
  });
});

describe('safeErrorMessage', () => {
  it('keeps the class and message but never the stack', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const out = safeErrorMessage(err);
    expect(out).toContain('Error');
    expect(out).not.toContain('at ');
    expect(out).not.toContain(__filename);
  });

  it('redacts secrets embedded in an error message', () => {
    const out = safeErrorMessage(new Error('request failed: Bearer sk-or-v1-abcdefghijklmno'));
    expect(out).not.toContain('sk-or-v1-abcdefghijklmno');
  });

  it('handles non-Error throws', () => {
    expect(safeErrorMessage('plain string')).toBe('plain string');
    expect(safeErrorMessage({ weird: true })).toBe('unknown error');
  });
});
