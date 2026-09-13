'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Info,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ProviderLogo } from '@/components/provider-logo';
import type { ProviderCard as ProviderCardData } from '@/lib/queries/overview';
import type { AdvisoryState, CardStatus } from '@/lib/domain';
import { formatMoney } from '@/lib/money';
import { formatAge } from '@/lib/time';
import { cn } from '@/lib/cn';

const STATUS_META: Record<
  CardStatus,
  { label: string; tone: 'healthy' | 'stale' | 'unavailable' | 'error'; Icon: typeof CheckCircle2 }
> = {
  healthy: { label: 'Healthy', tone: 'healthy', Icon: CheckCircle2 },
  stale: { label: 'Stale', tone: 'stale', Icon: Clock },
  unavailable: { label: 'Unavailable', tone: 'unavailable', Icon: CircleSlash },
  error: { label: 'Error', tone: 'error', Icon: XCircle },
};

const ADVISORY_META: Record<
  AdvisoryState,
  { label: string; tone: 'healthy' | 'stale' | 'error' | 'neutral' }
> = {
  ok: { label: 'OK', tone: 'healthy' },
  watch: { label: 'Watch', tone: 'stale' },
  switch_suggested: { label: 'Switch suggested', tone: 'error' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

function absoluteTime(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export interface ProviderCardProps {
  readonly card: ProviderCardData;
  readonly timezone: string;
  readonly onRefreshed: (card: ProviderCardData) => void;
}

export function ProviderCardView({ card, timezone, onRefreshed }: ProviderCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const status = STATUS_META[card.status];
  const advisory = ADVISORY_META[card.advisory.state];

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/providers/${card.provider}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Same-origin only; the server rejects anything else.
        credentials: 'same-origin',
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message =
          (body as { error?: { message?: string } })?.error?.message ?? 'Refresh failed.';
        setRefreshError(message);
        return;
      }
      const next = (body as { card?: ProviderCardData }).card;
      if (next) onRefreshed(next);
    } catch {
      setRefreshError('Could not reach the local dashboard server.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card data-testid={`card-${card.provider}`} data-status={card.status}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 pb-1">
            <ProviderLogo provider={card.provider} className="size-5 shrink-0" />
            {card.label}
          </CardTitle>
          <Badge tone={status.tone} data-testid={`status-${card.provider}`}>
            <status.Icon aria-hidden className="size-3.5" />
            {status.label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={advisory.tone} data-testid={`advisory-${card.provider}`}>
            {advisory.label}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {card.kind === 'quota' ? 'Subscription quota' : 'Prepaid balance'}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/*
          A card that is not healthy still shows its last known numbers, but it
          must never let them read as current. This banner is that contract.
        */}
        {card.showingLastKnownValues ? (
          <p
            className="bg-stale-bg text-stale flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
            data-testid={`last-known-${card.provider}`}
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Showing last known values from{' '}
              {card.dataAgeMs !== null ? `${formatAge(card.dataAgeMs)} ago` : 'an earlier run'}.
              These are not current.
            </span>
          </p>
        ) : null}

        {card.status === 'unavailable' &&
        card.windows.length === 0 &&
        card.balances.length === 0 ? (
          <EmptyState reason={card.statusReason} hint={card.diagnostics.hint} />
        ) : null}

        {card.kind === 'quota' ? (
          <QuotaWindows card={card} timezone={timezone} tone={status.tone} />
        ) : (
          <CreditBalances card={card} />
        )}

        <AdvisoryReasons card={card} />
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-3">
        <dl className="text-muted-foreground grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="font-medium">Source observed</dt>
            <dd className="tabular" data-testid={`observed-${card.provider}`}>
              {absoluteTime(card.sourceObservedAt, timezone)}
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="font-medium">Last collection</dt>
            <dd className="tabular">{absoluteTime(card.lastSuccessfulCollectionAt, timezone)}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="font-medium">Data age</dt>
            <dd className="tabular" data-testid={`age-${card.provider}`}>
              {card.dataAgeMs === null ? '—' : formatAge(card.dataAgeMs)}
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="font-medium">Source version</dt>
            <dd className="truncate font-mono text-[11px]">{card.sourceVersion ?? '—'}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            data-testid={`refresh-${card.provider}`}
            className={cn(
              'border-border bg-surface hover:bg-surface-muted inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <RefreshCw aria-hidden className={cn('size-3.5', refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>

          <button
            type="button"
            onClick={() => setShowDiagnostics((v) => !v)}
            aria-expanded={showDiagnostics}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
          >
            <Info aria-hidden className="size-3.5" />
            Diagnostics
          </button>

          <span aria-live="polite" className="sr-only">
            {refreshing ? `Refreshing ${card.label}` : ''}
          </span>
        </div>

        {refreshError ? (
          <p
            className="text-danger text-xs"
            role="alert"
            data-testid={`refresh-error-${card.provider}`}
          >
            {refreshError}
          </p>
        ) : null}

        {showDiagnostics ? <Diagnostics card={card} timezone={timezone} /> : null}
      </CardFooter>
    </Card>
  );
}

function EmptyState({ reason, hint }: { reason: string; hint: string | null }) {
  return (
    <div className="border-border text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-xs">
      <p className="text-foreground mb-1 font-medium">Nothing collected yet</p>
      <p>{reason}</p>
      {hint ? <p className="mt-1">{hint}</p> : null}
    </div>
  );
}

function QuotaWindows({
  card,
  timezone,
  tone,
}: {
  card: ProviderCardData;
  timezone: string;
  tone: 'healthy' | 'stale' | 'unavailable' | 'error';
}) {
  if (card.windows.length === 0 && card.endedWindows.length === 0) return null;

  // An ended window sits where it always did, shortest window first, so the
  // "5 hour" row does not jump below "7 day" while it waits for a new window.
  // The sort is stable: windows of equal length keep the source's order.
  const rows = [
    ...card.windows.map((w) => ({ ended: false as const, w })),
    ...card.endedWindows.map((w) => ({ ended: true as const, w })),
  ].sort(
    (a, b) =>
      (a.w.windowDurationMinutes ?? Number.POSITIVE_INFINITY) -
      (b.w.windowDurationMinutes ?? Number.POSITIVE_INFINITY),
  );

  // A bucket name only earns its place when two windows would otherwise read
  // the same ("5 hour" in two Codex buckets). With one bucket, or when the
  // bucket is the window itself (Claude's `five_hour`), it just repeats the label.
  const labelCounts = new Map<string, number>();
  for (const { w } of rows) labelCounts.set(w.label, (labelCounts.get(w.label) ?? 0) + 1);

  const heading = (w: { label: string; bucketId: string }) => (
    <span className="text-sm font-medium">
      {w.label}
      {(labelCounts.get(w.label) ?? 0) > 1 ? (
        <span className="text-muted-foreground ml-1.5 text-xs font-normal">{w.bucketId}</span>
      ) : null}
    </span>
  );

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) =>
        row.ended ? (
          <li
            key={`${row.w.bucketId}-${row.w.windowKind}`}
            data-testid={`window-ended-${card.provider}-${row.w.windowKind}`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              {heading(row.w)}
              <span className="text-muted-foreground text-xs">not started</span>
            </div>
            <p className="text-muted-foreground text-[11px]">
              ended {absoluteTime(row.w.endedAt, timezone)} · no new window reported yet
            </p>
          </li>
        ) : (
          <li
            key={`${row.w.bucketId}-${row.w.windowKind}`}
            data-testid={`window-${card.provider}-${row.w.windowKind}`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              {heading(row.w)}
              <span className="tabular text-sm font-semibold">
                {row.w.remainingPercent.toFixed(1)}%
                <span className="text-muted-foreground ml-1 text-xs font-normal">left</span>
              </span>
            </div>
            <Progress
              remainingPercent={row.w.remainingPercent}
              tone={tone}
              label={`${card.label} ${row.w.label} quota remaining`}
            />
            <p className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-[11px]">
              <span className="tabular">used {row.w.usedPercent.toFixed(1)}%</span>
              <span>
                {row.w.resetsAt === null ? (
                  'reset time unknown'
                ) : (
                  <>
                    resets {absoluteTime(row.w.resetsAt, timezone)}
                    {row.w.resetPassed ? ' (already passed)' : ''}
                  </>
                )}
              </span>
            </p>
          </li>
        ),
      )}
    </ul>
  );
}

function CreditBalances({ card }: { card: ProviderCardData }) {
  if (card.balances.length === 0) return null;

  return (
    <ul className="flex flex-col gap-3">
      {card.balances.map((b) => (
        <li
          key={b.currency}
          className="bg-surface-muted rounded-lg px-3 py-2.5"
          data-testid={`balance-${card.provider}-${b.currency}`}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide uppercase">{b.currency}</span>
            {/*
              The provider's own verdict on whether this balance can still pay
              for API calls — not the collector's status, which the card header
              already shows. "Available" beside an "Unavailable" card read as a
              contradiction.
            */}
            {b.isAvailable === false ? (
              <Badge
                tone="error"
                title="The provider reports this balance cannot pay for API calls"
              >
                Insufficient for API
              </Badge>
            ) : b.isAvailable === true ? (
              <Badge tone="healthy" title="The provider reports this balance can pay for API calls">
                API usable
              </Badge>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
            {/*
              DeepSeek reports balances; OpenRouter reports credits, a cumulative
              usage counter, and the remainder. Only the fields a provider
              actually returned are shown — an absent field is never rendered as
              zero.
            */}
            <MoneyField label="Total balance" value={b.totalBalance} currency={b.currency} />
            <MoneyField label="Granted" value={b.grantedBalance} currency={b.currency} />
            <MoneyField label="Topped up" value={b.toppedUpBalance} currency={b.currency} />
            <MoneyField label="Total credits" value={b.totalCredits} currency={b.currency} />
            <MoneyField label="Total usage" value={b.totalUsage} currency={b.currency} />
            <MoneyField
              label="Remaining"
              value={b.remainingCredit}
              currency={b.currency}
              emphasise
            />
          </dl>
        </li>
      ))}
    </ul>
  );
}

function MoneyField({
  label,
  value,
  currency,
  emphasise = false,
}: {
  label: string;
  value: string | null;
  currency: string;
  emphasise?: boolean;
}) {
  if (value === null) return null;
  return (
    <div>
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className={cn('tabular', emphasise ? 'text-sm font-semibold' : 'text-xs font-medium')}>
        {formatMoney(value as never)}{' '}
        <span className="text-muted-foreground text-[10px]">{currency}</span>
      </dd>
    </div>
  );
}

function AdvisoryReasons({ card }: { card: ProviderCardData }) {
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none">
        Why {ADVISORY_META[card.advisory.state].label.toLowerCase()}? (
        {card.advisory.reasons.length} {card.advisory.reasons.length === 1 ? 'reason' : 'reasons'})
      </summary>
      <ul className="text-muted-foreground mt-2 flex flex-col gap-1.5">
        {card.advisory.reasons.map((r, i) => (
          <li key={`${r.subject}-${i}`} className="flex flex-col">
            <span className="text-foreground font-medium">{r.subject}</span>
            <span>{r.message}</span>
            {r.threshold ? (
              <span className="tabular text-[11px]">
                observed {r.observed} · threshold {r.threshold}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Diagnostics({ card, timezone }: { card: ProviderCardData; timezone: string }) {
  return (
    <dl
      className="bg-surface-muted text-muted-foreground grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg p-3 text-[11px] sm:grid-cols-2"
      data-testid={`diagnostics-${card.provider}`}
    >
      <Diag label="Status" value={card.status} />
      <Diag label="Status reason" value={card.statusReason} />
      <Diag label="Error code" value={card.diagnostics.errorCode ?? 'none'} />
      <Diag label="Hint" value={card.diagnostics.hint ?? '—'} />
      <Diag label="Safe message" value={card.diagnostics.safeMessage ?? '—'} />
      <Diag label="Retries" value={String(card.diagnostics.retryCount)} />
      <Diag
        label="Adapter schema"
        value={card.schemaVersion === null ? '—' : `v${card.schemaVersion}`}
      />
      <Diag label="Last attempt" value={absoluteTime(card.diagnostics.lastAttemptAt, timezone)} />
      <Diag label="Freshness budget" value={formatAge(card.freshnessBudgetMs)} />
      <Diag
        label="Usage allowed"
        value={card.usageAllowed === null ? 'not reported' : card.usageAllowed ? 'yes' : 'no'}
      />
    </dl>
  );
}

function Diag({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 sm:block">
      <dt className="font-medium">{label}</dt>
      <dd className="text-foreground break-words">{value}</dd>
    </div>
  );
}
