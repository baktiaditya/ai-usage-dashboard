/**
 * Keys saved in dashboard Settings, read for the opt-in live gates.
 *
 * Read-only and never migrating. Only the two absences that mean "no key yet"
 * are swallowed: a database file that does not exist, and a database without
 * the `provider_credentials` table. Anything else, such as a corrupt file or an
 * unreadable one, is thrown, so the live run fails instead of quietly skipping
 * its provider gates. A key is never printed.
 */
import { statSync } from 'node:fs';
import { openDb } from '@/lib/db/client';
import { readProviderCredentials } from '@/lib/db/credentials';
import type { ProviderCredentials } from '@/lib/db/credentials';

export function readSavedCredentials(databasePath: string): ProviderCredentials {
  // Checked first: opening a path that does not exist creates its directory.
  // Only ENOENT means absent. `existsSync` would also answer false for a path
  // it cannot reach, such as one under a directory without search permission.
  try {
    statSync(databasePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return noKeys();
    throw err;
  }
  const database = openDb({ path: databasePath, readonly: true, migrate: false });
  try {
    return readProviderCredentials(database);
  } catch (err) {
    if (isMissingCredentialsTable(err)) return noKeys();
    throw err;
  } finally {
    database.$client.close();
  }
}

function noKeys(): ProviderCredentials {
  return { deepseekApiKey: null, openrouterManagementKey: null };
}

function isMissingCredentialsTable(err: unknown): boolean {
  return err instanceof Error && err.message === 'no such table: provider_credentials';
}
