/**
 * GET /api/overview — the whole dashboard state in one read.
 *
 * Node runtime, not Edge: this handler touches better-sqlite3.
 */
import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { buildOverview } from '@/lib/queries/overview';
import { db } from '@/lib/server/db';
import { safeErrorMessage } from '@/lib/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const overview = buildOverview(db(), getConfig());
    return NextResponse.json(overview, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'overview_failed', message: safeErrorMessage(err) } },
      { status: 500 },
    );
  }
}
