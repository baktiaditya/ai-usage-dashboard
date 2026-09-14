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
 * validated configuration — the same source the guard reads — instead of
 * literals in package.json. Other arguments are passed through to `next`.
 *
 * `start` binds `AUD_HOST`/`AUD_PORT` from `getConfig()`, as the web unit does.
 * `dev` must run beside that production server, so it launches with the
 * environment `resolveDevEnvironment()` builds: its own port (`AUD_DEV_PORT`,
 * default 3839) passed to the child as `AUD_PORT`, its own data directory, and
 * manual refresh disabled unless `AUD_DEV_LIVE_REFRESH=1`.
 *
 * A passed-through `--hostname` or `--port` is refused, not merely outranked:
 * `next` keeps the last value it sees, so an extra flag would silently move the
 * server off the validated loopback address that `AUD_HOST` enforces.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getConfig } from '../src/lib/config';
import { resolveDevEnvironment } from '../src/lib/dev-environment';
import { safeErrorMessage } from '../src/lib/redact';

const [mode, ...passthrough] = process.argv.slice(2);
if (mode !== 'dev' && mode !== 'start') {
  process.stderr.write('usage: tsx scripts/next.ts <dev|start> [next options]\n');
  process.exit(2);
}

// Every spelling `next` accepts: `--port 1`, `--port=1`, `-p 1`, `-p1`, `-H host`.
const BIND_FLAG = /^(?:--hostname|--port)(?:=|$)|^-[Hp]/;
const override = passthrough.find((arg) => BIND_FLAG.test(arg));
if (override !== undefined) {
  const instead = mode === 'dev' ? 'AUD_HOST / AUD_DEV_PORT' : 'AUD_HOST / AUD_PORT';
  process.stderr.write(
    `refusing "${override}": set ${instead} instead, so the bind address stays validated\n`,
  );
  process.exit(2);
}

let bind: { host: string; port: number; env?: NodeJS.ProcessEnv };
try {
  if (mode === 'dev') {
    const dev = resolveDevEnvironment(process.env);
    bind = { host: dev.host, port: dev.port, env: dev.env as NodeJS.ProcessEnv };
  } else {
    const config = getConfig();
    bind = { host: config.host, port: config.port };
  }
} catch (err) {
  process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
  process.exit(2);
}

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(
  process.execPath,
  [nextBin, mode, '--hostname', bind.host, '--port', String(bind.port), ...passthrough],
  { stdio: 'inherit', ...(bind.env ? { env: bind.env } : {}) },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
