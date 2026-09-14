/**
 * SQLite connection and migration runner.
 *
 * Two processes write to this database: the systemd-scheduled collector and
 * the Next.js server handling manual refresh. WAL plus a generous
 * `busy_timeout` plus short transactions is what keeps them from colliding —
 * readers never block the writer, and a writer that arrives mid-transaction
 * waits instead of failing with SQLITE_BUSY.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
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
  // The web server and the collector can open a fresh database at the same
  // moment. Reading the applied set outside a write lock lets both see it empty
  // and both run the same DDL. `BEGIN IMMEDIATE` takes the write lock before
  // the read, so the second process waits out `busy_timeout`, re-reads, and
  // finds nothing left to do. The pending set lands together or not at all.
  const migrate = sqlite.transaction(() => {
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
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      count += 1;
    }
    return count;
  });
  return migrate.immediate();
}

export interface OpenDbOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly migrate?: boolean;
}

/** Open (and by default migrate) the database. Callers must `close()`. */
export function openDb(options: OpenDbOptions): Db {
  const { path, readonly = false, migrate = true } = options;

  const onDisk = path !== ':memory:';
  if (onDisk) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!readonly) ensureOwnerOnly(path);
  }

  const sqlite = new Database(path, { readonly });

  // Before anything that can contend for a lock — including the switch to WAL,
  // which needs an exclusive one on a fresh file — so a second opener waits
  // instead of failing with "database is locked".
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // WAL survives across connections; setting it on a readonly handle fails, so
  // only the writer configures it.
  if (!readonly) {
    enableWal(sqlite);
    sqlite.pragma('synchronous = NORMAL');
  }
  sqlite.pragma('foreign_keys = ON');

  if (migrate && !readonly) {
    runMigrations(sqlite);
  }

  return drizzle(sqlite, { schema }) as Db;
}

/**
 * Switch to WAL, waiting out a concurrent opener.
 *
 * Converting a fresh file to WAL needs an exclusive lock, and SQLite answers
 * `SQLITE_BUSY` on that path without consulting `busy_timeout`. When the web
 * server and the collector open a new database together, one of them would
 * fail outright; retrying for the same budget gives it the wait it expected.
 */
function enableWal(sqlite: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      sqlite.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const busy = (err as { code?: string }).code?.startsWith('SQLITE_BUSY') ?? false;
      if (!busy || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/**
 * Keep the database and its WAL/SHM sidecars owner-only.
 *
 * The database holds no secrets by design, but it does hold usage history.
 * SQLite creates `-wal` and `-shm` with the *main file's* permissions, so the
 * main file is created `0600` before SQLite ever opens it; chmod'ing it
 * afterwards would leave sidecars already created under a permissive umask
 * world-readable. Existing files from an older install are tightened too.
 *
 * An existing database file is never opened here, only created when absent.
 * SQLite's locks are POSIX advisory locks, which belong to the process, and
 * closing *any* descriptor on the file releases all of them. The Next.js server
 * bundles this module more than once, so a second `openDb` in a process that
 * already holds a connection would drop that connection's locks. The next
 * collector to close would then believe it was the last connection,
 * checkpoint, and delete the WAL and SHM the server is still using, and the
 * server would read a stale database until it reported it malformed.
 */
function ensureOwnerOnly(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
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
