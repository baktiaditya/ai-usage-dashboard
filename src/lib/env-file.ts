/**
 * The collector environment file.
 *
 * Optional `AUD_*` settings live in one file outside the repository
 * (`~/.config/ai-usage-dashboard/collector.env`, mode `0600`). Every entry
 * point — the systemd unit, `npm run collect`, `npm run test:live`, and the web
 * server — loads it here, so they share one settings source and one parser.
 * Provider keys are no longer read from it; they are saved in dashboard
 * Settings. The unit uses no `EnvironmentFile=`: that would let the file
 * override the data directory and interval the installer baked into it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { userPath, xdgBaseDir } from './paths';

export type MutableEnv = Record<string, string | undefined>;

/**
 * The one resolution every entry point and the systemd installer share. An
 * explicit `AUD_ENV_FILE` must be absolute or start with `~/`; a relative
 * `XDG_CONFIG_HOME` is ignored, as the XDG spec requires.
 */
export function collectorEnvFilePath(env: MutableEnv = process.env): string {
  const explicit = env['AUD_ENV_FILE']?.trim();
  if (explicit) return userPath('AUD_ENV_FILE', explicit);
  const configHome = xdgBaseDir(env['XDG_CONFIG_HOME'], join(homedir(), '.config'));
  return join(configHome, 'ai-usage-dashboard', 'collector.env');
}

/**
 * Fill `env` from the collector environment file, if one exists.
 *
 * A variable already present in `env` wins: an explicit export is a deliberate
 * override, and the file must not silently replace it. Returns the path that was
 * loaded, or `null` when there is no file — an absent file is the normal state
 * before any key is provisioned.
 */
export function loadCollectorEnvFile(env: MutableEnv = process.env): string | null {
  const path = collectorEnvFilePath(env);
  if (!existsSync(path)) return null;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return path;
}
