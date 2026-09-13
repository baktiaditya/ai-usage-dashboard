#!/usr/bin/env tsx
/**
 * Run Next.js on the host and port the application is configured for.
 *
 *   npm run dev      # tsx scripts/next.ts dev
 *   npm run start    # tsx scripts/next.ts start
 *
 * The same-origin guard on manual refresh accepts only
 * `http://<loopback>:<AUD_PORT>`. A server bound anywhere else turns every
 * refresh into a rejected cross-origin request, so the bind address comes from
 * `getConfig()` — the same source the guard reads — instead of literals in
 * package.json. Extra arguments are passed through to `next`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getConfig } from '../src/lib/config';
import { safeErrorMessage } from '../src/lib/redact';

const [mode, ...passthrough] = process.argv.slice(2);
if (mode !== 'dev' && mode !== 'start') {
  process.stderr.write('usage: tsx scripts/next.ts <dev|start> [next options]\n');
  process.exit(2);
}

let config;
try {
  config = getConfig();
} catch (err) {
  process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
  process.exit(2);
}

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(
  process.execPath,
  [nextBin, mode, '--hostname', config.host, '--port', String(config.port), ...passthrough],
  { stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
