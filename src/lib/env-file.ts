/**
 * The collector environment file.
 *
 * Provider keys live in one file outside the repository
 * (`~/.config/ai-usage-dashboard/collector.env`, mode `0600`). The systemd unit
 * reads it through `EnvironmentFile=`, but every other entry point — `npm run
 * collect`, `npm run test:live`, and the web server's manual refresh — is a
 * collector too. Loading the same file here keeps all of them on one credential
 * source, so a key that works for the timer also works for a manual refresh.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export type MutableEnv = Record<string, string | undefined>;

/** Same resolution as `scripts/install-systemd.sh`, so both read one file. */
export function collectorEnvFilePath(env: MutableEnv = process.env): string {
  const explicit = env['AUD_ENV_FILE']?.trim();
  if (explicit) return explicit;
  const configHome = env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
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
