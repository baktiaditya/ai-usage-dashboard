/**
 * Shared plumbing for the managed-installation manager: contexts, errors,
 * environment capture, probe/backup/unit helpers, and service snapshot
 * handling.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { exists } from './atomic.ts';
import { commandPath, parseJsonOutput, run, type RunResult } from './exec.ts';
import { assertSafePathValue } from './install-paths.ts';
import {
  COLLECTOR_SERVICE,
  COLLECTOR_TIMER,
  WEB_SERVICE,
  activeState,
  enableUnit,
  enabledState,
  lingerState,
  readUnit,
  resetFailedUnit,
  startUnit,
  stopUnit,
} from './systemd.ts';
import { runtimeEnv, runtimeNodeBin, validateRuntimeDir } from './runtime.ts';
import { UNIT_NAMES } from './state.ts';
import type { InstalledConfig, RuntimeRecord, ServiceSnapshot, UnitName } from './state.ts';

export class InstallationError extends Error {
  override readonly name = 'InstallationError';
  readonly remedy: string | null;

  constructor(message: string, remedy: string | null = null) {
    super(message);
    this.remedy = remedy;
  }
}

export function fail(message: string, remedy: string | null = null): never {
  throw new InstallationError(message, remedy);
}

export interface Context {
  readonly root: string;
  readonly repoUrl: string;
  readonly dryRun: boolean;
  readonly enableLinger: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
}

export function contextOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function contextErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface ProbeConfig {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly envFile: string;
  readonly host: string;
  readonly port: number;
  readonly intervalMinutes: number;
}

export function probeConfig(releaseDir: string, runtime: RuntimeRecord): ProbeConfig {
  const result = runRelease(releaseDir, runtime, 'scripts/installation-probe.ts', ['config']);
  const parsed = parseJsonOutput<Record<string, unknown>>(result, 'installation-probe config');
  const dataDir = requireString(parsed, 'dataDir');
  const databasePath = requireString(parsed, 'databasePath');
  const envFile = requireString(parsed, 'envFile');
  const host = requireString(parsed, 'host');
  const port = requireNumber(parsed, 'port');
  const intervalMinutes = requireNumber(parsed, 'intervalMinutes');
  return { dataDir, databasePath, envFile, host, port, intervalMinutes };
}

export interface DatabaseInspection {
  readonly exists: boolean;
  readonly integrity: string | null;
  readonly appliedMax: number | null;
  readonly latest: number;
}

export function inspectDatabase(
  releaseDir: string,
  runtime: RuntimeRecord,
  databasePath: string,
): DatabaseInspection {
  const result = runRelease(releaseDir, runtime, 'scripts/installation-probe.ts', [
    'db-inspect',
    databasePath,
  ]);
  const parsed = parseJsonOutput<Record<string, unknown>>(result, 'installation-probe db-inspect');
  const latest = requireNumber(parsed, 'latest');
  const applied = parsed['appliedMax'];
  const integrity = parsed['integrity'];
  return {
    exists: parsed['exists'] === true,
    integrity: typeof integrity === 'string' ? integrity : null,
    appliedMax: typeof applied === 'number' ? applied : null,
    latest,
  };
}

export function databaseHolders(
  releaseDir: string,
  runtime: RuntimeRecord,
  databasePath: string,
): number[] {
  const result = runRelease(releaseDir, runtime, 'scripts/installation-probe.ts', [
    'db-holders',
    databasePath,
  ]);
  const parsed = parseJsonOutput<Record<string, unknown>>(result, 'installation-probe db-holders');
  const pids = parsed['pids'];
  if (!Array.isArray(pids)) fail('installation-probe db-holders returned no pid list');
  return pids.filter((pid): pid is number => typeof pid === 'number');
}

/** Run a TypeScript entry point from a release with the release's own tsx. */
export function runRelease(
  releaseDir: string,
  runtime: RuntimeRecord,
  script: string,
  args: readonly string[],
  options: { readonly extraEnv?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): RunResult {
  const tsx = join(releaseDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!exists(tsx)) {
    fail(
      `${releaseDir} has no installed tsx; the dependency install did not complete`,
      'Re-run the installation or update so dependencies are installed from the compiled lockfile.',
    );
  }
  const env = { ...runtimeEnv(releaseDir, runtime), ...options.extraEnv };
  return run(
    runtimeNodeBin(runtime),
    ['--disable-warning=ExperimentalWarning', tsx, join(releaseDir, script), ...args],
    {
      cwd: releaseDir,
      env,
      timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
    },
  );
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    fail(`the configuration probe did not return a usable ${key}`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`the configuration probe did not return a usable ${key}`);
  }
  return value;
}

