#!/usr/bin/env tsx
/**
 * Read-only probes the managed installer runs inside a release checkout.
 *
 *   tsx scripts/installation-probe.ts config
 *   tsx scripts/installation-probe.ts db-inspect <database>
 *   tsx scripts/installation-probe.ts db-holders <database>
 *
 * `config` uses the application's own `getConfig()`, so the managed installer
 * resolves configuration through the same precedence every other entry point
 * uses. The database probes open the file read-only: they never migrate, never
 * create, and never take a write lock.
 *
 * Exit codes:
 *   0  probe succeeded
 *   1  the probe ran and failed
 *   2  configuration or usage error
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getConfig } from '../src/lib/config';
import { LATEST_SCHEMA_VERSION, processesHolding } from '../src/lib/db/backup';
import { collectorEnvFilePath } from '../src/lib/env-file';
import { safeErrorMessage } from '../src/lib/redact';

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function configProbe(): number {
  const config = getConfig();
  print({
    envFile: collectorEnvFilePath(process.env),
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    host: config.host,
    port: config.port,
    intervalMinutes: config.collectIntervalMinutes,
  });
  return 0;
}

function dbInspect(databasePath: string): number {
  if (!existsSync(databasePath)) {
    print({ exists: false, integrity: null, appliedMax: null, latest: LATEST_SCHEMA_VERSION });
    return 0;
  }
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(sqlite.pragma('integrity_check', { simple: true }));
    const hasMigrations =
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get() !== undefined;
    let appliedMax: number | null = null;
    if (hasMigrations) {
      const row = sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
        version: number | null;
      };
      appliedMax = row.version;
    }
    print({ exists: true, integrity, appliedMax, latest: LATEST_SCHEMA_VERSION });
    return 0;
  } finally {
    sqlite.close();
  }
}

function dbHolders(databasePath: string): number {
  const paths = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
  print({ pids: processesHolding(paths) });
  return 0;
}

try {
  const [mode, argument] = process.argv.slice(2);
  let code: number;
  switch (mode) {
    case 'config':
      code = configProbe();
      break;
    case 'db-inspect':
      if (argument === undefined)
        throw new Error('usage: installation-probe.ts db-inspect <database>');
      code = dbInspect(argument);
      break;
    case 'db-holders':
      if (argument === undefined)
        throw new Error('usage: installation-probe.ts db-holders <database>');
      code = dbHolders(argument);
      break;
    default:
      process.stderr.write('usage: installation-probe.ts config|db-inspect|db-holders\n');
      code = 2;
  }
  process.exitCode = code;
} catch (err) {
  process.stderr.write(`installation probe failed: ${safeErrorMessage(err)}\n`);
  process.exitCode = 1;
}
