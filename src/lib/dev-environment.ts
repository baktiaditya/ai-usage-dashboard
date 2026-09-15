/**
 * The environment `npm run dev` hands to `next dev`.
 *
 * The production dashboard runs at boot on `AUD_PORT` against the collector's
 * database, so a development server must not inherit either. Moving only the
 * bind port is not enough: the same-origin guard reads `AUD_PORT`, opening a
 * database applies pending migrations, and `getConfig()` fills `process.env`
 * from `collector.env`. The child therefore gets a complete environment with the
 * port, data directory, and refresh policy already decided here. Provider keys
 * live in the database, so the development server only ever sees the keys saved
 * in its own database.
 *
 * `AUD_DEV_*` settings are parsed only in this module, never by `loadConfig`,
 * so a malformed development value cannot stop `npm run start`, scheduled
 * collection, or either systemd unit.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ConfigError, loadConfig } from './config';
import type { EnvLike } from './config';
import { loadCollectorEnvFile } from './env-file';
import { PathError, userPath, xdgBaseDir } from './paths';

export const DEFAULT_DEV_PORT = 3839;

export interface DevEnvironment {
  readonly host: string;
  readonly port: number;
  /** The resolved production `AUD_PORT`, which the development port may never equal. */
  readonly productionPort: number;
  readonly dataDir: string;
  /** `AUD_DEV_LIVE_REFRESH=1`: manual refresh may reach providers and write the database. */
  readonly liveRefresh: boolean;
  /** The complete environment for the `next dev` child. */
  readonly env: EnvLike;
}

function parseDevPort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_DEV_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `AUD_DEV_PORT must be an integer from 1 to 65535 (got ${JSON.stringify(raw)})`,
    );
  }
  return port;
}

/** Unset, `0`, or `1` only. A blank value is refused rather than guessed at. */
function parseLiveRefresh(raw: string | undefined): boolean {
  if (raw === undefined || raw === '0') return false;
  if (raw === '1') return true;
  throw new ConfigError('AUD_DEV_LIVE_REFRESH must be 0 or 1');
}

/** Symlink hops followed before giving up, matching the Linux kernel's own limit. */
const MAX_SYMLINK_HOPS = 40;

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The directory a path will really be, even before it exists, or `null` when
 * that cannot be known.
 *
 * `mkdir -p` follows every symlinked ancestor, so a missing directory under an
 * aliased parent is created inside the parent's target. The deepest existing
 * ancestor is therefore resolved and the missing tail appended, and a dangling
 * symlink is followed to where it points. A symlink loop or an unreadable
 * component yields `null`, so the caller refuses rather than guessing.
 */
function canonicalDir(path: string, hops = 0): string | null {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    if (isSymlink(current)) {
      if (hops >= MAX_SYMLINK_HOPS) return null;
      let target: string;
      try {
        target = resolve(dirname(current), readlinkSync(current));
      } catch {
        return null;
      }
      return canonicalDir(join(target, ...missing.reverse()), hops + 1);
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...missing.reverse());
    missing.push(basename(current));
    current = parent;
  }
}

function devDataDir(env: EnvLike): string {
  try {
    return env['AUD_DEV_DATA_DIR']?.trim()
      ? userPath('AUD_DEV_DATA_DIR', env['AUD_DEV_DATA_DIR'])
      : join(
          xdgBaseDir(env['XDG_DATA_HOME'], join(homedir(), '.local', 'share')),
          'ai-usage-dashboard-dev',
        );
  } catch (err) {
    if (err instanceof PathError) throw new ConfigError(err.message);
    throw err;
  }
}

/**
 * Resolve and validate the development server's settings without touching the
 * caller's environment. Throws `ConfigError` before anything is spawned.
 */
export function resolveDevEnvironment(sourceEnv: EnvLike = process.env): DevEnvironment {
  const env: EnvLike = { ...sourceEnv };
  try {
    loadCollectorEnvFile(env);
  } catch (err) {
    if (err instanceof PathError) throw new ConfigError(err.message);
    throw err;
  }

  // Host validation and AUD_PORT precedence stay in one place.
  const production = loadConfig(env);
  const port = parseDevPort(env['AUD_DEV_PORT']);
  const dataDir = devDataDir(env);
  const liveRefresh = parseLiveRefresh(env['AUD_DEV_LIVE_REFRESH']);

  if (port === production.port) {
    throw new ConfigError(
      `AUD_DEV_PORT ${port} is also the production AUD_PORT; choose another port so the development server cannot collide with the production dashboard`,
    );
  }
  // Opening the database applies migrations, so sharing it is never harmless.
  const devTarget = canonicalDir(dataDir);
  const productionTarget = canonicalDir(production.dataDir);
  if (devTarget === null || productionTarget === null) {
    throw new ConfigError(
      `AUD_DEV_DATA_DIR ${JSON.stringify(dataDir)} or the production data directory could not be fully resolved (a symlink loop or an unreadable path), so the development server cannot prove they differ`,
    );
  }
  if (devTarget === productionTarget) {
    throw new ConfigError(
      `AUD_DEV_DATA_DIR ${JSON.stringify(dataDir)} is also the production data directory; choose another directory so the development server cannot open the production database`,
    );
  }

  const child: EnvLike = {
    ...env,
    AUD_PORT: String(port),
    AUD_DATA_DIR: dataDir,
    AUD_REFRESH_ENABLED: liveRefresh ? '1' : '0',
  };

  return {
    host: production.host,
    port,
    productionPort: production.port,
    dataDir,
    liveRefresh,
    env: child,
  };
}
