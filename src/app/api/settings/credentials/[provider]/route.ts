/**
 * PUT and DELETE /api/settings/credentials/:provider — save or remove a key.
 *
 * Same-origin is enforced before anything else. The request body is never
 * logged, and no response echoes the secret: success returns only the
 * provider's `CredentialStatus`.
 *
 * Saving neither validates the key upstream nor starts a collection, so these
 * writes are allowed on a development server whatever its refresh policy says.
 * They touch only that server's own database.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import {
  credentialSecretSchema,
  removeProviderCredential,
  saveProviderCredential,
} from '@/lib/db/credentials';
import { isCredentialProvider } from '@/lib/domain';
import type { CredentialProvider } from '@/lib/domain';
import { safeErrorMessage } from '@/lib/redact';
import { db } from '@/lib/server/db';
import { requireSameOrigin } from '@/lib/server/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ provider: string }>;
}

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function failure(status: number, code: string, message: string): NextResponse {
  return noStore({ error: { code, message } }, status);
}

const INVALID_PROVIDER = () =>
  failure(400, 'invalid_provider', 'Keys can be saved only for DeepSeek, OpenRouter, and Claude.');

/** Checks shared by both methods, in order: origin first, then the provider. */
async function guard(
  request: NextRequest,
  context: RouteContext,
): Promise<{ response: NextResponse } | { provider: CredentialProvider }> {
  const origin = requireSameOrigin(request, getConfig());
  if (!origin.ok) return { response: failure(origin.status, origin.code, origin.message) };
  const { provider } = await context.params;
  if (!isCredentialProvider(provider)) return { response: INVALID_PROVIDER() };
  return { provider };
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  let secret: string | null = null;
  try {
    const checked = await guard(request, context);
    if ('response' in checked) return checked.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure(400, 'invalid_body', 'Send a JSON body with a string "secret".');
    }
    const raw =
      typeof body === 'object' && body !== null ? (body as { secret?: unknown }).secret : undefined;
    if (typeof raw !== 'string') {
      return failure(400, 'invalid_body', 'Send a JSON body with a string "secret".');
    }

    const parsed = credentialSecretSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(
        400,
        'invalid_secret',
        'Enter the key exactly as issued: printable characters, no spaces.',
      );
    }
    secret = parsed.data;

    return noStore({ credential: saveProviderCredential(db(), checked.provider, secret) });
  } catch (err) {
    // Redaction knows common key shapes, not this one; scrub it explicitly.
    const message = safeErrorMessage(err);
    return failure(
      500,
      'settings_failed',
      secret ? message.split(secret).join('[redacted]') : message,
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const checked = await guard(request, context);
    if ('response' in checked) return checked.response;
    return noStore({ credential: removeProviderCredential(db(), checked.provider) });
  } catch (err) {
    return failure(500, 'settings_failed', safeErrorMessage(err));
  }
}
