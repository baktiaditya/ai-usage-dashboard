/**
 * OpenRouter adapter — GET https://openrouter.ai/api/v1/credits
 *
 * Contract per https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits:
 *   { data: { total_credits: 100.5, total_usage: 25.75 } }
 *
 * Two things make this adapter fussier than it looks.
 *
 * 1. Both figures arrive as JSON *numbers*. `JSON.parse` would round them to a
 *    double, so `getJsonLossless` captures the literal source text and this
 *    module treats it as a decimal string throughout. `remaining` is then an
 *    exact decimal subtraction, not `100.5 - 25.75` in binary floating point.
 *
 * 2. The endpoint requires a **Management key**. An ordinary inference key
 *    (`sk-or-v1-…`) is rejected with HTTP 403, which is a different problem
 *    from a missing key (401) and gets its own error code so the setup hint can
 *    be specific.
 *
 * `total_usage` is a cumulative counter, not a gauge: only the delta between
 * two observations is meaningful, and a *negative* delta means the counter was
 * reset upstream, never that usage was negative.
 */
import { z } from 'zod';
import { CollectionError } from '../errors';
import type { CreditSnapshot, ProviderAdapter } from '../domain';
import { rawToMoney, subtractMoney } from '../money';
import { nowIso } from '../time';
import { getJsonLossless, withBoundedRetry } from './http';

export const OPENROUTER_SCHEMA_VERSION = 1;
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

/** OpenRouter denominates credits in USD only. */
export const OPENROUTER_CURRENCY = 'USD';

const moneyish = z.union([z.string(), z.object({ __rawNumber: z.string() })]);

const creditsResponseSchema = z
  .object({
    data: z
      .object({
        total_credits: moneyish,
        total_usage: moneyish,
      })
      .loose(),
  })
  .loose();

export function normalizeOpenrouterResponse(
  raw: unknown,
  observedAt: string = nowIso(),
): CreditSnapshot {
  const parsed = creditsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollectionError(
      'schema_mismatch',
      `credits payload missing required fields: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}`,
    );
  }

  const totalCredits = rawToMoney(parsed.data.data.total_credits);
  const totalUsage = rawToMoney(parsed.data.data.total_usage);

  if (totalCredits === null || totalUsage === null) {
    throw new CollectionError(
      'schema_mismatch',
      'total_credits/total_usage were not decimal values',
    );
  }

  return {
    kind: 'credit',
    provider: 'openrouter',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion: 'openrouter-api/v1-credits',
    schemaVersion: OPENROUTER_SCHEMA_VERSION,
    sourceEventId: null,
    balances: [
      {
        currency: OPENROUTER_CURRENCY,
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits,
        totalUsage,
        // Exact decimal subtraction. Can legitimately be negative when an
        // account is overdrawn, so it is not clamped.
        remainingCredit: subtractMoney(totalCredits, totalUsage),
        isAvailable: null,
      },
    ],
  };
}

export interface OpenrouterAdapterOptions {
  readonly managementKey: string | null;
  readonly timeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
}

export function createOpenrouterAdapter(
  options: OpenrouterAdapterOptions,
): ProviderAdapter<CreditSnapshot> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    provider: 'openrouter',
    schemaVersion: OPENROUTER_SCHEMA_VERSION,
    timeoutMs,
    async collect(signal: AbortSignal): Promise<CreditSnapshot> {
      if (!options.managementKey) {
        throw new CollectionError('not_configured', 'OPENROUTER_MANAGEMENT_KEY is not set');
      }
      const { value } = await withBoundedRetry(
        () =>
          getJsonLossless({
            url: options.url ?? OPENROUTER_CREDITS_URL,
            bearerToken: options.managementKey as string,
            timeoutMs,
            signal,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
        { maxRetries: options.maxRetries ?? 2, baseDelayMs: 500, signal },
      );
      return normalizeOpenrouterResponse(value);
    },
  };
}
