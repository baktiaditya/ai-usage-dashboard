/**
 * GET /api/settings/credentials — whether each provider key is saved.
 *
 * The body is derived from saved credentials, so this read requires a
 * same-origin request too: another page must not learn which keys exist. It
 * carries only `CredentialStatus` values, never a key.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { listCredentialStatus } from '@/lib/db/credentials';
import { safeErrorMessage } from '@/lib/redact';
import { db } from '@/lib/server/db';
import { requireSameOrigin } from '@/lib/server/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function GET(request: NextRequest): NextResponse {
  try {
    const guard = requireSameOrigin(request, getConfig());
    if (!guard.ok) {
      return noStore({ error: { code: guard.code, message: guard.message } }, guard.status);
    }
    return noStore({ credentials: listCredentialStatus(db()) });
  } catch (err) {
    return noStore({ error: { code: 'settings_failed', message: safeErrorMessage(err) } }, 500);
  }
}
