'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Settings } from 'lucide-react';
import { ProviderCardView } from '@/components/provider-card';
import { HistoryPanel } from '@/components/history-panel';
import { SettingsDialog } from '@/components/settings-dialog';
import type { Overview, ProviderCard } from '@/lib/queries/overview';
import { formatAge } from '@/lib/time';
import { cn } from '@/lib/cn';

export interface DashboardProps {
  readonly initialOverview: Overview;
}

/** Shared by Reload view and Settings, which sit side by side. */
const HEADER_BUTTON = cn(
  'border-border bg-surface hover:bg-surface-muted inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
  'disabled:cursor-not-allowed disabled:opacity-60',
);

/**
 * The overview is server-rendered once so the first paint is real data, then
 * polled to keep ages honest. Polling is a read of the local database, not of
 * any provider — the systemd timer owns upstream collection.
 */
export function Dashboard({ initialOverview }: DashboardProps) {
  const [overview, setOverview] = useState<Overview>(initialOverview);
  const [reloading, setReloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * Ages are relative to "now", but reading the clock during render would make
   * the server-rendered HTML and the first client render disagree. Seed it from
   * the timestamp the server already stamped, then tick it forward on the
   * client only.
   */
  const [now, setNow] = useState(() => Date.parse(initialOverview.generatedAt));

  const reload = useCallback(async () => {
    setReloading(true);
    try {
      const res = await fetch('/api/overview', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      setOverview((await res.json()) as Overview);
      setLoadError(null);
    } catch {
      setLoadError('Could not reach the local dashboard server.');
    } finally {
      setReloading(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void reload(), 60_000);
    return () => clearInterval(id);
  }, [reload]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onRefreshed = useCallback((next: ProviderCard) => {
    setOverview((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.provider === next.provider ? next : c)),
    }));
  }, []);

  const counts = overview.cards.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold sm:text-2xl">AI Usage Dashboard</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Subscription quota and prepaid balance across four providers · {overview.timezone}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reload()}
              disabled={reloading}
              data-testid="reload-overview"
              className={HEADER_BUTTON}
            >
              <RefreshCw aria-hidden className={cn('size-3.5', reloading && 'animate-spin')} />
              Reload view
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              data-testid="open-settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              className={HEADER_BUTTON}
            >
              <Settings aria-hidden className="size-3.5" />
              Settings
            </button>
          </div>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span data-testid="summary-counts">
            {counts['healthy'] ?? 0} healthy · {counts['stale'] ?? 0} stale ·{' '}
            {counts['unavailable'] ?? 0} unavailable · {counts['error'] ?? 0} error
          </span>
          <span>Collector interval: every {overview.collectIntervalMinutes} min</span>
          <span>View generated {relativeAge(now - Date.parse(overview.generatedAt))}</span>
        </div>

        {loadError ? (
          <p className="bg-danger-bg text-danger rounded-lg px-3 py-2 text-xs" role="alert">
            {loadError}
          </p>
        ) : null}
      </header>

      <section aria-label="Provider status" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {overview.cards.map((card) => (
          <ProviderCardView
            key={card.provider}
            card={card}
            timezone={overview.timezone}
            onRefreshed={onRefreshed}
          />
        ))}
      </section>

      <HistoryPanel cards={overview.cards} timezone={overview.timezone} />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <footer className="text-muted-foreground border-border border-t pt-4 text-xs">
        <p>
          Bound to 127.0.0.1. Quota gauges, cumulative usage counters and monetary balances are kept
          as separate measurements and are never combined into one figure.
        </p>
      </footer>
    </div>
  );
}

/** `formatAge` returns "just now" for sub-minute gaps, which already reads as a
 * complete phrase — appending "ago" to it would not. */
function relativeAge(ms: number): string {
  const age = formatAge(Math.max(0, ms));
  return age === 'just now' ? age : `${age} ago`;
}
