/**
 * Backing up and restoring the SQLite database.
 *
 * Copying `usage.db` is not a backup. In WAL mode the newest rows can exist only
 * in `usage.db-wal`, and a copy taken during a write can be torn. SQLite's
 * online backup API reads one consistent snapshot, WAL included, while the
 * collector and the web server keep writing. Each backup is sealed as a single
 * owner-only file in rollback-journal mode, with no sidecar to lose on the way.
 *
 * Restore is where history is actually lost, so it refuses rather than guesses:
 *
 * - while any process holds the database open, because that process keeps
 *   writing to the file it opened, not to the one restored under its name;
 * - when the backup is not an intact database of this application, or was
 *   written by a newer schema than this build knows;
 * - when a non-empty WAL sits beside the backup, since the file alone is
 *   missing the rows in it.
 *
 * The database being replaced is moved aside together with its `-wal` and
 * `-shm`, never left in place. SQLite replays a WAL it finds beside a database
 * on the next open, and nothing ties the WAL to the file it was written for: a
 * restored file with the old WAL still beside it opens as the old database, and
 * passes `integrity_check`.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './client';
import { MIGRATIONS } from './migrations.generated';

export class BackupError extends Error {
  override readonly name = 'BackupError';
}

/** The newest schema this build can read. */
export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_HEADER = 'SQLite format 3\0';

/** Files SQLite pairs with a database purely by name. */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function withSidecars(path: string): string[] {
  return [path, ...SIDECAR_SUFFIXES.map((suffix) => `${path}${suffix}`)];
}

function removeWithSidecars(path: string): void {
  for (const file of withSidecars(path)) rmSync(file, { force: true });
}

function moveWithSidecars(from: string, to: string): void {
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

/** `2026-09-14T01:02:03.456Z` becomes `20260914T010203456Z`: sortable, and safe in a file name. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

export interface DatabaseSummary {
  /** The highest applied migration. */
  readonly schemaVersion: number;
  readonly runs: number;
}

function isSqliteFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString('latin1') === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

/** Require an intact database of this application that this build can read. */
function inspect(sqlite: Database.Database, label: string): DatabaseSummary {
  if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new BackupError(`${label} failed SQLite's integrity check`);
  }
  const hasTable = (name: string) =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined;
  if (!hasTable('schema_migrations') || !hasTable('collector_runs')) {
    throw new BackupError(`${label} is not an AI Usage Dashboard database`);
  }
  const { version } = sqlite
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as {
    version: number | null;
  };
  if (version === null) {
    throw new BackupError(`${label} records no applied migration`);
  }
  if (version > LATEST_SCHEMA_VERSION) {
    throw new BackupError(
      `${label} has schema version ${version}, newer than the ${LATEST_SCHEMA_VERSION} this build knows. Restore it with the build that wrote it`,
    );
  }
  const { runs } = sqlite.prepare('SELECT COUNT(*) AS runs FROM collector_runs').get() as {
    runs: number;
  };
  return { schemaVersion: version, runs };
}

/** Process IDs holding any of `paths` open, read from `/proc`. */
export function processesHolding(paths: readonly string[]): number[] {
  const wanted = new Set(
    paths.filter((path) => existsSync(path)).map((path) => realpathSync(path)),
  );
  if (wanted.size === 0) return [];

  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    throw new BackupError(
      'cannot tell whether the database is in use: /proc is unavailable on this platform',
    );
  }

  const holders: number[] = [];
  for (const pid of entries.filter((entry) => /^\d+$/.test(entry))) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // exited, or not ours to inspect
    }
    const holds = fds.some((fd) => {
      try {
        return wanted.has(readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch {
        return false; // closed while scanning
      }
    });
    if (holds) holders.push(Number(pid));
  }
  return holders;
}

function assertNotInUse(database: string): void {
  const holders = processesHolding(withSidecars(database));
  if (holders.length > 0) {
    throw new BackupError(
      `the database is open in process ${holders.join(', ')}. Stop ai-usage-dashboard-web.service, ai-usage-dashboard-collector.timer, and any npm run dev or npm run start, then retry`,
    );
  }
}

/** Switch a copy to a rollback journal, so it is one self-contained file, and verify it. */
function seal(path: string, label: string): DatabaseSummary {
  chmodSync(path, 0o600);
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    sqlite.pragma('journal_mode = DELETE');
    return inspect(sqlite, label);
  } finally {
    sqlite.close();
  }
}

/**
 * Write a consistent, self-contained copy of `source` to `destination`.
 * Safe while other processes read and write the source.
 */
export async function backupDatabase(
  source: string,
  destination: string,
): Promise<DatabaseSummary> {
  if (!existsSync(source)) throw new BackupError(`there is no database at ${source}`);
  if (existsSync(destination)) throw new BackupError(`refusing to overwrite ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });

  // Written under a temporary name and renamed only once sealed and verified,
  // so an interrupted backup never looks like a finished one.
  const partial = `${destination}.partial`;
  removeWithSidecars(partial);
  closeSync(openSync(partial, 'w', 0o600));
  try {
    const sqlite = new Database(source, { readonly: true, fileMustExist: true });
    try {
      sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      await sqlite.backup(partial);
    } finally {
      sqlite.close();
    }
    const summary = seal(partial, 'the new backup');
    renameSync(partial, destination);
    return summary;
  } catch (err) {
    removeWithSidecars(partial);
    throw err;
  }
}

export interface RestoreResult extends DatabaseSummary {
  /** Migrations applied to bring the backup up to this build's schema. */
  readonly migrated: number;
  /** Where the replaced database was moved, or `null` when there was none. */
  readonly previous: string | null;
}

/**
 * Replace the database at `target` with the backup at `source`.
 *
 * The backup is copied, verified, and migrated under a temporary name first, so
 * a refused or failed restore leaves the current database exactly as it was.
 */
export function restoreDatabase(source: string, target: string, now = new Date()): RestoreResult {
  const from = resolve(source);
  const to = resolve(target);
  if (from === to) throw new BackupError('the backup and the database are the same file');
  if (!existsSync(from)) throw new BackupError(`there is no backup at ${from}`);
  if (!isSqliteFile(from)) throw new BackupError(`${from} is not a SQLite database`);
  const wal = `${from}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new BackupError(
      `${from} has a non-empty WAL beside it, so the file alone is missing its newest rows. Take backups with npm run db:backup rather than copying the database file`,
    );
  }
  assertNotInUse(to);

  const previous = `${to}.pre-restore-${backupStamp(now)}`;
  if (existsSync(previous)) throw new BackupError(`${previous} already exists`);

  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const staging = `${to}.restoring`;
  removeWithSidecars(staging);

  let summary: DatabaseSummary;
  let migrated: number;
  try {
    copyFileSync(from, staging);
    chmodSync(staging, 0o600);
    const sqlite = new Database(staging, { fileMustExist: true });
    try {
      sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      sqlite.pragma('journal_mode = DELETE');
      inspect(sqlite, 'the backup');
      migrated = runMigrations(sqlite);
      summary = inspect(sqlite, 'the migrated backup');
    } finally {
      sqlite.close();
    }
    // Checked again at the swap: a timer run may have started meanwhile.
    assertNotInUse(to);
  } catch (err) {
    removeWithSidecars(staging);
    throw err;
  }

  const replaced = withSidecars(to).some((file) => existsSync(file));
  if (replaced) moveWithSidecars(to, previous);
  renameSync(staging, to);
  return { ...summary, migrated, previous: replaced ? previous : null };
}