/** Capture the caller's Codex location before any private runtime is prepended. */
export function captureCodex(env: Record<string, string | undefined>): {
  codexDir: string | null;
  codexHome: string;
} {
  const codex = commandPath('codex', env);
  const explicitHome = env['CODEX_HOME']?.trim();
  const home = env['HOME']?.trim();
  const codexHome =
    explicitHome && explicitHome !== ''
      ? explicitHome
      : join(home && home !== '' ? home : homedir(), '.codex');
  if (!codexHome.startsWith('/')) {
    fail(
      `CODEX_HOME must be an absolute path (got ${JSON.stringify(explicitHome)}); a relative one would land in whichever directory a process started in`,
    );
  }
  return { codexDir: codex === null ? null : dirname(codex), codexHome };
}

/** Refuse configuration values a systemd unit cannot carry safely. */
export function validateInstalledConfig(config: InstalledConfig): void {
  assertSafePathValue('AUD_DATA_DIR', config.dataDir);
  assertSafePathValue('AUD_ENV_FILE', config.envFile);
  assertSafePathValue('CODEX_HOME', config.codexHome);
  if (config.codexDir !== null) assertSafePathValue('the Codex directory', config.codexDir);
  if (config.host.includes(' ')) fail(`AUD_HOST cannot contain spaces: ${config.host}`);
}

