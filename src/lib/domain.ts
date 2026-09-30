/**
 * Domain contracts.
 *
 * Three kinds of number live in this application and they are deliberately
 * never interchangeable:
 *
 *   - a **quota gauge** (`usedPercent`, 0..100) — how much of a *window* is
 *     spent; it falls back to zero when the window resets;
 *   - a **cumulative counter** (`totalUsage`) — monotonically rising spend that
 *     is only meaningful as a delta between two observations;
 *   - a **money balance** (`totalBalance`, `remainingCredit`, …) — a decimal
 *     amount in a specific currency.
 *
 * A discriminated union keeps them from being summed, averaged, or rendered
 * through the same component by accident.
 */
import type { MoneyString } from './money';
import type { ErrorCode } from './errors';

export const PROVIDERS = ['codex', 'claude', 'deepseek', 'openrouter', 'opencode_go'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Providers whose key is saved in dashboard Settings (plan §3.5). DeepSeek,
 * OpenRouter and OpenCode Go report nothing without theirs. The Claude token is optional and
 * belongs to a source, not the provider: it only enables the quota probe of plan
 * §3.1, and Claude keeps reporting through the status-line spool without it.
 * Codex authenticates through its own CLI and has no key here.
 */
export const CREDENTIAL_PROVIDERS = ['deepseek', 'openrouter', 'opencode_go', 'claude'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export function isCredentialProvider(value: string): value is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * What the browser may learn about a saved key. It never carries the key: only
 * whether one is saved, its last four characters when the key is long enough
 * for that to reveal little, and when it was saved.
 */
export interface CredentialStatus {
  readonly provider: CredentialProvider;
  readonly configured: boolean;
  readonly hint: string | null;
  readonly updatedAt: string | null;
}

/**
 * `sourceVersion` of a Claude observation read by the optional quota probe
 * (plan §3.1): the rate-limit headers of a minimal Messages API request. A
 * status-line observation carries `claude-code/<version>` instead, which is how
 * freshness tells the two sources apart.
 */
export const CLAUDE_PROBE_SOURCE_VERSION = 'claude-api/ratelimit-headers';

export const PROVIDER_LABELS: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  opencode_go: 'OpenCode Go',
};

/** What the provider card is measuring. Drives which component renders it. */
export type SnapshotKind = 'quota' | 'credit';

export const PROVIDER_KIND: Record<Provider, SnapshotKind> = {
  codex: 'quota',
  claude: 'quota',
  deepseek: 'credit',
  openrouter: 'credit',
  opencode_go: 'quota',
};

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * One rate-limit window.
 *
 * `bucketId` is the provider's own identifier (`codex`, `five_hour`) and is
 * what the UI labels from — never the position in an array. `usedPercent` is
 * stored exactly as the source reported it; `remainingPercent` is derived at
 * presentation time so source fidelity survives for diagnostics.
 */
export interface QuotaWindow {
  readonly bucketId: string;
  /** `primary` / `secondary` for Codex, `five_hour` / `seven_day` for Claude. */
  readonly windowKind: string;
  readonly usedPercent: number;
  readonly windowDurationMinutes: number | null;
  /** UTC ISO-8601. `null` when the source did not supply a reset time. */
  readonly resetsAt: string | null;
}

export interface QuotaSnapshot {
  readonly kind: 'quota';
  readonly provider: Provider;
  /** When the *source* observed the data (UTC ISO-8601). */
  readonly observedAt: string;
  /** When this process recorded it (UTC ISO-8601). */
  readonly collectedAt: string;
  /** Upstream version string, e.g. `codex-cli/0.154.0`. */
  readonly sourceVersion: string;
  /** Bumped when this adapter's field selection changes. */
  readonly schemaVersion: number;
  /**
   * Backend permission for ordinary included usage. `null` means the source did
   * not say — never infer recovery from percentages or reset times.
   */
  readonly usageAllowed: boolean | null;
  /** Provider-specific "you are cut off" marker, when reported. */
  readonly limitReachedCode: string | null;
  /** Dedupe key for event-driven sources; `null` for polled sources. */
  readonly sourceEventId: string | null;
  readonly windows: readonly QuotaWindow[];
}

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

/**
 * One currency's balance. Every monetary field is a canonical decimal string.
 *
 * DeepSeek populates the `*Balance` fields; OpenRouter populates
 * `totalCredits` / `totalUsage` / `remainingCredit`. They are kept in one row
 * type because both are "money in a currency", but no consumer may add a
 * balance to a credit total.
 */
export interface CreditBalance {
  readonly currency: string;
  readonly totalBalance: MoneyString | null;
  readonly grantedBalance: MoneyString | null;
  readonly toppedUpBalance: MoneyString | null;
  readonly totalCredits: MoneyString | null;
  /** Cumulative counter, not a gauge. Only deltas between rows are meaningful. */
  readonly totalUsage: MoneyString | null;
  readonly remainingCredit: MoneyString | null;
  readonly isAvailable: boolean | null;
}

export interface CreditSnapshot {
  readonly kind: 'credit';
  readonly provider: Provider;
  readonly observedAt: string;
  readonly collectedAt: string;
  readonly sourceVersion: string;
  readonly schemaVersion: number;
  readonly sourceEventId: string | null;
  readonly balances: readonly CreditBalance[];
}

export type ProviderSnapshot = QuotaSnapshot | CreditSnapshot;

// ---------------------------------------------------------------------------
// Collection outcome
// ---------------------------------------------------------------------------

export interface CollectionFailure {
  readonly provider: Provider;
  readonly attemptedAt: string;
  readonly code: ErrorCode;
  /** Already passed through `redactText`. */
  readonly safeMessage: string;
  readonly retryable: boolean;
}

export type CollectionResult =
  | {
      readonly outcome: 'success';
      readonly snapshot: ProviderSnapshot;
      readonly retryCount: number;
    }
  | {
      readonly outcome: 'unavailable' | 'error';
      readonly failure: CollectionFailure;
      readonly retryCount: number;
    }
  | {
      /** Nothing observed and another run owns the answer; never persisted. */
      readonly outcome: 'deferred';
      readonly reason: string;
      readonly retryCount: number;
    };

/**
 * The contract every source implements.
 *
 * Parameterised by the snapshot kind it produces, so a quota adapter is
 * statically known to yield windows and a credit adapter to yield balances.
 * The collector stores them as the unparameterised union, where the
 * discriminant is what keeps the two apart.
 */
export interface ProviderAdapter<S extends ProviderSnapshot = ProviderSnapshot> {
  readonly provider: Provider;
  readonly schemaVersion: number;
  /** Independent per-adapter budget in milliseconds. */
  readonly timeoutMs: number;
  collect(signal: AbortSignal, context?: CollectContext): Promise<S>;
}

/**
 * Per-attempt hooks the collector hands to an adapter.
 *
 * Scoped to one `collect` call rather than stored on the adapter, so two
 * overlapping runs of the same adapter never share a counter.
 */
export interface CollectContext {
  /** Called once before each retry, so the attempt row records the real count. */
  recordRetry(): void;
}

// ---------------------------------------------------------------------------
// Presentation state (always derived at query time, never stored)
// ---------------------------------------------------------------------------

export type CardStatus = 'healthy' | 'stale' | 'unavailable' | 'error';

export type AdvisoryState = 'ok' | 'watch' | 'switch_suggested' | 'unknown';

export interface AdvisoryReason {
  /** Which window or currency triggered this, e.g. `five_hour` or `USD`. */
  readonly subject: string;
  readonly metric: 'quota_remaining_percent' | 'balance_remaining' | 'freshness';
  /** Canonical decimal string or percentage, as observed. */
  readonly observed: string;
  /** The configured threshold that fired, when one did. */
  readonly threshold: string | null;
  readonly message: string;
}

export interface Advisory {
  readonly state: AdvisoryState;
  readonly reasons: readonly AdvisoryReason[];
}
