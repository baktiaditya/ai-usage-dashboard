/**
 * Server-side database access for Route Handlers.
 *
 * Kept apart from the collector CLI so the web process holds one long-lived
 * connection (WAL readers are cheap) while the CLI opens and closes its own.
 */
import 'server-only';
import { getConfig } from '../config';
import { getSharedDb } from '../db/client';
import type { Db } from '../db/client';

export function db(): Db {
  return getSharedDb(getConfig().databasePath);
}
