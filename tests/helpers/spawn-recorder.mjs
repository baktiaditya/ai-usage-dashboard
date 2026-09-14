/**
 * Preload (`node --import`) for launcher tests: records what a script would
 * spawn, then exits instead of starting it.
 *
 * `scripts/next.ts` would otherwise boot a real Next.js server. The record keeps
 * the command, its arguments, the bind and data settings, and only whether each
 * provider credential is unset, empty, or set — never a credential value.
 */
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const SETTINGS = ['AUD_HOST', 'AUD_PORT', 'AUD_DATA_DIR', 'AUD_REFRESH_ENABLED'];
const CREDENTIALS = ['DEEPSEEK_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'];

childProcess.spawn = (command, args = [], options = {}) => {
  const env = options.env ?? process.env;
  const record = {
    command,
    args,
    env: Object.fromEntries(SETTINGS.map((key) => [key, env[key] ?? null])),
    credentials: Object.fromEntries(
      CREDENTIALS.map((key) => [
        key,
        env[key] === undefined ? 'unset' : env[key] === '' ? 'empty' : 'set',
      ]),
    ),
  };
  writeFileSync(process.env['AUD_TEST_SPAWN_RECORD'], JSON.stringify(record));
  process.exit(0);
};
syncBuiltinESMExports();
