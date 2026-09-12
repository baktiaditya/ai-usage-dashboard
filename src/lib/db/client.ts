/**
 * SQLite connection and migration runner.
 *
 * Two processes write to this database: the systemd-scheduled collector and
 * the Next.js server handling manual refresh. WAL plus a generous
 * `busy_timeout` plus short transactions is what keeps them from colliding —
 * readers never block the writer, and a writer that arrives mid-transaction
 * waits instead of failing with SQLITE_BUSY.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { MIGRATIONS } from './migrations.generated';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const BUSY_TIMEOUT_MS = 5000;

/**
 * Apply every migration that has not been recorded yet, in version order.
 *
 * The SQL is imported as a static module rather than read from disk so the same
 * code path works in the bundled Next.js server, in the tsx CLI, and in Vitest.
 */
export function runMigrations(sqlite: Database.Database): number {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT',
  );
  const applied = new Set(
    sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );

  let count = 0;
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;

    // Each migration is atomic: either the whole file lands or none of it does.
    const tx = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    });
    tx();
    count += 1;
  }
  return count;
}

export interface OpenDbOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly migrate?: boolean;
}

/** Open (and by default migrate) the database. Callers must `close()`. */
export function openDb(options: OpenDbOptions): Db {
  const { path, readonly = false, migrate = true } = options;

  if (path !== ':memory:') {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const sqlite = new Database(path, { readonly });

  // WAL survives across connections; setting it on a readonly handle fails, so
  // only the writer configures it.
  if (!readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.pragma('foreign_keys = ON');

  if (migrate && !readonly) {
    runMigrations(sqlite);
    if (path !== ':memory:' && existsSync(path)) {
      // The database holds no secrets by design, but it does hold usage
      // history; keep it owner-only regardless.
      chmodSync(path, 0o600);
    }
  }

  return drizzle(sqlite, { schema }) as Db;
}

let shared: Db | null = null;

/**
 * Long-lived handle for the web server. The collector CLI opens its own
 * connection and closes it, which is what makes WAL concurrency worth having.
 */
export function getSharedDb(path: string): Db {
  shared ??= openDb({ path });
  return shared;
}

export function closeSharedDb(): void {
  shared?.$client.close();
  shared = null;
}
