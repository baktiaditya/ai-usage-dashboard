/**
 * Dashboard entry point.
 *
 * The overview is built on the server so the first paint carries real data
 * rather than a spinner. If the database cannot be opened at all — a brand new
 * checkout before `npm run db:migrate` — the page still renders with a clear
 * setup message instead of a stack trace.
 */
import { Dashboard } from '@/components/dashboard';
import { getConfig } from '@/lib/config';
import { buildOverview } from '@/lib/queries/overview';
import type { Overview } from '@/lib/queries/overview';
import { db } from '@/lib/server/db';
import { safeErrorMessage } from '@/lib/redact';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function Page() {
  let overview: Overview | null = null;
  let bootError: string | null = null;

  try {
    overview = buildOverview(db(), getConfig());
  } catch (err) {
    bootError = safeErrorMessage(err);
  }

  if (!overview) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-16">
        <h1 className="text-xl font-semibold">AI Usage Dashboard</h1>
        <div className="bg-danger-bg text-danger rounded-lg px-4 py-3 text-sm" role="alert">
          <p className="font-medium">The dashboard could not read its database.</p>
          <p className="mt-1 text-xs">{bootError}</p>
        </div>
        <div className="border-border rounded-lg border border-dashed px-4 py-3 text-sm">
          <p className="mb-2 font-medium">Set it up:</p>
          <pre className="bg-surface-muted overflow-x-auto rounded p-2 text-xs">
            npm run db:migrate{'\n'}npm run collect
          </pre>
          <p className="text-muted-foreground mt-2 text-xs">
            See docs/operations/setup.md for the full guide.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <Dashboard initialOverview={overview} />
    </main>
  );
}
