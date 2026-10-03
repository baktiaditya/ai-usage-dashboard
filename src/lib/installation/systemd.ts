/**
 * User systemd interaction for the managed installation.
 *
 * The manager installs, starts, stops, enables, and inspects the same hardened
 * user units the manual installer renders. Ownership is decided by unit
 * *contents* — a managed unit's `WorkingDirectory` lives under this install
 * root's `releases/` directory — never by file name alone, so a manual or
 * maintainer unit is refused rather than repointed.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists, errorText } from './atomic.ts';
import { run } from './exec.ts';
import { UNIT_NAMES } from './state.ts';
import type { ServiceSnapshot, UnitName } from './state.ts';

export class SystemdError extends Error {
  override readonly name = 'SystemdError';
}

export const COLLECTOR_SERVICE: UnitName = 'ai-usage-dashboard-collector.service';
export const COLLECTOR_TIMER: UnitName = 'ai-usage-dashboard-collector.timer';
export const WEB_SERVICE: UnitName = 'ai-usage-dashboard-web.service';

export function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME']?.trim();
  const base = configHome && configHome.startsWith('/') ? configHome : join(homedir(), '.config');
  return join(base, 'systemd', 'user');
}

export function unitFilePath(name: UnitName, env: NodeJS.ProcessEnv = process.env): string {
  return join(unitDir(env), name);
}

export function readUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = unitFilePath(name, env);
  if (!exists(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new SystemdError(`cannot read ${path}: ${errorText(err)}`);
  }
}

/** The `WorkingDirectory=` line of a unit, unescaped enough for a path test. */
export function unitWorkingDirectory(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = /^WorkingDirectory=(.*)$/.exec(line.trim());
    if (match !== null) return match[1] ?? '';
  }
  return null;
}

/**
 * A unit is owned by this managed root when its `WorkingDirectory` points into
 * `<root>/releases/<sha>`. That is what the managed renderer writes; a manual
 * checkout lives elsewhere.
 */
export function unitOwnedByRoot(content: string, root: string): boolean {
  const working = unitWorkingDirectory(content);
  if (working === null) return false;
  const prefix = `${root.replace(/\/+$/, '')}/releases/`;
  return working.startsWith(prefix);
}

export interface ForeignUnit {
  readonly name: UnitName;
  readonly path: string;
}

/**
 * Whether one installed unit is owned by this managed root.
 *
 * The service units are identified by their `WorkingDirectory` under the
 * root's `releases/` directory. The timer carries no `WorkingDirectory`; it is
 * owned when it activates the collector service and that service is owned.
 * This keeps a manual installation's identically named timer foreign.
 */
function unitIsOwned(
  name: UnitName,
  content: string,
  root: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (name === COLLECTOR_TIMER) {
    const service = readUnit(COLLECTOR_SERVICE, env);
    return (
      content.includes(`Unit=${COLLECTOR_SERVICE}`) &&
      service !== null &&
      unitOwnedByRoot(service, root)
    );
  }
  return unitOwnedByRoot(content, root);
}

/** Installed dashboard unit files that this root does not own. */
export function foreignManagedUnits(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): ForeignUnit[] {
  const foreign: ForeignUnit[] = [];
  for (const name of UNIT_NAMES) {
    const content = readUnit(name, env);
    if (content !== null && !unitIsOwned(name, content, root, env)) {
      foreign.push({ name, path: unitFilePath(name, env) });
    }
  }
  return foreign;
}

/** Installed dashboard unit files owned by this root. */
export function ownedUnits(root: string, env: NodeJS.ProcessEnv = process.env): UnitName[] {
  const owned: UnitName[] = [];
  for (const name of UNIT_NAMES) {
    const content = readUnit(name, env);
    if (content !== null && unitIsOwned(name, content, root, env)) owned.push(name);
  }
  return owned;
}

export function writeUnit(
  name: UnitName,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = unitDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = unitFilePath(name, env);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(unitFilePath(name, env), { force: true });
}

