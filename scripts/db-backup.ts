#!/usr/bin/env tsx
/**
 * Back up the database while the collector and the dashboard keep running.
 *
 *   npm run db:backup              writes <data dir>/backups/usage-<UTC timestamp>.db
 *   npm run db:backup -- <file>    writes <file>, relative to where npm was run
 *
 * A backup inside the data directory guards against a bad restore or a failed
 * migration, not against losing the disk: copy it somewhere else as well.
 *
 * Exit codes:
 *   0  the backup was written and verified
 *   1  the backup failed
 *   2  configuration or usage error
 */
import { join, resolve } from 'node:path';
import { getConfig } from '../src/lib/config';
import { backupDatabase, backupStamp } from '../src/lib/db/backup';
import { displayPath } from '../src/lib/paths';
import { safeErrorMessage } from '../src/lib/redact';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) {
    process.stderr.write('usage: npm run db:backup [-- <file>]\n');
    return 2;
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
    return 2;
  }

  // npm runs a script from the package root; INIT_CWD is where it was typed.
  const destination = args[0]
    ? resolve(process.env['INIT_CWD'] ?? process.cwd(), args[0])
    : join(config.dataDir, 'backups', `usage-${backupStamp(new Date())}.db`);

  try {
    const summary = await backupDatabase(config.databasePath, destination);
    process.stdout.write(
      `${JSON.stringify({ backup: displayPath(destination), ...summary }, null, 2)}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`backup failed: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`unhandled: ${safeErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
