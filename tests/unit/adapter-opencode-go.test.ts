import { describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_GO_SOURCE_VERSION,
  OPENCODE_GO_USAGE_URL,
  createOpencodeGoAdapter,
  normalizeOpencodeGoResponse,
} from '@/lib/adapters/opencode-go';
import { fixtureJson, fixtureLossless, fixtureText } from '../helpers/fixtures';

const KEY = 'sk-fake-opencode-go-0000000000efgh';

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function fetchSequence(...responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const signal = () => new AbortController().signal;
const fixture = (name: string) => () => respond(fixtureText('opencode-go', name));

describe('opencode go normalisation', () => {
  it('maps the three windows by what they are, with their durations', () => {
    const snap = normalizeOpencodeGoResponse(fixtureLossless('opencode-go', 'valid'));

    expect(snap).toMatchObject({
      kind: 'quota',
      provider: 'opencode_go',
      sourceVersion: OPENCODE_GO_SOURCE_VERSION,
      usageAllowed: null,
      limitReachedCode: null,
      sourceEventId: null,
    });
    expect(snap.windows).toEqual([
      {
        bucketId: 'go',
        windowKind: 'rolling',
        usedPercent: 7,
        windowDurationMinutes: 300,
        resetsAt: '2026-09-30T16:30:00.000Z',
      },
      {
        bucketId: 'go',
        windowKind: 'weekly',
        usedPercent: 41,
        windowDurationMinutes: 10080,
        resetsAt: '2026-10-05T00:00:00.000Z',
      },
      {
        bucketId: 'go',
        windowKind: 'monthly',
        usedPercent: 23,
        windowDurationMinutes: null,
        resetsAt: '2026-10-14T09:15:00.000Z',
      },
    ]);
  });

  it('reads a percentage whether it arrives as a number or as lossless source text', () => {
    const plain = normalizeOpencodeGoResponse(fixtureJson('opencode-go', 'valid'));
    const lossless = normalizeOpencodeGoResponse(fixtureLossless('opencode-go', 'valid'));
    expect(lossless.windows.map((w) => w.usedPercent)).toEqual([7, 41, 23]);
    expect(plain.windows).toEqual(lossless.windows);
  });

  it('names the first rate-limited window, and never claims usage is disallowed', () => {
    const snap = normalizeOpencodeGoResponse(fixtureLossless('opencode-go', 'rate-limited'));
    // "Use balance" can keep requests flowing, and the response does not say.
    expect(snap.usageAllowed).toBeNull();
    expect(snap.limitReachedCode).toBe('weekly_rate_limited');
  });

  it('keeps a source value above 100 rather than clamping it', () => {
    const raw = fixtureJson('opencode-go', 'valid') as { usage: { weekly: { percent: number } } };
    raw.usage.weekly.percent = 104;
    expect(normalizeOpencodeGoResponse(raw).windows[1]!.usedPercent).toBe(104);
  });

  it('ignores fields and windows a newer API adds, and stores resets in UTC', () => {
    const snap = normalizeOpencodeGoResponse(
      fixtureLossless('opencode-go', 'version-drift-extra-fields'),
    );
    expect(snap.windows.map((w) => w.windowKind)).toEqual(['rolling', 'weekly', 'monthly']);
    expect(snap.windows[0]!.resetsAt).toBe('2026-09-30T16:30:00.000Z');
    expect(JSON.stringify(snap)).not.toContain('limitUsd');
  });

  it.each([
    ['missing-window', 'usage.monthly'],
    ['unknown-status', 'usage.rolling.status'],
  ])('refuses %s drift as schema_mismatch, naming only the field', (name, path) => {
    expect(() => normalizeOpencodeGoResponse(fixtureLossless('opencode-go', name))).toThrow(
      expect.objectContaining({
        code: 'schema_mismatch',
        message: expect.stringContaining(path),
      }),
    );
  });

  it.each([
    ['a negative percentage', { percent: -1 }],
    ['a non-numeric percentage', { percent: { __rawNumber: 'NaN' } }],
    // Number() would read each of these as a plausible percentage.
    ['an empty lossless marker', { percent: { __rawNumber: '' } }],
    ['a hexadecimal lossless marker', { percent: { __rawNumber: '0x64' } }],
    ['a padded lossless marker', { percent: { __rawNumber: ' 41' } }],
    ['a signed lossless marker', { percent: { __rawNumber: '+41' } }],
    ['an Infinity lossless marker', { percent: { __rawNumber: 'Infinity' } }],
    ['a percentage sent as a string', { percent: '41' }],
    ['a reset time that is not an instant', { resetsAt: 'next monday' }],
    ['a reset time without an offset', { resetsAt: '2026-10-05T00:00:00' }],
  ])('refuses %s', (_label, patch) => {
    const raw = fixtureJson('opencode-go', 'valid') as { usage: Record<string, object> };
    raw.usage.weekly = { ...raw.usage.weekly, ...patch };
    expect(() => normalizeOpencodeGoResponse(raw)).toThrow(
      expect.objectContaining({ code: 'schema_mismatch' }),
    );
  });

  it('reads every JSON number literal form a lossless marker can carry', () => {
    const raw = fixtureJson('opencode-go', 'valid') as { usage: Record<string, object> };
    const read = (text: string) => {
      raw.usage.weekly = { ...raw.usage.weekly, percent: { __rawNumber: text } };
      return normalizeOpencodeGoResponse(raw).windows[1]!.usedPercent;
    };
    expect([read('41'), read('0'), read('41.5'), read('1e2'), read('4.1E+1')]).toEqual([
      41, 0, 41.5, 100, 41,
    ]);
  });

  it('refuses a payload with no usage object', () => {
    expect(() => normalizeOpencodeGoResponse({ type: 'error' })).toThrow(
      expect.objectContaining({ code: 'schema_mismatch' }),
    );
  });
});

describe('opencode go adapter', () => {
  it('reports an absent key as not_configured without any network call', async () => {
    const { impl, calls } = fetchSequence(fixture('valid'));
    await expect(
      createOpencodeGoAdapter({ apiKey: null, fetchImpl: impl }).collect(signal()),
    ).rejects.toMatchObject({
      code: 'not_configured',
      message: 'OpenCode Go API key is not saved in Settings',
    });
    expect(calls).toHaveLength(0);
  });

  it('reads the real HTTP path end to end: lossless numbers become percentages', async () => {
    const { impl } = fetchSequence(fixture('valid'));
    const snap = await createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal());
    expect(snap.windows.map((w) => w.usedPercent)).toEqual([7, 41, 23]);
  });

  it('sends the key only as a bearer token, to the canonical URL, refusing redirects', async () => {
    const { impl, calls } = fetchSequence(fixture('valid'));
    await createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal());

    const call = calls[0]!;
    expect(call.url).toBe(OPENCODE_GO_USAGE_URL);
    expect(call.url).not.toContain('opencode-go-0000');
    expect(call.init?.method).toBe('GET');
    expect(call.init?.redirect).toBe('error');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('x-api-key');
  });

  it('reports a rejected key as auth_rejected without retrying', async () => {
    const body = '{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}';
    const { impl, calls } = fetchSequence(() => respond(body, 401));
    await expect(
      createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal()),
    ).rejects.toMatchObject({ code: 'auth_rejected' });
    expect(calls).toHaveLength(1);
  });

  it('reports a key without a Go subscription as not_entitled, not a broken key', async () => {
    const { impl, calls } = fetchSequence(() => respond('{}', 403));
    await expect(
      createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal()),
    ).rejects.toMatchObject({
      code: 'not_entitled',
      message: 'this key has no OpenCode Go subscription',
    });
    expect(calls).toHaveLength(1);
  });

  it('retries a transient upstream failure and records the retry', async () => {
    const { impl, calls } = fetchSequence(() => respond('{}', 503), fixture('valid'));
    const recordRetry = vi.fn();
    const snap = await createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal(), {
      recordRetry,
    });
    expect(calls).toHaveLength(2);
    expect(recordRetry).toHaveBeenCalledTimes(1);
    expect(snap.windows).toHaveLength(3);
  });

  it('refuses a malformed lossless marker on the real HTTP path, storing nothing', async () => {
    const body = fixtureText('opencode-go', 'valid').replace(
      '"percent": 41',
      '"percent": { "__rawNumber": "0x64" }',
    );
    expect(body).toContain('0x64');
    const { impl } = fetchSequence(() => respond(body));
    await expect(
      createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl }).collect(signal()),
    ).rejects.toMatchObject({ code: 'schema_mismatch' });
  });

  it('never echoes the error body or the key in a failure message', async () => {
    const { impl } = fetchSequence(() => respond(`{"echo":"${KEY}"}`, 401));
    const err = await createOpencodeGoAdapter({ apiKey: KEY, fetchImpl: impl })
      .collect(signal())
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String((err as Error).message)).not.toContain('echo');
  });
});
