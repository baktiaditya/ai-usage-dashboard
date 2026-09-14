/**
 * Shared HTTP plumbing for the credit adapters.
 *
 * Responses are read as *text* and handed to `parseJsonLossless`, never to
 * `response.json()`. That is the whole point: `response.json()` would convert
 * OpenRouter's `100.5` into a double before we ever saw the digits.
 */
import { z } from 'zod';
import { CollectionError, classifyHttpStatus, isRetryable } from '../errors';
import type { ErrorCode } from '../errors';
import { parseJsonLossless } from '../money';
import { redactText } from '../redact';

/**
 * A money field as `parseJsonLossless` leaves it: a JSON string as sent, or the
 * source text of a JSON number. `rawToMoney` normalises either shape.
 */
export const losslessMoney = z.union([z.string(), z.object({ __rawNumber: z.string() })]);

export interface HttpGetOptions {
  readonly url: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * GET a JSON document with an independent timeout.
 *
 * The caller's `signal` (the collector's overall budget) and this request's own
 * timeout are combined, so neither can outlive the other. Both stay armed until
 * the body has been read: headers can arrive promptly while the body stalls, and
 * a timeout that ends at the headers would leave that read unbounded.
 */
export async function getJsonLossless(options: HttpGetOptions): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onOuterAbort = () => controller.abort(new Error('aborted'));
  // An already-aborted signal never dispatches `abort` again, so a listener
  // alone would let a request start after its budget is gone.
  if (options.signal?.aborted) onOuterAbort();
  else options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    if (controller.signal.aborted) {
      throw new CollectionError('timeout', 'request budget was exhausted before it started');
    }

    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.bearerToken}`,
          Accept: 'application/json',
          'User-Agent': 'ai-usage-dashboard/0.1.0',
        },
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (err) {
      throw transportError(err, controller.signal);
    }

    if (!response.ok) {
      // Release the connection; the error body is never read or echoed.
      void response.body?.cancel().catch(() => undefined);
      const code = classifyHttpStatus(response.status);
      throw new CollectionError(code, `provider responded with HTTP ${response.status}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw transportError(err, controller.signal);
    }

    try {
      return parseJsonLossless(text);
    } catch {
      throw new CollectionError('schema_mismatch', 'response body was not valid JSON');
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

function transportError(err: unknown, signal: AbortSignal): CollectionError {
  if (signal.aborted) return new CollectionError('timeout', 'request timed out');
  // Never interpolate the raw error: it can echo the request URL and headers.
  return new CollectionError('network_error', redactText(errName(err)));
}

function errName(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.name} (${cause.code})` : err.name;
  }
  return 'network error';
}

/**
 * Retry a bounded number of times, only for codes where a retry can help.
 *
 * An auth rejection or a schema mismatch is retried zero times: repeating it
 * would burn the provider's rate limit to reach the same answer.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    baseDelayMs: number;
    signal?: AbortSignal;
    /** Called before each retry; failed attempts report their retries too. */
    onRetry?: () => void;
  },
): Promise<{ value: T; retryCount: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    try {
      return { value: await fn(), retryCount: attempt };
    } catch (err) {
      lastError = err;
      const code: ErrorCode = err instanceof CollectionError ? err.code : 'unknown_error';
      if (!isRetryable(code) || attempt === opts.maxRetries || opts.signal?.aborted) break;
      // Exponential backoff with jitter so a scheduled fleet of one does not
      // hammer a recovering provider in lockstep.
      const delay = opts.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(delay, opts.signal);
      // An abort cuts the backoff short; it must also cancel the next attempt,
      // not start a fresh request on a budget that is already spent.
      if (opts.signal?.aborted) break;
      opts.onRetry?.();
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
