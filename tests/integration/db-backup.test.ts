import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  BackupError,
  LATEST_SCHEMA_VERSION,
  backupDatabase,
  processesHoldingViaLsof,
  restoreDatabase,
} from '@/lib/db/backup';
import { openDb } from '@/lib/db/client';
import { MIGRATIONS } from '@/lib/db/migrations.generated';
import { startRun } from '@/lib/db/repository';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A closed database holding `runs` collector runs. */
function database(name: string, runs: number): string {
  const path = join(dir, name);
  const db = openDb({ path });
  for (let i = 0; i < runs; i++) startRun(db, 'scheduled');
  db.$client.close();
  return path;
}

/** A database whose event dedup index covers `source_event_id IS NULL` instead of `IS NOT NULL`. */
function narrowedEventIndex(name: string): string {
  const path = database(name, 1);
  const sqlite = new Database(path);
  sqlite.exec(`DROP INDEX uq_provider_snapshots_event;
    CREATE UNIQUE INDEX uq_provider_snapshots_event
      ON provider_snapshots (provider, source_event_id)
      WHERE source_event_id IS NULL`);
  sqlite.close();
  return path;
}

function runCount(path: string): number {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (sqlite.prepare('SELECT COUNT(*) AS n FROM collector_runs').get() as { n: number }).n;
  } finally {
    sqlite.close();
  }
}

/** Temporary or set-aside files that a refused operation must not leave behind. */
function leftovers(): string[] {
  return readdirSync(dir).filter((f) => /\.(partial|restoring)|pre-restore/.test(f));
}