function systemctl(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = run('systemctl', ['--user', ...args], { env, timeoutMs: 2 * 60 * 1000 });
  if (result.error) {
    throw new SystemdError(`systemctl --user ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SystemdError(
      `systemctl --user ${args.join(' ')} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

function systemctlQuiet(args: readonly string[], env: NodeJS.ProcessEnv): RunQuietResult {
  const result = run('systemctl', ['--user', ...args], { env, timeoutMs: 2 * 60 * 1000 });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

export interface RunQuietResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
}

export function daemonReload(env: NodeJS.ProcessEnv = process.env): void {
  systemctl(['daemon-reload'], env);
}

export type ActiveState =
  | 'active'
  | 'inactive'
  | 'failed'
  | 'activating'
  | 'deactivating'
  | 'unknown';

export function activeState(name: UnitName, env: NodeJS.ProcessEnv = process.env): ActiveState {
  const result = systemctlQuiet(['is-active', name], env);
  const text = result.stdout;
  if (['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(text)) {
    return text as ActiveState;
  }
  return 'unknown';
}

export type EnabledState = 'enabled' | 'disabled' | 'static' | 'masked' | 'indirect' | 'unknown';

export function enabledState(name: UnitName, env: NodeJS.ProcessEnv = process.env): EnabledState {
  const result = systemctlQuiet(['is-enabled', name], env);
  const text = result.stdout;
  if (['enabled', 'disabled', 'static', 'masked', 'indirect'].includes(text)) {
    return text as EnabledState;
  }
  return 'unknown';
}

export function startUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  systemctl(['start', name], env);
}

/**
 * Clear a unit's failed state and start-limit counter.
 *
 * A candidate that crash-looped before recovery leaves the unit failed; without
 * this, systemd refuses the next start with "start request repeated too
 * quickly" until the rate-limit window passes. Best effort: a unit with no
 * failed state is a no-op.
 */
export function resetFailedUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  systemctlQuiet(['reset-failed', name], env);
}

export function stopUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  systemctl(['stop', name], env);
}

export function enableUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  systemctl(['enable', name], env);
}

export function disableUnit(name: UnitName, env: NodeJS.ProcessEnv = process.env): void {
  systemctlQuiet(['disable', name], env);
}

export function startTimer(env: NodeJS.ProcessEnv = process.env): void {
  systemctl(['enable', '--now', COLLECTOR_TIMER], env);
}

/** Wait, bounded, until a oneshot service is no longer active. */
export function waitForUnitInactive(
  name: UnitName,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = activeState(name, env);
    if (state === 'inactive' || state === 'failed' || state === 'unknown')
      return state !== 'unknown';
    if (Date.now() >= deadline) return false;
    run('sleep', ['0.5'], { env });
  }
}

/** `loginctl show-user <user> -p Linger --value`: `yes`, `no`, or `unknown`. */
export function lingerState(user: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = run('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    env,
    timeoutMs: 30_000,
  });
  if (result.error || result.status !== 0) return 'unknown';
  const value = result.stdout.trim();
  return value === '' ? 'unknown' : value;
}

export function enableLinger(user: string, env: NodeJS.ProcessEnv = process.env): RunQuietResult {
  return systemctlQuietLoginctl(user, env);
}

function systemctlQuietLoginctl(user: string, env: NodeJS.ProcessEnv): RunQuietResult {
  const result = run('loginctl', ['enable-linger', user], { env, timeoutMs: 60_000 });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

/** Snapshot unit files, enabled/active states, and linger before an update. */
export function snapshotServices(
  user: string,
  env: NodeJS.ProcessEnv = process.env,
): ServiceSnapshot {
  const unitFiles: Record<string, string | null> = {};
  const enabled: Record<string, string> = {};
  const active: Record<string, string> = {};
  for (const name of UNIT_NAMES) {
    unitFiles[name] = readUnit(name, env);
    enabled[name] = enabledState(name, env);
    active[name] = activeState(name, env);
  }
  return { unitFiles, enabled, active, linger: lingerState(user, env) };
}

/** Install rendered unit files from a release's `systemd/generated` directory. */
export function installRenderedUnits(
  releaseDir: string,
  names: readonly UnitName[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const name of names) {
    const source = join(releaseDir, 'systemd', 'generated', name);
    if (!exists(source)) {
      throw new SystemdError(`the release did not render ${name} at ${source}`);
    }
    writeUnit(name, readFileSync(source, 'utf8'), env);
  }
  daemonReload(env);
}

/** Remove the given unit files and reload systemd. */
export function removeUnits(
  names: readonly UnitName[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const name of names) removeUnit(name, env);
  daemonReload(env);
}
