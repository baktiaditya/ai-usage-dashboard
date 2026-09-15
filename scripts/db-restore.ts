#!/usr/bin/env tsx
/**
 * Replace the database with a backup taken by `pnpm run db:backup`.
 *
 *   pnpm run db:restore <backup file>
 *
 * pnpm passes a `--` through to the script, so `pnpm run db:restore -- <backup file>`,
 * the form npm needed, is accepted too.
 *
 * Stop everything that has the database open first: the web unit, the collector
 * timer, and any `pnpm run dev` or `pnpm run start`. The restore refuses while a
 * process holds it. The database it replaces is kept beside it as
 * `usage.db.pre-restore-<UTC timestamp>`, and a backup from an older build is
 * migrated forward.
 *
 * Exit codes:
 *   0  restored
 *   1  refused or failed; the current database is unchanged
 *   2  configuration or usage error
 */
import { resolve } from 'node:path';
import { getConfig } from '../src/lib/config';
import { restoreDatabase } from '../src/lib/db/backup';
import { displayPath } from '../src/lib/paths';
import { safeErrorMessage } from '../src/lib/redact';

function main(): number {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const [file] = args;
  if (args.length !== 1 || file === undefined || file.startsWith('-')) {
    process.stderr.write('usage: pnpm run db:restore <backup file>\n');
    return 2;
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
    return 2;
  }

  // pnpm runs a script from the package root; INIT_CWD is where it was typed.
  const source = resolve(process.env['INIT_CWD'] ?? process.cwd(), file);

  try {
    const result = restoreDatabase(source, config.databasePath);
    process.stdout.write(
      `${JSON.stringify(
        {
          restored: displayPath(config.databasePath),
          from: displayPath(source),
          schemaVersion: result.schemaVersion,
          migrated: result.migrated,
          runs: result.runs,
          previous: result.previous === null ? null : displayPath(result.previous),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`restore refused: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

process.exitCode = main();
