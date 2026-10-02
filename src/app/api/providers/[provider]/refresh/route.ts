/**
 * POST /api/providers/:provider/refresh — manual, provider-scoped collection.
 *
 * `POST` because it has side effects (it talks to the upstream and writes a
 * row); a `GET` would be prefetchable by the browser and linkable from
 * anywhere. Same-origin is enforced before anything runs, and a local rate
 * limit keeps a held-down button from becoming an upstream problem.
 *
 * The refresh is scoped to one provider and runs through the same
 * `collectOnce` path as the scheduled collector, so a manual refresh cannot
 * develop different semantics from a timed one.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { isProvider } from '@/lib/domain';
import { collectOnce } from '@/lib/collector/index';
import { buildOverview } from '@/lib/queries/overview';
import { db } from '@/lib/server/db';
import { jsonError, refreshLimiter, requireSameOrigin } from '@/lib/server/security';
import { createLogger } from '@/lib/logger';
import { safeErrorMessage } from '@/lib/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const config = getConfig();

  const guard = requireSameOrigin(request, config);
  if (!guard.ok) return jsonError(guard) as NextResponse;

  const { provider } = await context.params;
  if (!isProvider(provider)) {
    return NextResponse.json(
      { error: { code: 'invalid_provider', message: 'Unknown provider.' } },
      { status: 400 },
    );
  }

  // A development server without AUD_DEV_LIVE_REFRESH=1 refuses here, before
  // the limiter, the database, or any adapter, so a refused refresh spends no
  // slot and leaves no run or attempt behind.
  if (!config.refreshEnabled) {
    return NextResponse.json(
      {
        error: {
          code: 'refresh_disabled',
          message:
            'Manual refresh is disabled on this development server. Restart pnpm run dev with AUD_DEV_LIVE_REFRESH=1 to enable it.',
        },
      },
      { status: 409 },
    );
  }

  const retryAfter = refreshLimiter.check(provider);
  if (retryAfter !== null) {
    return NextResponse.json(
      {
        error: {
          code: 'rate_limited',
          message: `Too many refreshes for this provider. Try again in ${retryAfter}s.`,
        },
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  try {
    const database = db();
    const summary = await collectOnce({
      db: database,
      config,
      trigger: 'manual',
      providers: [provider],
      logger: createLogger(config.logLevel, { component: 'refresh', provider }),
      // Retention is a scheduled-run concern; a manual refresh stays fast.
      applyRetentionPolicy: false,
    });

    // Returning the refreshed overview lets the client update without a second
    // round trip, and guarantees the status it shows was derived from the row
    // this request just wrote.
    const overview = buildOverview(database, config);
    const card = overview.cards.find((c) => c.provider === provider);

    return NextResponse.json(
      { provider, summary, card },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'refresh_failed', message: safeErrorMessage(err) } },
      { status: 500 },
    );
  }
}

/** A refresh must not be reachable by navigation or prefetch. */
export function GET(): NextResponse {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'Use POST to refresh a provider.' } },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
