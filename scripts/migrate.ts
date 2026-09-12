#!/usr/bin/env tsx
/**
 * Apply pending SQLite migrations and report the resulting schema state.
 *
 * Safe to run repeatedly: `runMigrations` skips versions already recorded in
 * `schema_migrations`, and each migration is applied inside its own
 * transaction.
 */
import { getConfig } from '../src/lib/config';
import { openDb } from '../src/lib/db/client';
import { safeErrorMessage } from '../src/lib/redact';

function main(): number {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
    return 2;
  }

  try {
    const db = openDb({ path: config.databasePath });
    const sqlite = db.$client;

    const applied = sqlite
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: number; applied_at: string }[];

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];

    const journalMode = sqlite.pragma('journal_mode', { simple: true });

    process.stdout.write(
      `${JSON.stringify(
        {
          database: config.databasePath.replace(process.env['HOME'] ?? '~', '~'),
          journalMode,
          migrations: applied.map((m) => m.version),
          tables: tables.map((t) => t.name),
        },
        null,
        2,
      )}\n`,
    );

    sqlite.close();
    return 0;
  } catch (err) {
    process.stderr.write(`migration failed: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

process.exitCode = main();