describe('backupDatabase', () => {
  it('captures rows that exist only in the WAL of a database still open for writing', async () => {
    const live = join(dir, 'usage.db');
    const db = openDb({ path: live });
    try {
      db.$client.pragma('wal_autocheckpoint = 0');
      startRun(db, 'scheduled');
      startRun(db, 'manual');
      expect(statSync(`${live}-wal`).size).toBeGreaterThan(0);

      const destination = join(dir, 'backups', 'copy.db');
      const summary = await backupDatabase(live, destination);

      expect(summary).toEqual({ schemaVersion: LATEST_SCHEMA_VERSION, runs: 2 });
      expect(runCount(destination)).toBe(2);
      expect(statSync(destination).mode & 0o777).toBe(0o600);
      // One self-contained file: nothing to lose when it is copied elsewhere.
      expect(readdirSync(join(dir, 'backups'))).toEqual(['copy.db']);
    } finally {
      db.$client.close();
    }
  });

  it('refuses a source that records every migration but lacks a table', async () => {
    const source = database('source.db', 1);
    const sqlite = new Database(source);
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec('DROP TABLE quota_windows');
    sqlite.close();
    const backup = join(dir, 'backup.db');
    await expect(backupDatabase(source, backup)).rejects.toThrow(/missing tables: quota_windows/);
    expect(existsSync(backup)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a source whose event index predicate was changed', async () => {
    const backup = join(dir, 'backup.db');
    await expect(backupDatabase(narrowedEventIndex('source.db'), backup)).rejects.toThrow(
      /different definitions: index uq_provider_snapshots_event/,
    );
    expect(existsSync(backup)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses to overwrite an existing file', async () => {
    const live = database('usage.db', 1);
    const destination = join(dir, 'taken.db');
    writeFileSync(destination, 'keep me');

    await expect(backupDatabase(live, destination)).rejects.toThrow(BackupError);
    expect(readFileSync(destination, 'utf8')).toBe('keep me');
    expect(leftovers()).toEqual([]);
  });
});

describe('restoreDatabase', () => {
  it('replaces the database and moves the old one aside with its WAL, so the WAL is never replayed into the restored file', async () => {
    const backup = join(dir, 'backup.db');
    await backupDatabase(database('source.db', 3), backup);

    // The database being replaced was closed by a crash: its WAL still holds rows.
    const target = join(dir, 'usage.db');
    const db = openDb({ path: target });
    db.$client.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 5; i++) startRun(db, 'scheduled');
    copyFileSync(`${target}-wal`, join(dir, 'crash-wal'));
    copyFileSync(`${target}-shm`, join(dir, 'crash-shm'));
    db.$client.close();
    copyFileSync(join(dir, 'crash-wal'), `${target}-wal`);
    copyFileSync(join(dir, 'crash-shm'), `${target}-shm`);

    const now = new Date('2026-09-14T01:02:03.456Z');
    const result = restoreDatabase(backup, target, now);

    expect(result).toEqual({
      schemaVersion: LATEST_SCHEMA_VERSION,
      runs: 3,
      migrated: 0,
      previous: `${target}.pre-restore-20260914T010203456Z`,
    });
    // Opened the way the dashboard opens it, the restored file shows the backup.
    const restored = openDb({ path: target });
    try {
      expect(restored.$client.pragma('integrity_check', { simple: true })).toBe('ok');
      const { n } = restored.$client.prepare('SELECT COUNT(*) AS n FROM collector_runs').get() as {
        n: number;
      };
      expect(n).toBe(3);
    } finally {
      restored.$client.close();
    }
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // The old database kept its WAL, so it still opens with all of its rows.
    expect(existsSync(`${result.previous}-wal`)).toBe(true);
    const old = openDb({ path: result.previous ?? '' });
    try {
      const { n } = old.$client.prepare('SELECT COUNT(*) AS n FROM collector_runs').get() as {
        n: number;
      };
      expect(n).toBe(5);
    } finally {
      old.$client.close();
    }
  });

  it('migrates a backup from an older schema forward', () => {
    const backup = join(dir, 'old.db');
    const sqlite = new Database(backup);
    sqlite.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT',
    );
    const older = MIGRATIONS.filter((m) => m.version < LATEST_SCHEMA_VERSION);
    expect(older.length).toBeGreaterThan(0);
    for (const m of older) {
      sqlite.exec(m.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, '2026-09-01T00:00:00.000Z');
    }
    sqlite.close();

    const target = join(dir, 'usage.db');
    const result = restoreDatabase(backup, target);

    expect(result.migrated).toBe(MIGRATIONS.length - older.length);
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.previous).toBeNull();
  });

  describe('refuses, leaving the current database untouched', () => {
    let target: string;
    beforeEach(() => {
      target = database('usage.db', 2);
    });

    function expectRefused(source: string, message: RegExp): void {
      expect(() => restoreDatabase(source, target)).toThrow(message);
      expect(runCount(target)).toBe(2);
      expect(leftovers()).toEqual([]);
    }

    it('while a process holds the database open', async () => {
      const backup = join(dir, 'backup.db');
      await backupDatabase(database('source.db', 7), backup);
      const holder = openDb({ path: target });
      try {
        expect(() => restoreDatabase(backup, target)).toThrow(
          new RegExp(`open in process .*\\b${process.pid}\\b`),
        );
      } finally {
        holder.$client.close();
      }
      expect(runCount(target)).toBe(2);
      expect(leftovers()).toEqual([]);
    });

    it('when the backup is missing', () => {
      expectRefused(join(dir, 'missing.db'), /there is no backup/);
    });

    it('when the backup is not a SQLite database', () => {
      const source = join(dir, 'notes.db');
      writeFileSync(source, 'not a database at all, but long enough to have a header');
      expectRefused(source, /is not a SQLite database/);
    });

    it('when the backup is some other SQLite database', () => {
      const source = join(dir, 'other.db');
      const sqlite = new Database(source);
      sqlite.exec('CREATE TABLE notes (body TEXT)');
      sqlite.close();
      expectRefused(source, /is not an AI Usage Dashboard database/);
    });

    it('when the backup comes from a newer schema', () => {
      const source = database('newer.db', 1);
      const sqlite = new Database(source);
      sqlite
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(LATEST_SCHEMA_VERSION + 1, '2026-09-14T00:00:00.000Z');
      sqlite.close();
      expectRefused(source, /newer than the \d+ this build knows/);
    });

    describe('when the backup records every migration but lacks the schema they create', () => {
      it('with only the two tables a quick check looks for', () => {
        // Reproduces the review finding: accepted, it replaced the live database
        // and the next overview failed with "no such table: provider_snapshots".
        const source = join(dir, 'hollow.db');
        const sqlite = new Database(source);
        sqlite.exec(
          'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT; CREATE TABLE collector_runs (id INTEGER PRIMARY KEY)',
        );
        for (const m of MIGRATIONS) {
          sqlite
            .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
            .run(m.version, '2026-09-14T00:00:00.000Z');
        }
        sqlite.close();
        expectRefused(source, /does not have the schema they create.*provider_snapshots/);
      });

      it.each([
        ['a table', 'DROP TABLE credit_balances', /missing tables: credit_balances/],
        [
          'a column',
          'ALTER TABLE provider_snapshots DROP COLUMN limit_reached_code',
          /limit_reached_code/,
        ],
        ['an index', null, /index /],
      ] as const)('with %s missing', (_what, ddl, message) => {
        const source = database('damaged.db', 1);
        const sqlite = new Database(source);
        sqlite.pragma('foreign_keys = OFF');
        const statement =
          ddl ??
          `DROP INDEX ${
            sqlite
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' LIMIT 1",
              )
              .pluck()
              .get() as string
          }`;
        sqlite.exec(statement);
        sqlite.close();
        expectRefused(source, message);
      });

      it('with an index whose partial predicate was changed', () => {
        // Same name, columns, uniqueness and partial flag: only the predicate
        // differs, and with it event deduplication stops working.
        expectRefused(
          narrowedEventIndex('narrowed.db'),
          /different definitions: index uq_provider_snapshots_event/,
        );
      });

      it('with a table whose CHECK constraint differs', () => {
        // 0001 is recorded, but quota_windows still carries 0000's range CHECK,
        // which pragmas cannot see: a source reporting 120% would be rejected.
        const source = database('unrebuilt.db', 1);
        const initial = MIGRATIONS.find((m) => m.version === 0)!.sql;
        const table = /CREATE TABLE quota_windows \([\s\S]*?\) STRICT;/.exec(initial)![0];
        expect(table).toContain('CHECK (used_percent >= 0.0');
        const sqlite = new Database(source);
        sqlite.pragma('foreign_keys = OFF');
        sqlite.exec(
          `DROP TABLE quota_windows; ${table} CREATE INDEX idx_quota_windows_snapshot ON quota_windows (snapshot_id);`,
        );
        sqlite.close();
        expectRefused(source, /different definitions: table quota_windows/);
      });
    });

    it('when the backup is a live database with rows still in its WAL', () => {
      const source = join(dir, 'live.db');
      const live = openDb({ path: source });
      try {
        live.$client.pragma('wal_autocheckpoint = 0');
        startRun(live, 'scheduled');
        expectRefused(source, /non-empty WAL beside it/);
      } finally {
        live.$client.close();
      }
    });
  });
});

