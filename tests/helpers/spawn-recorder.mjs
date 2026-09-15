/**
 * Preload (`node --import`) for launcher tests: records what a script would
 * spawn, then exits instead of starting it.
 *
 * `scripts/next.ts` would otherwise boot a real Next.js server. The record keeps
 * the command, its arguments, and the bind, data, and refresh settings.
 */
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const SETTINGS = ['AUD_HOST', 'AUD_PORT', 'AUD_DATA_DIR', 'AUD_REFRESH_ENABLED'];

childProcess.spawn = (command, args = [], options = {}) => {
  const env = options.env ?? process.env;
  const record = {
    command,
    args,
    env: Object.fromEntries(SETTINGS.map((key) => [key, env[key] ?? null])),
  };
  writeFileSync(process.env['AUD_TEST_SPAWN_RECORD'], JSON.stringify(record));
  process.exit(0);
};
syncBuiltinESMExports();
