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

  it('round-trips the configured database through a backup file named relative to INIT_CWD', () => {
    mkdirSync(join(dir, 'data'));
    const path = join(dir, 'data', 'usage.db');
    const db = openDb({ path });
    startRun(db, 'scheduled');
    startRun(db, 'scheduled');
    db.$client.close();

    const backup = run('db-backup.ts', ['snapshot.db']);
    expect(backup.stderr).toBe('');
    expect(backup.status).toBe(0);
    expect(JSON.parse(backup.stdout)).toMatchObject({ backup: '~/snapshot.db', runs: 2 });

    const more = openDb({ path });
    startRun(more, 'manual');
    more.$client.close();

    const restore = run('db-restore.ts', ['snapshot.db']);
    expect(restore.stderr).toBe('');
    expect(restore.status).toBe(0);
    expect(JSON.parse(restore.stdout)).toMatchObject({ restored: '~/data/usage.db', runs: 2 });
    expect(runCount(path)).toBe(2);
  });

  it('exits 2 when db:restore is given no backup file', () => {
    const r = run('db-restore.ts', []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: npm run db:restore');
  });
});
