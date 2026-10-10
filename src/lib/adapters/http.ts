/**
 * Shared HTTP plumbing for the credit adapters and the Claude quota probe.
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
  /**
   * Extra request headers. They may add a header or override `User-Agent`, but
   * never `Authorization`, which is always derived from `bearerToken`.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_USER_AGENT = 'ai-usage-dashboard/0.4.0';

/**
 * The request headers for one request. Names are matched case-insensitively, so an
 * override replaces the default instead of sending both, and an
 * `authorization` spelled any way is refused rather than silently merged.
 */
export function buildRequestHeaders(
  bearerToken: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    Accept: 'application/json',
    'User-Agent': DEFAULT_USER_AGENT,
  };
  for (const [name, value] of Object.entries(extra)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') {
      throw new Error('Authorization is derived from bearerToken and cannot be overridden');
    }
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === lower);
    headers[existing ?? name] = value;
  }
  return headers;
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
  // Built before any timer or listener, so a refused header throws cleanly
  // instead of being reported as a network failure.
  const headers = buildRequestHeaders(options.bearerToken, options.headers);
  return withRequestBudget(options, async (signal) => {
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'GET',
        headers,
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (err) {
      throw transportError(err, signal);
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
      throw transportError(err, signal);
    }

    try {
      return parseJsonLossless(text);
    } catch {
      throw new CollectionError('schema_mismatch', 'response body was not valid JSON');
    }
  });
}

export interface HttpPostOptions extends HttpGetOptions {
  /** Serialised as the JSON request body. */
  readonly body: unknown;
}

/** What a header-only read keeps of a response: never its body. */
export interface HeaderResponse {
  readonly status: number;
  readonly headers: Headers;
}

/**
 * POST a JSON body and return the status and headers, whatever the status.
 *
 * For a source whose answer is in the response headers. The body is cancelled
 * unread, so nothing the provider wrote back — including an error message that
 * might echo the request — reaches this process's logs or storage. Classifying
 * the status is the caller's job, because a refusal can still carry the headers
 * it wants. Transport failures and timeouts throw as they do for a GET.
 */
export async function postJsonForHeaders(options: HttpPostOptions): Promise<HeaderResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = buildRequestHeaders(options.bearerToken, {
    'Content-Type': 'application/json',
    ...options.headers,
  });
  const body = JSON.stringify(options.body);
  return withRequestBudget(options, async (signal) => {
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers,
        body,
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (err) {
      throw transportError(err, signal);
    }
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers: response.headers };
  });
}

/**
 * Run one request under the caller's signal and its own timeout, combined, and
 * release both when it settles.
 */
async function withRequestBudget<T>(
  options: Pick<HttpGetOptions, 'timeoutMs' | 'signal'>,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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
    return await run(controller.signal);
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
