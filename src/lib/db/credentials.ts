/**
 * Provider keys saved from dashboard Settings (plan §3.5).
 *
 * Keys are stored in plaintext; the database file's owner-only mode is their
 * protection, as it was for `collector.env`. Two rules keep a key inside the
 * process: a `CredentialStatus` never carries the secret, and its hint shows
 * the last four characters only of a key long enough for that to reveal little.
 *
 * Collection reads keys here at the start of every run and never caches them,
 * so a key saved in Settings applies to the next run without a restart.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CREDENTIAL_PROVIDERS } from '../domain';
import type { CredentialProvider, CredentialStatus } from '../domain';
import { nowIso } from '../time';
import type { Db } from './client';
import { providerCredentials } from './schema';

export interface ProviderCredentials {
  readonly deepseekApiKey: string | null;
  readonly openrouterManagementKey: string | null;
  /** Optional: a `claude setup-token` token that enables the Claude quota probe. */
  readonly claudeUsageToken: string | null;
}

/** A key shorter than this shows no hint, so it is never mostly revealed. */
const MIN_HINTED_LENGTH = 16;

/**
 * A pasted key often carries a trailing newline or space, so surrounding
 * whitespace is removed first and the trimmed value is what gets stored. The
 * pattern then runs on that value only: 1–512 printable ASCII characters with
 * no whitespace inside.
 */
export const credentialSecretSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7E]+$/),
  );

export function credentialHint(secret: string): string | null {
  return secret.length >= MIN_HINTED_LENGTH ? secret.slice(-4) : null;
}

function savedStatus(row: typeof providerCredentials.$inferSelect): CredentialStatus {
  return {
    provider: row.provider,
    configured: true,
    hint: credentialHint(row.secret),
    updatedAt: row.updatedAt,
  };
}

function unsavedStatus(provider: CredentialProvider): CredentialStatus {
  return { provider, configured: false, hint: null, updatedAt: null };
}

export function readProviderCredentials(db: Db): ProviderCredentials {
  const secrets = new Map(
    db
      .select({ provider: providerCredentials.provider, secret: providerCredentials.secret })
      .from(providerCredentials)
      .all()
      .map((row) => [row.provider, row.secret]),
  );
  return {
    deepseekApiKey: secrets.get('deepseek') ?? null,
    openrouterManagementKey: secrets.get('openrouter') ?? null,
    claudeUsageToken: secrets.get('claude') ?? null,
  };
}

/** Every credential provider, in `CREDENTIAL_PROVIDERS` order. */
export function listCredentialStatus(db: Db): CredentialStatus[] {
  const rows = new Map(
    db
      .select()
      .from(providerCredentials)
      .all()
      .map((row) => [row.provider, row]),
  );
  return CREDENTIAL_PROVIDERS.map((provider) => {
    const row = rows.get(provider);
    return row ? savedStatus(row) : unsavedStatus(provider);
  });
}

/**
 * Save or replace a provider's key. Throws on a secret the schema rejects; the
 * error names no part of the secret.
 */
export function saveProviderCredential(
  db: Db,
  provider: CredentialProvider,
  secret: string,
  updatedAt: string = nowIso(),
): CredentialStatus {
  const parsed = credentialSecretSchema.safeParse(secret);
  if (!parsed.success) {
    throw new Error(`invalid ${provider} credential: expected 1-512 printable characters`);
  }
  const row = { provider, secret: parsed.data, updatedAt };
  db.insert(providerCredentials)
    .values(row)
    .onConflictDoUpdate({
      target: providerCredentials.provider,
      set: { secret: row.secret, updatedAt: row.updatedAt },
    })
    .run();
  return savedStatus(row);
}

/** Idempotent: removing a key that is not saved still succeeds. */
export function removeProviderCredential(db: Db, provider: CredentialProvider): CredentialStatus {
  db.delete(providerCredentials).where(eq(providerCredentials.provider, provider)).run();
  return unsavedStatus(provider);
}
