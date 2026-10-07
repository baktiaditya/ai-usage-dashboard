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
 * - when, once migrated, it lacks any table, column, index or trigger this
 *   build creates. Recorded migrations prove nothing on their own: a file can
 *   list every version and still be missing the tables they made;
 * - when a non-empty WAL sits beside the backup, since the file alone is
 *   missing the rows in it.
 *
 * The database being replaced is moved aside together with its `-wal` and
 * `-shm`, never left in place. SQLite replays a WAL it finds beside a database
 * on the next open, and nothing ties the WAL to the file it was written for: a
 * restored file with the old WAL still beside it opens as the old database, and
 * passes `integrity_check`.
 */
import { spawnSync } from 'node:child_process';
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
import { redactText } from '../redact';
import { runMigrations } from './client';
import { MIGRATIONS } from './migrations.generated';
import { backupStamp } from '../timestamps';

export { backupStamp };

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

/**
 * The parts of a schema that queries depend on, one line each: every table with
 * its strictness, columns, indexes and foreign keys, and every trigger and view.
 *
 * Built from pragmas rather than the stored `CREATE` text, which differs between
 * a database created fresh and one upgraded in place (a rebuilt table keeps
 * the quoted name `ALTER TABLE ... RENAME` wrote) while the schema is the same.
 * Indexes SQLite creates for `UNIQUE` and `PRIMARY KEY` are described by their
 * columns, since their `sqlite_autoindex_*` names depend on creation order.
 */