// The `/proc` scan answers on Linux, so the macOS path is called directly here
// against the real `lsof`, wherever one is installed.
const hasLsof = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

describe.skipIf(!hasLsof)('processesHoldingViaLsof with the real lsof', () => {
  it('names this process while it holds the database open, and nobody once it closes', () => {
    const target = database('usage.db', 2);
    const sidecars = [target, `${target}-wal`, `${target}-shm`, `${target}-journal`];
    const holder = openDb({ path: target });
    try {
      expect(processesHoldingViaLsof(sidecars)).toContain(process.pid);
    } finally {
      holder.$client.close();
    }
    expect(processesHoldingViaLsof(sidecars)).toEqual([]);
  });
});

describe('db:backup and db:restore scripts', () => {
  const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

  function run(script: string, args: string[]) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: dir,
      XDG_DATA_HOME: join(dir, 'share'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      AUD_ENV_FILE: join(dir, 'none.env'),
      AUD_DATA_DIR: join(dir, 'data'),
      INIT_CWD: dir,
    };
    return spawnSync(process.execPath, [TSX, join(process.cwd(), 'scripts', script), ...args], {
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
  }

  // `pnpm run db:backup -- <file>` hands the script `['--', '<file>']`, while
  // `pnpm run db:backup <file>` and npm's `-- <file>` hand it `['<file>']`.
  it.each([
    { form: '<file>', lead: [] },
    { form: '-- <file>', lead: ['--'] },
  ])(
    'round-trips the configured database through a backup file named relative to INIT_CWD, given $form',
    ({ lead }) => {
      mkdirSync(join(dir, 'data'));
      const path = join(dir, 'data', 'usage.db');
      const db = openDb({ path });
      startRun(db, 'scheduled');
      startRun(db, 'scheduled');
      db.$client.close();

      const backup = run('db-backup.ts', [...lead, 'snapshot.db']);
      expect(backup.stderr).toBe('');
      expect(backup.status).toBe(0);
      expect(JSON.parse(backup.stdout)).toMatchObject({ backup: '~/snapshot.db', runs: 2 });

      const more = openDb({ path });
      startRun(more, 'manual');
      more.$client.close();

      const restore = run('db-restore.ts', [...lead, 'snapshot.db']);
      expect(restore.stderr).toBe('');
      expect(restore.status).toBe(0);
      expect(JSON.parse(restore.stdout)).toMatchObject({ restored: '~/data/usage.db', runs: 2 });
      expect(runCount(path)).toBe(2);
    },
  );

  it.each([[[]], [['--']]])('exits 2 when db:restore is given no backup file: %j', (args) => {
    const r = run('db-restore.ts', args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: pnpm run db:restore <backup file>');
  });

  it.each([[['--', '--', 'snapshot.db']], [['a.db', 'b.db']], [['--', '-x']]])(
    'exits 2 when db:backup is given anything but one file: %j',
    (args) => {
      const r = run('db-backup.ts', args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage: pnpm run db:backup [<file>]');
    },
  );
});
