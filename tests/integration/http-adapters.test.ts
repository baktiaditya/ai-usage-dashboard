import { describe, expect, it, vi } from 'vitest';
import { createDeepseekAdapter } from '@/lib/adapters/deepseek';
import { createOpenrouterAdapter } from '@/lib/adapters/openrouter';
import { CollectionError } from '@/lib/errors';
import { fixtureText } from '../helpers/fixtures';

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function capturingFetch(body: string, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const signal = () => new AbortController().signal;

describe('credential handling', () => {
  it('reports an absent DeepSeek key as not_configured without any network call', async () => {
    const { impl, calls } = capturingFetch('{}');
    const adapter = createDeepseekAdapter({ apiKey: null, fetchImpl: impl });
    await expect(adapter.collect(signal())).rejects.toMatchObject({
      code: 'not_configured',
      message: 'DeepSeek API key is not saved in Settings',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports an absent OpenRouter management key as not_configured', async () => {
    const adapter = createOpenrouterAdapter({ managementKey: null });
    await expect(adapter.collect(signal())).rejects.toMatchObject({
      code: 'not_configured',
      message: 'OpenRouter Management key is not saved in Settings',
    });
  });

  it('sends the key as a bearer token and nowhere else', async () => {
    const { impl, calls } = capturingFetch(fixtureText('openrouter', 'valid'));
    const adapter = createOpenrouterAdapter({
      managementKey: 'sk-or-v1-testkey123456',
      fetchImpl: impl,
    });
    await adapter.collect(signal());

    const call = calls[0]!;
    // Never in the URL, where it would land in logs and browser history.
    expect(call.url).not.toContain('testkey');
    expect(call.url).toBe('https://openrouter.ai/api/v1/credits');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-testkey123456');
  });

  it('refuses to follow a redirect, which could leak the bearer token to another host', async () => {
    const { impl, calls } = capturingFetch(fixtureText('deepseek', 'valid-single-currency'));
    await createDeepseekAdapter({ apiKey: 'k', fetchImpl: impl }).collect(signal());
    expect((calls[0]?.init as RequestInit).redirect).toBe('error');
  });
});

describe('HTTP status classification', () => {
  it.each([
    [401, 'auth_rejected'],
    [403, 'insufficient_scope'],
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [502, 'upstream_error'],
    [400, 'schema_mismatch'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { impl } = capturingFetch('{"error":{"message":"nope"}}', status);
    const adapter = createOpenrouterAdapter({
      managementKey: 'k',
      fetchImpl: impl,
      // Do not spend the test's time on backoff for the retryable codes.
      maxRetries: 0,
    });
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code });
  });

  it('distinguishes a wrong key type (403) from a missing one (401)', async () => {
    // OpenRouter answers 403 when an inference key is used on this endpoint.
    const { impl } = capturingFetch(
      '{"error":{"code":403,"message":"Only management keys can perform this operation"}}',
      403,
    );
    const adapter = createOpenrouterAdapter({
      managementKey: 'sk-or-v1-inference',
      fetchImpl: impl,
      maxRetries: 0,
    });
    try {
      await adapter.collect(signal());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('insufficient_scope');
      // The upstream body is never echoed.
      expect((err as CollectionError).message).toBe('provider responded with HTTP 403');
    }
  });
});

describe('bounded retry', () => {
  it('retries a retryable failure and succeeds', async () => {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse('{}', 500);
      return jsonResponse(fixtureText('openrouter', 'valid'));
    }) as unknown as typeof fetch;

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl, maxRetries: 3 });
    const snap = await adapter.collect(signal());
    expect(calls).toBe(3);
    expect(snap.balances[0]?.remainingCredit).toBe('74.75');
  });

  it('does not retry an auth rejection — repeating it cannot help', async () => {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      return jsonResponse('{}', 401);
    }) as unknown as typeof fetch;

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl, maxRetries: 3 });
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'auth_rejected' });
    expect(calls).toBe(1);
  });

  it('does not retry a schema mismatch', async () => {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      return jsonResponse(fixtureText('openrouter', 'malformed-missing-data'));
    }) as unknown as typeof fetch;

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl, maxRetries: 3 });
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'schema_mismatch' });
    expect(calls).toBe(1);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      return jsonResponse('{}', 503);
    }) as unknown as typeof fetch;

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl, maxRetries: 2 });
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'upstream_error' });
    expect(calls).toBe(3);
  });
});

describe('timeouts and transport failures', () => {
  it('reports a hung request as a timeout within its budget', async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const adapter = createDeepseekAdapter({
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 200,
      maxRetries: 0,
    });
    const started = Date.now();
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps the timeout armed while the body is read, not only until the headers', async () => {
    // Headers arrive at once; the body sends a fragment and then stalls. A
    // timeout cleared at the headers would leave this read open indefinitely.
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"data":'));
          init?.signal?.addEventListener('abort', () =>
            stream.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createOpenrouterAdapter({
      managementKey: 'k',
      fetchImpl: impl,
      timeoutMs: 200,
      maxRetries: 0,
    });
    const started = Date.now();
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('starts no request when the caller budget is already spent', async () => {
    const { impl, calls } = capturingFetch(fixtureText('openrouter', 'valid'));
    const controller = new AbortController();
    controller.abort();

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl });
    await expect(adapter.collect(controller.signal)).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(0);
  });

  it('does not start another attempt when aborted during the retry backoff', async () => {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      return jsonResponse('{}', 503);
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const adapter = createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl, maxRetries: 3 });
    const pending = adapter.collect(controller.signal);
    // The first request is issued synchronously; wait until its 503 has been
    // handled and the (>= 500ms) backoff is underway before aborting, so the
    // abort lands mid-backoff rather than before the retry decision.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'upstream_error' });
    expect(calls).toBe(1);
  });

  it('classifies a transport failure as network_error without leaking the URL', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed to https://api.deepseek.com/user/balance');
    }) as unknown as typeof fetch;

    const adapter = createDeepseekAdapter({ apiKey: 'k', fetchImpl: impl, maxRetries: 0 });
    try {
      await adapter.collect(signal());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CollectionError).code).toBe('network_error');
      expect((err as CollectionError).message).not.toContain('deepseek.com');
    }
  });

  it('reports a non-JSON body as a schema mismatch', async () => {
    const impl = vi.fn(
      async () => new Response('<html>maintenance</html>', { status: 200 }),
    ) as unknown as typeof fetch;
    const adapter = createDeepseekAdapter({ apiKey: 'k', fetchImpl: impl, maxRetries: 0 });
    await expect(adapter.collect(signal())).rejects.toMatchObject({ code: 'schema_mismatch' });
  });
});

describe('end-to-end normalisation through the HTTP layer', () => {
  it('keeps DeepSeek currencies separate', async () => {
    const { impl } = capturingFetch(fixtureText('deepseek', 'valid-multi-currency'));
    const snap = await createDeepseekAdapter({ apiKey: 'k', fetchImpl: impl }).collect(signal());
    expect(snap.balances.map((b) => b.currency).sort()).toEqual(['CNY', 'USD']);
  });

  it('keeps OpenRouter decimal precision through a real Response body', async () => {
    // This is the path that matters: Response -> text -> lossless parse.
    const { impl } = capturingFetch(fixtureText('openrouter', 'precision-hazard'));
    const snap = await createOpenrouterAdapter({ managementKey: 'k', fetchImpl: impl }).collect(
      signal(),
    );
    expect(snap.balances[0]?.remainingCredit).toBe('0.2');
  });
});
