/**
 * DeepSeek adapter — GET https://api.deepseek.com/user/balance
 *
 * Contract per https://api-docs.deepseek.com/api/get-user-balance:
 *   { is_available: boolean, balance_infos: [{ currency, total_balance,
 *     granted_balance, topped_up_balance }] }
 *
 * This endpoint reports **balance only**. It exposes no usage figure, so every
 * label this adapter feeds is "balance" or "balance change" — never "usage".
 * A falling balance could equally be a expiring grant, and calling that usage
 * would be a fabricated number.
 *
 * All balance fields arrive as JSON *strings* ("110.00"), which is already
 * decimal-safe; they are re-canonicalised through `toMoney` anyway so storage
 * is consistent with OpenRouter's.
 */
import { z } from 'zod';
import { CollectionError } from '../errors';
import type { CollectContext, CreditBalance, CreditSnapshot, ProviderAdapter } from '../domain';
import { rawToMoney } from '../money';
import type { MoneyString } from '../money';
import { nowIso } from '../time';
import { getJsonLossless, losslessMoney, withBoundedRetry } from './http';

export const DEEPSEEK_SCHEMA_VERSION = 1;
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

// DeepSeek may omit a balance field, unlike OpenRouter.
const moneyish = losslessMoney.nullish();

const balanceInfoSchema = z
  .object({
    currency: z.string().min(1).max(16),
    total_balance: moneyish,
    granted_balance: moneyish,
    topped_up_balance: moneyish,
  })
  .loose();

const balanceResponseSchema = z
  .object({
    is_available: z.boolean().nullish(),
    balance_infos: z.array(balanceInfoSchema),
  })
  .loose();

/**
 * An absent field is `null`, as the provider intends. A field that is *present*
 * but not a decimal ("oops", "") is drift, and must fail the collection rather
 * than land as a healthy snapshot with a silently missing balance.
 */
function presentMoney(raw: unknown, field: string): MoneyString | null {
  if (raw === null || raw === undefined) return null;
  const money = rawToMoney(raw);
  if (money === null) {
    throw new CollectionError('schema_mismatch', `${field} was not a decimal value`);
  }
  return money;
}

export function normalizeDeepseekResponse(
  raw: unknown,
  observedAt: string = nowIso(),
): CreditSnapshot {
  const parsed = balanceResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollectionError(
      'schema_mismatch',
      `balance payload missing required fields: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}`,
    );
  }
  const data = parsed.data;

  // Every currency the account holds is kept. Mixing CNY into a USD total would
  // invent an exchange rate the provider never quoted.
  const balances: CreditBalance[] = data.balance_infos.map((info) => ({
    currency: info.currency.toUpperCase(),
    totalBalance: presentMoney(info.total_balance, 'total_balance'),
    grantedBalance: presentMoney(info.granted_balance, 'granted_balance'),
    toppedUpBalance: presentMoney(info.topped_up_balance, 'topped_up_balance'),
    totalCredits: null,
    totalUsage: null,
    remainingCredit: null,
    isAvailable: data.is_available ?? null,
  }));

  if (balances.length === 0) {
    throw new CollectionError('not_entitled', 'account reported no balance currencies');
  }

  // A currency appearing twice would violate the (snapshot, currency) unique
  // constraint; treat it as drift rather than letting the insert fail.
  const seen = new Set<string>();
  for (const b of balances) {
    if (seen.has(b.currency)) {
      throw new CollectionError('schema_mismatch', 'duplicate currency in balance_infos');
    }
    seen.add(b.currency);
  }

  return {
    kind: 'credit',
    provider: 'deepseek',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion: 'deepseek-api/user-balance',
    schemaVersion: DEEPSEEK_SCHEMA_VERSION,
    sourceEventId: null,
    balances,
  };
}

export interface DeepseekAdapterOptions {
  readonly apiKey: string | null;
  readonly timeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
}

export function createDeepseekAdapter(
  options: DeepseekAdapterOptions,
): ProviderAdapter<CreditSnapshot> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    provider: 'deepseek',
    schemaVersion: DEEPSEEK_SCHEMA_VERSION,
    timeoutMs,
    async collect(signal: AbortSignal, context?: CollectContext): Promise<CreditSnapshot> {
      if (!options.apiKey) {
        throw new CollectionError('not_configured', 'DEEPSEEK_API_KEY is not set');
      }
      const { value } = await withBoundedRetry(
        () =>
          getJsonLossless({
            url: options.url ?? DEEPSEEK_BALANCE_URL,
            bearerToken: options.apiKey as string,
            timeoutMs,
            signal,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
        {
          maxRetries: options.maxRetries ?? 2,
          baseDelayMs: 500,
          signal,
          onRetry: () => context?.recordRetry(),
        },
      );
      return normalizeDeepseekResponse(value);
    },
  };
}
