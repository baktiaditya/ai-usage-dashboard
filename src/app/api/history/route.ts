/**
 * GET /api/history?provider=…&range=today|7d|30d
 *
 * Dispatches on the provider's metric type: quota providers get utilisation
 * series, credit providers get deltas with an explicit availability verdict.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { PROVIDER_KIND, isProvider } from '@/lib/domain';
import { buildCreditHistory, buildQuotaHistory, isHistoryRange } from '@/lib/queries/history';
import { db } from '@/lib/server/db';
import { safeErrorMessage } from '@/lib/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const provider = params.get('provider') ?? '';
  const range = params.get('range') ?? '7d';

  if (!isProvider(provider)) {
    return NextResponse.json(
      { error: { code: 'invalid_provider', message: 'Unknown provider.' } },
      { status: 400 },
    );
  }
  if (!isHistoryRange(range)) {
    return NextResponse.json(
      { error: { code: 'invalid_range', message: 'Range must be today, 7d or 30d.' } },
      { status: 400 },
    );
  }

  try {
    const config = getConfig();
    const result =
      PROVIDER_KIND[provider] === 'quota'
        ? buildQuotaHistory(db(), config, provider, range)
        : buildCreditHistory(db(), config, provider, range);

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'history_failed', message: safeErrorMessage(err) } },
      { status: 500 },
    );
  }
}