function schemaShape(sqlite: Database.Database): Map<string, string> {
  // Each line maps to the table it belongs to, so a missing table is reported once.
  const shape = new Map<string, string>();
  const objects = sqlite
    .prepare(
      "SELECT type, name, tbl_name AS tableName FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tableName: string }[];

  for (const { type, name, tableName } of objects) {
    if (type === 'index') continue; // described under its table below
    if (type !== 'table') {
      shape.set(`${type} ${name} on ${tableName}`, tableName);
      continue;
    }
    const table = sqlite
      .prepare('SELECT strict, wr FROM pragma_table_list WHERE name = ?')
      .get(name) as { strict: number; wr: number };
    shape.set(`table ${name} strict=${table.strict} withoutRowid=${table.wr}`, name);

    const columns = sqlite
      .prepare('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)')
      .all(name) as Record<string, unknown>[];
    for (const c of columns) {
      shape.set(
        `column ${name}.${String(c['name'])} ${String(c['type'])} notnull=${String(c['notnull'])} default=${String(c['dflt_value'])} pk=${String(c['pk'])} hidden=${String(c['hidden'])}`,
        name,
      );
    }

    const indexes = sqlite
      .prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?)')
      .all(name) as { name: string; unique: number; origin: string; partial: number }[];
    for (const index of indexes) {
      const keys = sqlite
        .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .pluck()
        .all(index.name) as (string | null)[];
      const label = index.origin === 'c' ? index.name : `(${index.origin})`;
      shape.set(
        `index ${label} on ${name}(${keys.join(',')}) unique=${index.unique} partial=${index.partial}`,
        name,
      );
    }

    const foreignKeys = sqlite
      .prepare(
        'SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      )
      .all(name) as Record<string, unknown>[];
    for (const fk of foreignKeys) {
      shape.set(
        `foreign key ${name}.${String(fk['from'])} -> ${String(fk['table'])}.${String(fk['to'])} update=${String(fk['on_update'])} delete=${String(fk['on_delete'])}`,
        name,
      );
    }
  }
  return shape;
}

/**
 * Every object's stored `CREATE` text, keyed `<type> <name>`, with comments and
 * layout removed.
 *
 * Pragmas cannot see an index's `WHERE` predicate, a `CHECK` or `DEFAULT`
 * expression, or a trigger body, and a wrong one passes every pragma check: an
 * event index narrowed to `WHERE source_event_id IS NULL` keeps its name,
 * columns and partial flag, and silently stops deduplicating. The text is the
 * only place those live. Identifier quotes are dropped because `ALTER TABLE ...
 * RENAME` writes a quoted name where the migration wrote a bare one.
 */
function schemaSql(sqlite: Database.Database): Map<string, string> {
  const rows = sqlite
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { type: string; name: string; sql: string }[];
  return new Map(rows.map((r) => [`${r.type} ${r.name}`, normalizeSql(r.sql)]));
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(\w+)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();
}

let latestShape: ReadonlyMap<string, string> | undefined;
let latestSql: ReadonlyMap<string, string> | undefined;

/** The schema a fresh database gets from every migration this build ships. */
function expectedShape(): ReadonlyMap<string, string> {
  if (latestShape === undefined) {
    const reference = new Database(':memory:');
    try {
      runMigrations(reference);
      latestShape = schemaShape(reference);
      latestSql = schemaSql(reference);
    } finally {
      reference.close();
    }
  }
  return latestShape;
}

function expectedSql(): ReadonlyMap<string, string> {
  expectedShape();
  return latestSql as ReadonlyMap<string, string>;
}

/**
 * Require everything this build's migrations create, defined exactly as they
 * define it. Extra tables, indexes and triggers are left alone: nothing reads
 * them, and refusing would only block a restore. An expected object defined
 * differently, including a table with an extra column, is refused.
 */
function assertLatestSchema(sqlite: Database.Database, label: string): void {
  const actual = schemaShape(sqlite);
  const actualTables = new Set(actual.values());
  const missingTables = new Set<string>();
  const different: string[] = [];
  for (const [line, table] of expectedShape()) {
    if (actual.has(line)) continue;
    if (actualTables.has(table)) different.push(line);
    else missingTables.add(table);
  }
  // An object present under the expected name but defined differently.
  const actualSql = schemaSql(sqlite);
  const redefined: string[] = [];
  for (const [key, sql] of expectedSql()) {
    const found = actualSql.get(key);
    if (found !== undefined && found !== sql) redefined.push(key);
  }
  if (missingTables.size === 0 && different.length === 0 && redefined.length === 0) return;

  const parts: string[] = [];
  if (missingTables.size > 0) parts.push(`missing tables: ${[...missingTables].join(', ')}`);
  if (different.length > 0) {
    const more = different.length > 5 ? ` and ${different.length - 5} more` : '';
    parts.push(`missing or different: ${different.slice(0, 5).join('; ')}${more}`);
  }
  if (redefined.length > 0) parts.push(`different definitions: ${redefined.join(', ')}`);
  throw new BackupError(
    `${label} records its migrations but does not have the schema they create. ${parts.join('. ')}`,
  );
}

function existingRealPaths(paths: readonly string[]): Set<string> {
  return new Set(paths.filter((path) => existsSync(path)).map((path) => realpathSync(path)));
}

function inUseUnknown(detail: string): BackupError {
  return new BackupError(`cannot tell whether the database is in use: ${detail}`);
}

/**
 * Process IDs holding any of `paths` open, read from `/proc`, or asked of
 * `lsof` where there is no `/proc` (macOS).
 */
export function processesHolding(paths: readonly string[]): number[] {
  const wanted = existingRealPaths(paths);
  if (wanted.size === 0) return [];

  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return processesHoldingViaLsof(paths);
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

/** What one `lsof` run produced. */
export interface LsofResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when `lsof` could not be started, timed out, or overflowed its buffer. */
  readonly error?: NodeJS.ErrnoException;
}

export type LsofRunner = (args: readonly string[]) => LsofResult;

const LSOF_TIMEOUT_MS = 10_000;
const LSOF_MAX_BUFFER = 1024 * 1024;

function runLsof(args: readonly string[]): LsofResult {
  const result = spawnSync('lsof', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LSOF_TIMEOUT_MS,
    maxBuffer: LSOF_MAX_BUFFER,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

/**
 * Process IDs holding any of `paths` open, as `lsof -t` reports them.
 *
 * `lsof` exits 1 when it finds nothing for even one of its arguments, so a
 * database held open without its `-shm` exits 1 and still prints the holder.
 * PIDs on stdout are therefore holders whether the exit is 0 or 1, and exit 1
 * means "none" only with nothing on stdout or stderr. Every other outcome is
 * not an answer, and refuses rather than lets a restore through.
 */
export function processesHoldingViaLsof(
  paths: readonly string[],
  run: LsofRunner = runLsof,
): number[] {
  const wanted = existingRealPaths(paths);
  if (wanted.size === 0) return [];

  // `-t` already implies `-w`; it stays explicit so the intent survives edits.
  const result = run(['-w', '-t', '--', ...wanted]);
  if (result.error?.code === 'ENOENT') {
    throw inUseUnknown('/proc is unavailable and lsof was not found');
  }
  if (result.error) {
    throw inUseUnknown(`lsof failed: ${result.error.code ?? redactText(result.error.message)}`);
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if ((result.status === 0 || result.status === 1) && lines.length > 0) {
    if (!lines.every((line) => /^[1-9]\d*$/.test(line))) {
      throw inUseUnknown('lsof printed something other than process IDs');
    }
    return [...new Set(lines.map(Number))].sort((a, b) => a - b);
  }
  const stderr = result.stderr.trim();
  if (result.status === 1 && stderr === '') return [];

  const firstLine = stderr.split('\n')[0]?.trim();
  const detail = firstLine
    ? redactText(firstLine)
    : result.signal
      ? `killed by ${result.signal}`
      : `exit status ${result.status} with no process listed`;
  throw inUseUnknown(`lsof failed: ${detail}`);
}

/** What to stop before retrying a restore, named for what this platform runs. */
export function inUseStopHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') {
    return 'Stop ai-usage-dashboard-web.service, ai-usage-dashboard-collector.timer, and any pnpm run dev or pnpm run start, then retry';
  }
  if (platform === 'darwin') {
    return 'Stop the launchd agents io.github.baktiaditya.ai-usage-dashboard.collector and io.github.baktiaditya.ai-usage-dashboard.web with scripts/install-launchd.sh --disable --with-web, and any pnpm run dev or pnpm run start, then retry';
  }
  return 'Stop the scheduled collector, the dashboard server, and any pnpm run dev or pnpm run start, then retry';
}

function assertNotInUse(database: string): void {
  const holders = processesHolding(withSidecars(database));
  if (holders.length > 0) {
    throw new BackupError(
      `the database is open in process ${holders.join(', ')}. ${inUseStopHint()}`,
    );
  }
}

/** Switch a copy to a rollback journal, so it is one self-contained file, and verify it. */
function seal(path: string, label: string): DatabaseSummary {
  chmodSync(path, 0o600);
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    sqlite.pragma('journal_mode = DELETE');
    const summary = inspect(sqlite, label);
    // A source not yet migrated is checked in full when it is restored.
    if (summary.schemaVersion === LATEST_SCHEMA_VERSION) assertLatestSchema(sqlite, label);
    return summary;
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
      `${from} has a non-empty WAL beside it, so the file alone is missing its newest rows. Take backups with pnpm run db:backup rather than copying the database file`,
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
      assertLatestSchema(sqlite, 'the backup');
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