/** The environment every unit render, collect, and release script runs with. */
export function serviceEnv(config: InstalledConfig, runtime: RuntimeRecord): NodeJS.ProcessEnv {
  const pathEntries = [join(runtime.path, 'bin')];
  if (config.codexDir !== null) pathEntries.push(config.codexDir);
  pathEntries.push('/usr/local/bin', '/usr/bin', '/bin');
  return {
    NODE_ENV: 'production',
    PATH: pathEntries.join(':'),
    AUD_DATA_DIR: config.dataDir,
    AUD_ENV_FILE: config.envFile,
    AUD_HOST: config.host,
    AUD_PORT: String(config.port),
    AUD_COLLECT_INTERVAL_MINUTES: String(config.intervalMinutes),
    CODEX_HOME: config.codexHome,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

/** The isolated environment a dependency build/test may observe. */
export function buildEnv(
  root: string,
  config: InstalledConfig,
  runtime: RuntimeRecord,
): NodeJS.ProcessEnv {
  const buildData = join(root, 'cache', 'build-data');
  mkdirSync(buildData, { recursive: true, mode: 0o700 });
  return {
    ...serviceEnv(config, runtime),
    AUD_DATA_DIR: buildData,
    AUD_ENV_FILE: join(root, 'cache', 'build-env-file-absent'),
  };
}

/** Render and install the units from a release without enabling anything. */
export function renderAndInstallUnits(
  releaseDir: string,
  runtime: RuntimeRecord,
  config: InstalledConfig,
): void {
  const script = join(releaseDir, 'scripts', 'install-systemd.sh');
  if (!exists(script)) fail(`${releaseDir} does not contain scripts/install-systemd.sh`);
  if (!exists(join(releaseDir, '.next', 'BUILD_ID'))) {
    fail(`the release at ${releaseDir} has no production build`);
  }
  const result = run('bash', [script, '--install', '--with-web'], {
    cwd: releaseDir,
    env: {
      ...process.env,
      ...serviceEnv(config, runtime),
    },
    timeoutMs: 10 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    fail(
      `installing the systemd units failed: ${
        result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`
      }`,
    );
  }
}

/** Check that the configured port is free; the web unit will need it. */
export function assertPortFree(
  host: string,
  port: number,
  options: { readonly ignoreActiveUnit?: boolean } = {},
): void {
  if (options.ignoreActiveUnit === true && activeState(WEB_SERVICE) === 'active') return;
  const result = run('ss', ['-ltnH', `sport = :${port}`], { timeoutMs: 30_000 });
  if (result.error) {
    fail(`could not check whether port ${port} is free: ${result.error.message}`);
  }
  const listening = result.stdout.trim();
  if (listening !== '') {
    fail(
      `port ${port} is already in use by another process`,
      `Stop the process listening on ${host}:${port} (any pnpm run start or another dashboard), then retry.`,
    );
  }
}

export function httpUrl(host: string, port: number): string {
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${port}/`;
}

/** Poll the dashboard until it answers, up to `timeoutMs`. */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      fail(
        `the dashboard did not answer at ${url} within ${Math.round(timeoutMs / 1000)} seconds (last result: ${lastError})`,
        'Check the web unit log with: journalctl --user -u ai-usage-dashboard-web.service -n 50',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function healthTimeoutMs(): number {
  const override = process.env['AUD_INSTALL_HEALTH_TIMEOUT_SECONDS']?.trim();
  if (override !== undefined && override !== '') {
    const seconds = Number(override);
    if (Number.isFinite(seconds) && seconds >= 1) return seconds * 1000;
  }
  return 60_000;
}

/** Stop the timer, wait for a running collector, and stop the web unit. */
export function stopWriters(): void {
  try {
    stopUnit(COLLECTOR_TIMER);
  } catch (err) {
    fail(
      `could not stop ${COLLECTOR_TIMER}: ${err instanceof Error ? err.message : err}`,
      `Inspect systemctl --user status ${COLLECTOR_TIMER} and retry.`,
    );
  }
  const deadline = Date.now() + 180_000;
  for (;;) {
    const state = activeState(COLLECTOR_SERVICE);
    if (state === 'inactive' || state === 'failed' || state === 'unknown') break;
    if (Date.now() >= deadline) {
      fail(
        `the collector (${COLLECTOR_SERVICE}) is still running after 180 seconds`,
        `Wait for it to finish or stop it with systemctl --user stop ${COLLECTOR_SERVICE}, then retry.`,
      );
    }
    run('sleep', ['0.5']);
  }
  try {
    stopUnit(WEB_SERVICE);
  } catch (err) {
    fail(
      `could not stop ${WEB_SERVICE}: ${err instanceof Error ? err.message : err}`,
      `Inspect systemctl --user status ${WEB_SERVICE} and retry.`,
    );
  }
}

/** Stop whichever owned services exist, without failing on already-stopped units. */
export function stopOwnedServicesBestEffort(): void {
  for (const name of [COLLECTOR_TIMER, COLLECTOR_SERVICE, WEB_SERVICE] as const) {
    try {
      stopUnit(name);
    } catch {
      // best effort during recovery
    }
  }
}

export function snapshotServices(user: string): ServiceSnapshot {
  const unitFiles: Record<string, string | null> = {};
  const enabled: Record<string, string> = {};
  const active: Record<string, string> = {};
  for (const name of UNIT_NAMES) {
    unitFiles[name] = readUnit(name);
    enabled[name] = enabledState(name);
    active[name] = activeState(name);
  }
  return { unitFiles, enabled, active, linger: lingerState(user) };
}

/**
 * Restore enabled/active state from a snapshot, independently per unit.
 * A web unit started only for health is stopped again when it was inactive.
 */
export function applySnapshot(snapshot: ServiceSnapshot): void {
  const units: UnitName[] = [COLLECTOR_TIMER, WEB_SERVICE];
  for (const name of units) {
    if (snapshot.enabled[name] === 'enabled') {
      try {
        enableUnit(name);
      } catch {
        // enabling is idempotent; a failure is reported by the caller's status
      }
    }
    const wasActive = snapshot.active[name] === 'active';
    try {
      if (wasActive) {
        resetFailedUnit(name);
        startUnit(name);
      } else {
        stopUnit(name);
      }
    } catch {
      // best effort; the caller reports the resulting state
    }
  }
}

/** `2026-09-14T01:02:03.456Z` becomes `20260914T010203456Z`: sortable and file-name safe. */
function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

/** The path pattern for a cutover backup taken under the data directory. */
export function backupDestination(dataDir: string): string {
  return join(dataDir, 'backups', `installation-${backupStamp(new Date())}.db`);
}

export interface BackupOutcome {
  readonly path: string;
  readonly runs: number | null;
}

/** Take and verify a backup with the given release's own backup executable. */
export function makeBackup(
  releaseDir: string,
  runtime: RuntimeRecord,
  sourceDatabase: string,
  destination: string,
): BackupOutcome {
  const result = runRelease(releaseDir, runtime, 'scripts/db-backup.ts', [destination], {
    extraEnv: { NODE_ENV: 'production', AUD_DATA_DIR: dirname(sourceDatabase) },
  });
  if (result.status !== 0) {
    fail(
      `the pre-cutover backup failed: ${result.stderr.trim() || `status ${result.status}`}`,
      'No database or source change was made. Fix the reported cause and retry the update.',
    );
  }
  const parsed = parseJsonOutput<Record<string, unknown>>(result, 'db-backup');
  const backup = parsed['backup'];
  if (typeof backup !== 'string' || backup === '') {
    fail('the backup script did not report where the backup was written');
  }
  if (!exists(destination)) {
    fail(`the backup script reported success but there is no file at ${destination}`);
  }
  const runs = parsed['runs'];
  return { path: destination, runs: typeof runs === 'number' ? runs : null };
}

/** Remove an owned file only when it is ours; report a foreign collision. */
export function removeIfOurs(
  path: string,
  isOurs: (content: string) => boolean,
  label: string,
): void {
  if (!exists(path)) return;
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`could not read ${label} at ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (!isOurs(content)) {
    fail(
      `${label} at ${path} was not installed by this managed installation; leaving it untouched`,
    );
  }
  rmSync(path, { force: true });
}

export function ensureMode(path: string, mode: number): void {
  chmodSync(path, mode);
}

export { COLLECTOR_SERVICE, COLLECTOR_TIMER, WEB_SERVICE };
export type { UnitName };
export { runtimeEnv, validateRuntimeDir };
