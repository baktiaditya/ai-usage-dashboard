/**
 * Managed-installation lifecycle: install, update, status, uninstall, and the
 * Claude status-line command.
 *
 * Every lifecycle step runs from the selected release's copy of this file, so
 * a bootstrap downloaded from one tag installs another without its own copy
 * deciding behavior. The manager runs on a bare checkout: its static import
 * graph is stdlib-only, and anything needing `node_modules` is spawned through
 * the release's own tsx after dependencies are installed.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { exists } from './atomic.ts';
import { run } from './exec.ts';
import {
  cacheDir,
  classifyRoot,
  defaultInstallRoot,
  isPhysicallyInside,
  launcherPathFor,
  releaseDir,
  releasesDir,
  runtimeDir,
} from './install-paths.ts';
import type { ResolvedRelease } from './release.ts';
import {
  DEFAULT_REPO_URL,
  fetchReleaseCheckout,
  readReleaseFile,
  resolveRelease,
  verifyReleaseCommit,
} from './release.ts';
import { parseRuntimeManifest, validateManifestForEngine } from './manifest.ts';
import { compareTagStrings } from './semver.ts';
import {
  ensureRuntime,
  preparePnpm,
  runPnpm,
  runReleaseScript,
  runtimeNodeBin,
  validateRuntimeDir,
} from './runtime.ts';
import {
  clearJournal,
  OWNERSHIP_SCHEMA_VERSION,
  phaseIndex,
  readJournal,
  readOwnership,
  readState,
  writeJournal,
  writeOwnership,
  writeState,
} from './state.ts';
import type {
  InstallationState,
  InstalledConfig,
  JournalPhase,
  ManagedRelease,
  OperationJournal,
  OwnershipRecord,
  RuntimeRecord,
  UnitName,
} from './state.ts';
import {
  COLLECTOR_SERVICE,
  COLLECTOR_TIMER,
  WEB_SERVICE,
  activeState,
  daemonReload,
  disableUnit,
  enableUnit,
  enabledState,
  foreignManagedUnits,
  lingerState,
  unitFilePath,
  ownedUnits,
  removeUnit,
  removeUnits,
  resetFailedUnit,
  startTimer,
  startUnit,
  stopUnit,
} from './systemd.ts';
import {
  InstallationError,
  assertPortFree,
  backupDestination,
  buildEnv,
  captureCodex,
  databaseHolders,
  ensureMode,
  fail,
  healthTimeoutMs,
  httpUrl,
  inspectDatabase,
  makeBackup,
  probeConfig,
  renderAndInstallUnits,
  runRelease,
  serviceEnv,
  snapshotServices,
  applySnapshot,
  stopOwnedServicesBestEffort,
  stopWriters,
  validateInstalledConfig,
  waitForHttp,
} from './manager-support.ts';
import { planRetention } from './retention.ts';
import { writeFileAtomic, writeSymlinkAtomic } from './atomic.ts';

export interface ManagerArgs {
  readonly command: 'install' | 'update' | 'status' | 'uninstall' | 'claude-statusline';
  readonly installDir: string | null;
  readonly version: string | null;
  readonly dryRun: boolean;
  readonly enableLinger: boolean;
  readonly passthrough: readonly string[];
}

const LAUNCHER_MARKER = 'managed by the ai-usage-dashboard installer';

export function rootFromArgsOrEnv(args: ManagerArgs, env: NodeJS.ProcessEnv): string {
  const fromArgs = args.installDir;
  const fromEnv = env['AUD_INSTALL_ROOT']?.trim();
  const root = fromArgs ?? (fromEnv && fromEnv !== '' ? fromEnv : defaultInstallRoot(env));
  if (!root.startsWith('/'))
    fail(`the install root must be an absolute path (got ${JSON.stringify(root)})`);
  return root;
}

function repoUrl(env: NodeJS.ProcessEnv): string {
  const override = env['AUD_INSTALL_REPO_URL']?.trim();
  return override && override !== '' ? override : DEFAULT_REPO_URL;
}

function context(
  args: ManagerArgs,
  env: NodeJS.ProcessEnv,
): {
  root: string;
  repo: string;
} {
  return { root: rootFromArgsOrEnv(args, env), repo: repoUrl(env) };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

interface JournalPatch {
  phase?: JournalPhase;
  candidate?: ManagedRelease | null;
  previous?: ManagedRelease | null;
  backupPath?: string | null;
  snapshot?: OperationJournal['snapshot'];
  dbOwnershipRecorded?: boolean;
  failed?: string | null;
  notes?: readonly string[];
}

function newJournal(
  root: string,
  kind: OperationJournal['kind'],
  candidate: ManagedRelease | null,
  previous: ManagedRelease | null,
): OperationJournal {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    operationId: randomUUID(),
    kind,
    phase: kind === 'install' ? 'starting' : kind === 'update' ? 'starting' : 'starting',
    pid: process.pid,
    root,
    candidate,
    previous,
    backupPath: null,
    snapshot: null,
    dbOwnershipRecorded: false,
    failed: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}

function persistJournal(journal: OperationJournal, patch: JournalPatch = {}): OperationJournal {
  const updated: OperationJournal = {
    ...journal,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeJournal(journal.root, updated);
  return updated;
}

function finishJournal(root: string): void {
  rmSync(join(root, 'operation.json'), { force: true });
  rmSync(join(root, 'operation.json.tmp'), { force: true });
  void clearJournal;
}

// ---------------------------------------------------------------------------
// Launcher and commit artifacts
// ---------------------------------------------------------------------------

export function launcherContent(root: string, repo: string): string {
  return `#!/usr/bin/env bash
# ${LAUNCHER_MARKER}; edits are overwritten on update
set -euo pipefail
AUD_INSTALL_ROOT='${root.replaceAll("'", `'\\''`)}'
AUD_INSTALL_REPO_URL='${repo.replaceAll("'", `'\\''`)}'
export AUD_INSTALL_ROOT AUD_INSTALL_REPO_URL
exec '${root}/runtime/current/bin/node' --disable-warning=ExperimentalWarning '${root}/current/scripts/manage-installation.ts' "$@"
`;
}

export function launcherIsOurs(content: string, root: string): boolean {
  return content.includes(LAUNCHER_MARKER) && content.includes(`AUD_INSTALL_ROOT='${root}'`);
}

function writeCommitArtifacts(state: InstallationState, repo: string): void {
  writeSymlinkAtomic(join(state.installRoot, 'current'), releaseDir(state.installRoot, state.sha));
  writeSymlinkAtomic(join(state.installRoot, 'runtime', 'current'), state.runtime.path);
  const launcher = launcherContent(state.installRoot, repo);
  writeFileAtomic(state.launcherPath, launcher, 0o755);
  ensureMode(state.launcherPath, 0o755);
  writeState(state.installRoot, state);
}

async function finalizeCommitted(ctx: { root: string; repo: string }): Promise<void> {
  const state = readState(ctx.root);
  if (state !== null) writeCommitArtifacts(state, ctx.repo);
  finishJournal(ctx.root);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recover an interrupted operation before starting another. A committed
 * operation is finalized (metadata cleanup only); an unfinished update rolls
 * back to the previous release, restoring data when the database boundary was
 * crossed. Install and uninstall resume idempotently.
 */
async function recoverIfNeeded(ctx: { root: string; repo: string }): Promise<void> {
  if (!exists(ctx.root)) return;
  const journal = readJournal(ctx.root);
  if (journal === null) return;
  if (journal.root !== ctx.root) {
    fail(
      `the operation journal at ${ctx.root} belongs to ${journal.root}`,
      'Select the install root the journal names, or remove that root by hand after inspecting it.',
    );
  }
  const state = readState(ctx.root);
  const committed =
    state !== null && journal.candidate !== null && state.sha === journal.candidate.sha;
  if (journal.kind === 'uninstall') {
    if (journal.phase === 'committed') finishJournal(ctx.root);
    else process.stdout.write(`Resuming an interrupted uninstall (phase ${journal.phase}).\n`);
    return;
  }
  if (journal.kind === 'install') {
    if (committed) {
      await finalizeCommitted(ctx);
      process.stdout.write('Finalized a previously committed installation.\n');
      return;
    }
    process.stdout.write(`Resuming an interrupted installation (phase ${journal.phase}).\n`);
    return;
  }

  if (committed || journal.phase === 'committed') {
    await finalizeCommitted(ctx);
    process.stdout.write('Finalized a previously committed update.\n');
    return;
  }

  process.stdout.write(`Recovering an interrupted update (phase ${journal.phase}).\n`);
  await recoverUpdate(ctx, journal, state);
}

async function recoverUpdate(
  ctx: { root: string; repo: string },
  journal: OperationJournal,
  state: InstallationState | null,
): Promise<void> {
  const previous = journal.previous;
  if (previous === null || state === null) {
    fail(
      `the update journal at ${ctx.root} is incomplete; recovery needs the previous release and state`,
      `Inspect ${ctx.root}/operation.json and ${ctx.root}/state.json, then follow the retained paths in the journal to recover by hand.`,
    );
  }
  const previousPath = releaseDir(ctx.root, previous.sha);
  if (!exists(previousPath)) {
    fail(
      `the previous release ${previous.tag} (${previous.sha}) is missing from ${previousPath}`,
      'Do not delete releases while an operation is unfinished. Reinstall the previous release with the bootstrap, then retry.',
    );
  }
  const crossedDatabaseBoundary =
    phaseIndex('update', journal.phase) >= phaseIndex('update', 'db-changing');
  const writersStopped =
    phaseIndex('update', journal.phase) >= phaseIndex('update', 'writers-stopped');

  if (!writersStopped) {
    // The snapshot is journaled before the writers are stopped, so an
    // interruption inside `stopWriters` leaves services down while the release
    // and data are untouched. Put the recorded service state back.
    if (journal.snapshot !== null) applySnapshot(journal.snapshot);
    finishJournal(ctx.root);
    process.stdout.write(
      journal.snapshot === null
        ? 'The update had not changed anything yet; the active release is unchanged.\n'
        : 'The update was interrupted while stopping the writers; the previous service state was restored and the active release is unchanged.\n',
    );
    return;
  }

  if (crossedDatabaseBoundary) stopOwnedServicesBestEffort();

  if (crossedDatabaseBoundary && journal.backupPath !== null) {
    const restore = runRelease(
      previousPath,
      previous.runtime,
      'scripts/db-restore.ts',
      [journal.backupPath],
      { extraEnv: serviceEnv(state.config, previous.runtime) },
    );
    if (restore.status !== 0) {
      process.stderr.write(
        `restoring the pre-cutover backup failed: ${restore.stderr.trim() || `status ${restore.status}`}\n`,
      );
      process.stderr.write(
        `Writers are stopped. Retained: previous release ${previousPath}, backup ${journal.backupPath}, journal ${ctx.root}/operation.json\n`,
      );
      process.stderr.write(
        `To recover by hand, run: AUD_DATA_DIR=${state.config.dataDir} AUD_ENV_FILE=${state.config.envFile} ${runtimeNodeBin(previous.runtime)} ${join(previousPath, 'node_modules/tsx/dist/cli.mjs')} ${join(previousPath, 'scripts/db-restore.ts')} ${journal.backupPath}\n`,
      );
      throw new InstallationError('automatic recovery failed; the installation is stopped');
    }
    process.stdout.write(
      `Restored the pre-cutover database from ${journal.backupPath} with the previous release.\n`,
    );
  } else if (crossedDatabaseBoundary) {
    fail(
      'the update journal crossed the database boundary without recording a backup path',
      `Inspect ${ctx.root}/operation.json and recover by hand before retrying.`,
    );
  }

  renderAndInstallUnits(previousPath, previous.runtime, state.config);
  if (journal.snapshot !== null) applySnapshot(journal.snapshot);
  if (state.bridge !== null && journal.candidate !== null) {
    // An interrupted update may have repointed the Claude status line at the
    // candidate before the release was committed. Rewrite it to the release
    // that state still records; an externally replaced command is left alone.
    const candidateRelease = releaseDir(ctx.root, journal.candidate.sha);
    const currentCommand = bridgeCommandFromSettings(state.bridge.settingsPath);
    if (currentCommand !== null && currentCommand.includes(candidateRelease)) {
      refreshOwnedBridge(previousPath, previous.runtime, state.config, state.bridge.settingsPath);
      process.stdout.write('Restored the Claude status line to the previous release.\n');
    }
  }
  const recovered: InstallationState = { ...state, updatedAt: new Date().toISOString() };
  writeCommitArtifacts(recovered, ctx.repo);
  finishJournal(ctx.root);
  process.stdout.write(
    `Recovered ${state.tag} (${state.sha}); the previous release is serving again.\n`,
  );
  if (crossedDatabaseBoundary) {
    process.stdout.write(
      'Observations or Settings written by the failed candidate are not part of the recovered database; they remain in the preserved pre-restore copy.\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

interface StagedRelease {
  readonly release: ResolvedRelease;
  readonly path: string;
  readonly runtime: RuntimeRecord;
}

function activeReleaseOf(state: InstallationState): ManagedRelease {
  return { tag: state.tag, sha: state.sha, runtime: state.runtime };
}

function candidateRuntimeRecord(nodeVersion: string, sha256: string, path: string): RuntimeRecord {
  return { nodeVersion, path, sha256 };
}

async function stageRelease(
  root: string,
  repo: string,
  release: ResolvedRelease,
  existingRuntime: RuntimeRecord | null,
  out: (line: string) => void,
): Promise<StagedRelease> {
  const path = releaseDir(root, release.sha);
  if (!exists(path)) {
    out(`Fetching ${release.tag} (${release.sha.slice(0, 12)})`);
    fetchReleaseCheckout(repo, release, path, cacheDir(root));
  } else {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: path });
    if (head.status !== 0 || head.stdout.trim() !== release.sha) {
      fail(
        `${path} exists but is not the ${release.sha} checkout`,
        'Remove that release directory inside the install root and retry.',
      );
    }
  }
  verifyReleaseCommit(path, release.sha, release.tag);
  const manifest = parseRuntimeManifest(readReleaseFile(path, 'scripts/install-runtime.env'));
  const nvmrc = readReleaseFile(path, '.nvmrc').trim();
  const pkg = JSON.parse(readReleaseFile(path, 'package.json')) as {
    engines?: { node?: unknown };
  };
  const enginesNode = typeof pkg.engines?.node === 'string' ? pkg.engines.node : '';
  validateManifestForEngine(manifest, { nvmrc, enginesNode });

  const runtime = await ensureRuntime({
    root,
    manifest,
    existing: existingRuntime,
    log: out,
  });
  const runtimePath = runtimeDir(root, manifest.nodeVersion);
  if (runtime.path !== runtimePath) {
    fail(`the runtime for Node ${manifest.nodeVersion} resolved to ${runtime.path}`);
  }
  validateRuntimeDir(runtime.path, manifest.nodeVersion);
  return {
    release,
    path,
    runtime: candidateRuntimeRecord(
      manifest.nodeVersion,
      manifest.nodeSha256LinuxX64,
      runtime.path,
    ),
  };
}

function installDependencies(releasePath: string, runtime: RuntimeRecord): string {
  try {
    preparePnpm(releasePath, runtime);
    runPnpm(releasePath, runtime, ['install', '--frozen-lockfile'], { live: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const native = /better-sqlite3|node-gyp|prebuild|python3|make\b|g\+\+/i.test(message);
    fail(
      `installing dependencies failed: ${message}`,
      native
        ? 'The better-sqlite3 prebuilt binary could not be fetched and the native build fallback failed. Check HTTPS reach to github.com and the npm registry, and install Python 3, make, and a C++ compiler for node-gyp.'
        : 'Check HTTPS reach to the npm registry and that the lockfile matches the release, then retry.',
    );
  }
  return releasePath;
}

function nativeSmokeTest(releasePath: string, runtime: RuntimeRecord): void {
  const result = run(
    runtimeNodeBin(runtime),
    [
      '-e',
      "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();",
    ],
    { cwd: releasePath, env: { ...process.env, NODE_ENV: 'production' }, timeoutMs: 2 * 60 * 1000 },
  );
  if (result.error || result.status !== 0) {
    fail(
      `the installed better-sqlite3 native module does not load: ${
        result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`
      }`,
      'Install Python 3, make, and a C++ compiler, then retry so node-gyp can rebuild the module.',
    );
  }
}

function buildRelease(
  root: string,
  releasePath: string,
  runtime: RuntimeRecord,
  config: InstalledConfig,
): void {
  try {
    runPnpm(releasePath, runtime, ['run', 'build'], {
      live: true,
      extraEnv: buildEnv(root, config, runtime),
    });
  } catch (err) {
    fail(
      `the production build failed: ${err instanceof Error ? err.message : String(err)}`,
      'No unit, database, or service was changed by the build itself; fix the reported error and retry.',
    );
  }
  if (!exists(join(releasePath, '.next', 'BUILD_ID'))) {
    fail(`the build did not produce ${releasePath}/.next/BUILD_ID`);
  }
}

function resolveInstallConfig(
  root: string,
  state: InstallationState | null,
  releasePath: string,
  runtime: RuntimeRecord,
): InstalledConfig {
  if (state !== null) {
    validateInstalledConfig(state.config);
    return state.config;
  }
  const probe = probeConfig(releasePath, runtime);
  const codex = captureCodex(process.env);
  const config: InstalledConfig = {
    dataDir: probe.dataDir,
    databasePath: probe.databasePath,
    envFile: probe.envFile,
    host: probe.host,
    port: probe.port,
    intervalMinutes: probe.intervalMinutes,
    codexHome: codex.codexHome,
    codexDir: codex.codexDir,
  };
  validateInstalledConfig(config);
  if (isPhysicallyInside(config.dataDir, root) || isPhysicallyInside(config.databasePath, root)) {
    fail(
      `the application data directory ${config.dataDir} or its database physically resolves inside the install root ${root}`,
      'Choose a data directory outside the install root (AUD_DATA_DIR) with no symlinks into it, because the install root is removed on uninstall.',
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallEnvironment {
  readonly tag: string | null;
  readonly sha: string | null;
}

async function cmdInstall(
  root: string,
  repo: string,
  args: ManagerArgs,
  installEnv: InstallEnvironment,
): Promise<number> {
  if (args.dryRun) {
    const rootKindBefore = classifyRoot(root);
    if (rootKindBefore === 'occupied') {
      fail(
        `the install root ${root} is not empty and is not a managed installation`,
        'Choose another --install-dir, or move the unrelated files aside. Managed installs never take over a manual or maintainer installation.',
      );
    }
    const stateBefore = readState(root);
    const pendingBefore = readJournal(root);
    const release =
      installEnv.tag !== null && installEnv.sha !== null
        ? `${installEnv.tag} (${installEnv.sha})`
        : args.version !== null
          ? `would resolve --version ${args.version} (requires network access)`
          : 'would resolve the highest stable release (requires network access)';
    process.stdout.write(
      [
        'DRY RUN — nothing was written.',
        '',
        `install root : ${root}`,
        `release      : ${release}`,
        stateBefore === null
          ? 'state        : fresh managed installation'
          : `state        : repair of ${stateBefore.tag}`,
        ...(pendingBefore === null
          ? []
          : [
              `recovery     : PENDING — interrupted ${pendingBefore.kind} at phase ${pendingBefore.phase}; a dry run does not recover it`,
            ]),
        '',
        'Would: resolve the runtime, install dependencies with the frozen lockfile, build,',
        'resolve configuration, check database ownership, install and start the units,',
        'run one collection, enable the web unit and timer, and write the launcher.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (!exists(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  ensureMode(root, 0o700);

  await recoverIfNeeded({ root, repo });
  const pending = readJournal(root);
  const resumingInstall =
    pending !== null && pending.kind === 'install' && pending.phase !== 'committed';

  const state = readState(root);
  const rootKind = classifyRoot(root);
  if (rootKind === 'occupied') {
    fail(
      `the install root ${root} is not empty and is not a managed installation`,
      'Choose another --install-dir, or move the unrelated files aside. Managed installs never take over a manual or maintainer installation.',
    );
  }

  const resolved: ResolvedRelease =
    resumingInstall && pending?.candidate !== null && pending !== undefined
      ? { tag: pending.candidate.tag, sha: pending.candidate.sha }
      : installEnv.tag !== null && installEnv.sha !== null
        ? { tag: installEnv.tag, sha: installEnv.sha }
        : resolveRelease(args.version, { repoUrl: repo });

  if (!/^[0-9a-f]{40}$/.test(resolved.sha)) {
    fail(`the bootstrap handed over an invalid commit SHA: ${JSON.stringify(resolved.sha)}`);
  }
  if (state !== null && state.sha !== resolved.sha) {
    fail(
      `this root already has ${state.tag} (${state.sha.slice(0, 12)}) installed, and ${resolved.tag} (${resolved.sha.slice(0, 12)}) is a different release`,
      'Use `ai-usage-dashboard update` to move to another release.',
    );
  }

  const staged = await stageRelease(root, repo, resolved, state?.runtime ?? null, (line) =>
    process.stdout.write(`  ${line}\n`),
  );
  installDependencies(staged.path, staged.runtime);

  const config = resolveInstallConfig(root, state, staged.path, staged.runtime);
  buildRelease(root, staged.path, staged.runtime, config);
  nativeSmokeTest(staged.path, staged.runtime);

  const databasePath = config.databasePath;
  const newInstallationId = state?.installationId ?? randomUUID();
  const ownership = readOwnership(root);
  const databaseRecorded = ownership.entries.some(
    (entry) => realpathOrSelf(entry.databasePath) === realpathOrSelf(databasePath),
  );
  const databaseExists = exists(databasePath);

  let journal = newJournal(
    root,
    'install',
    { tag: resolved.tag, sha: resolved.sha, runtime: staged.runtime },
    state === null ? null : activeReleaseOf(state),
  );
  journal = persistJournal(journal, { phase: 'staged' });

  if (databaseExists) {
    if (!databaseRecorded) {
      fail(
        `a database already exists at ${databasePath}, and this root's ownership record does not name it`,
        `Choose another data directory (AUD_DATA_DIR), or move the existing database aside. Managed installs never adopt a database they did not create.${state === null ? '' : ` The retained ownership record is ${join(root, 'data-ownership.json')}.`}`,
      );
    }
    const inspection = inspectDatabase(staged.path, staged.runtime, databasePath);
    if (inspection.integrity !== null && inspection.integrity !== 'ok') {
      fail(`the database at ${databasePath} failed its integrity check`);
    }
    if (inspection.appliedMax !== null && inspection.appliedMax > inspection.latest) {
      fail(
        `the database at ${databasePath} has schema version ${inspection.appliedMax}, newer than the ${inspection.latest} this release knows`,
        'Install the release that wrote it, or move the database aside to start fresh.',
      );
    }
    const holders = databaseHolders(staged.path, staged.runtime, databasePath);
    if (holders.length > 0) {
      fail(
        `the database at ${databasePath} is open in process(es) ${holders.join(', ')}`,
        'Stop the dashboard, the collector, and any pnpm run start before installing.',
      );
    }
    const destination = backupDestination(config.dataDir);
    process.stdout.write(`Backing up the existing database to ${destination}\n`);
    makeBackup(staged.path, staged.runtime, databasePath, destination);
  } else {
    journal = persistJournal(journal, { phase: 'db-creating', dbOwnershipRecorded: true });
  }

  const foreign = foreignManagedUnits(root);
  if (foreign.length > 0) {
    fail(
      `these installed units are not owned by the managed root ${root}: ${foreign.map((unit) => `${unit.name} (${unit.path})`).join(', ')}`,
      'They belong to a manual or maintainer installation. Remove them through that installation, or choose another --install-dir.',
    );
  }
  const launcherPath = state?.launcherPath ?? launcherPathFor();
  if (exists(launcherPath)) {
    const content = readFileSync(launcherPath, 'utf8');
    if (!launcherIsOurs(content, root)) {
      fail(
        `${launcherPath} already exists and was not installed by this managed root`,
        'Move that launcher aside or choose another location; managed installs never overwrite foreign launchers.',
      );
    }
  }

  runReleaseScript(staged.path, staged.runtime, 'scripts/migrate.ts', [], {
    extraEnv: serviceEnv(config, staged.runtime),
  });
  if (!databaseExists) {
    const updated = addOwnershipEntry(readOwnership(root), config, newInstallationId);
    writeOwnership(root, updated);
  }
  journal = persistJournal(journal, { phase: 'db-ready' });

  assertPortFree(config.host, config.port, { ignoreActiveUnit: true });
  renderAndInstallUnits(staged.path, staged.runtime, config);
  journal = persistJournal(journal, { phase: 'units-installed' });

  const removeUnitsOnFailure = state === null;
  try {
    resetFailedUnit(WEB_SERVICE);
    startUnit(WEB_SERVICE);
    await waitForHttp(httpUrl(config.host, config.port), healthTimeoutMs());
  } catch (err) {
    return failInstallActivation(root, journal, removeUnitsOnFailure, err);
  }
  journal = persistJournal(journal, { phase: 'web-started' });

  journal = persistJournal(journal, { phase: 'collecting' });
  const collect = runReleaseScript(staged.path, staged.runtime, 'scripts/collect.ts', [], {
    extraEnv: serviceEnv(config, staged.runtime),
  });
  writeCollectedOutput(collect.stdout, collect.stderr);
  if (collect.status === 2) {
    return failInstallActivation(
      root,
      journal,
      removeUnitsOnFailure,
      new InstallationError('the collector could not start (exit 2)'),
    );
  }
  if (collect.status === 1) {
    process.stdout.write(
      'One or more providers need setup or reported an error; the installation continues.\n',
    );
  }

  try {
    enableUnit(WEB_SERVICE);
    startTimer();
  } catch (err) {
    return failInstallActivation(root, journal, removeUnitsOnFailure, err);
  }
  journal = persistJournal(journal, { phase: 'activated' });

  const now = new Date().toISOString();
  const installed: InstallationState = state ?? {
    schemaVersion: 1,
    installationId: newInstallationId,
    installRoot: root,
    launcherPath,
    tag: resolved.tag,
    sha: resolved.sha,
    previous: null,
    runtime: staged.runtime,
    config,
    bridge: null,
    createdAt: now,
    updatedAt: now,
  };
  const committed: InstallationState = {
    ...installed,
    tag: resolved.tag,
    sha: resolved.sha,
    runtime: staged.runtime,
    config,
    updatedAt: now,
  };
  writeCommitArtifacts(committed, repo);
  journal = persistJournal(journal, { phase: 'committed' });
  finishJournal(root);

  let linger = lingerState(currentUser());
  if (args.enableLinger) {
    const result = enableLingerChecked();
    if (result !== null) {
      process.stderr.write(`${result}\n`);
      printInstallSummary(committed, repo, linger, false);
      return 1;
    }
    linger = lingerState(currentUser());
  }
  printInstallSummary(committed, repo, linger, true);
  return 0;
}

function writeCollectedOutput(stdout: string, stderr: string): void {
  if (stdout.trim() !== '') process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  if (stderr.trim() !== '') process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function addOwnershipEntry(
  record: OwnershipRecord,
  config: InstalledConfig,
  installationIdValue: string,
): OwnershipRecord {
  const already = record.entries.some(
    (entry) => realpathOrSelf(entry.databasePath) === realpathOrSelf(config.databasePath),
  );
  if (already) return record;
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    entries: [
      ...record.entries,
      {
        dataDir: config.dataDir,
        databasePath: config.databasePath,
        installationId: installationIdValue,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function failInstallActivation(
  root: string,
  journal: OperationJournal,
  removeUnitsOnFailure: boolean,
  err: unknown,
): number {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`installation did not complete: ${message}\n`);
  const created = removeUnitsOnFailure ? ownedUnits(root) : [];
  for (const name of created) {
    try {
      stopUnit(name);
    } catch {
      // best effort
    }
    try {
      disableUnit(name);
    } catch {
      // best effort
    }
    removeUnit(name);
  }
  if (created.length > 0) {
    try {
      daemonReload();
    } catch {
      // best effort
    }
  }
  const notes = [
    ...journal.notes,
    `failed:${message}`,
    `retained-install-root:${root}`,
    `retained-release:${journal.candidate?.sha ?? 'unknown'}`,
  ];
  persistJournal(journal, { failed: message, notes });
  process.stderr.write(
    `Retained data, configuration, and the staged release under ${root}. Re-run the installer to resume.\n`,
  );
  return 1;
}

function currentUser(): string {
  return process.env['USER'] ?? process.env['LOGNAME'] ?? '';
}

function enableLingerChecked(): string | null {
  const user = currentUser();
  const result = run('loginctl', ['enable-linger', user], { timeoutMs: 60_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`;
    return `could not enable linger for ${user}: ${detail}. Run it yourself when you have an active session:\n  loginctl enable-linger ${JSON.stringify(user)}`;
  }
  return null;
}

function printInstallSummary(
  state: InstallationState,
  repo: string,
  linger: string,
  ok: boolean,
): void {
  const url = httpUrl(state.config.host, state.config.port);
  process.stdout.write(
    [
      '',
      ok
        ? `AI Usage Dashboard ${state.tag} is installed.`
        : 'The installation completed with a linger warning.',
      `  launcher : ${state.launcherPath}`,
      `  release  : ${state.sha} (${repo})`,
      `  runtime  : Node v${state.runtime.nodeVersion}`,
      `  data     : ${state.config.dataDir}`,
      `  database : ${state.config.databasePath}`,
      `  url      : ${url}`,
      `  linger   : ${linger}`,
      '',
      'Connect providers in Settings, or sign in with the Codex CLI; no provider',
      'account is needed for the installation itself.',
      linger === 'yes'
        ? ''
        : `To keep it running after logout and start at boot: loginctl enable-linger ${JSON.stringify(currentUser())}`,
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

async function cmdUpdate(root: string, repo: string, args: ManagerArgs): Promise<number> {
  const state = readState(root);
  if (state === null) {
    fail(`there is no managed installation at ${root}`, 'Run the one-line installer first.');
  }

  if (args.dryRun) {
    const journal = readJournal(root);
    process.stdout.write(
      [
        'DRY RUN — nothing was written, downloaded, stopped, or migrated.',
        '',
        `install root : ${root}`,
        `active       : ${state.tag} (${state.sha.slice(0, 12)})`,
        args.version === null
          ? 'candidate    : would resolve the highest stable release (requires network access)'
          : `candidate    : would resolve --version ${args.version} (requires network access)`,
        ...(journal === null
          ? []
          : [
              `recovery     : PENDING — interrupted ${journal.kind} at phase ${journal.phase}; a dry run does not recover it`,
            ]),
        '',
        'Would stage the candidate, snapshot the units, stop writers, take a verified',
        'backup, migrate, install candidate units, health-check, refresh an owned',
        'Claude bridge, commit, and prune unreferenced releases.',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const foreign = foreignManagedUnits(root);
  if (foreign.length > 0) {
    fail(
      `these installed units are not owned by the managed root ${root}: ${foreign.map((unit) => `${unit.name} (${unit.path})`).join(', ')}`,
      'They belong to a manual or maintainer installation and an update would overwrite them. Remove them through that installation, or reinstall the managed root.',
    );
  }

  await recoverIfNeeded({ root, repo });
  const stateAfterRecovery = readState(root);
  if (stateAfterRecovery !== null && stateAfterRecovery.sha !== state.sha) {
    process.stdout.write(
      `Recovered before updating; the active release is now ${stateAfterRecovery.tag}.\n`,
    );
    return cmdUpdate(root, repo, args);
  }
  const active = stateAfterRecovery ?? state;

  const candidate: ResolvedRelease = resolveRelease(args.version, { repoUrl: repo });

  if (candidate.sha === active.sha) {
    process.stdout.write(
      `${active.tag} (${active.sha.slice(0, 12)}) is already active; nothing to do.\n`,
    );
    return 0;
  }
  if (candidate.tag === active.tag) {
    fail(
      `tag ${candidate.tag} moved: this installation records commit ${active.sha}, but the tag now resolves to ${candidate.sha}`,
      'Refusing to redeploy a moved tag. Publish a new version tag for the new commit.',
    );
  }
  if (compareTagStrings(candidate.tag, active.tag) < 0) {
    fail(
      `refusing to downgrade from ${active.tag} to ${candidate.tag}`,
      'Automatic recovery to the recorded previous release is the only backward transition.',
    );
  }

  const staged = await stageRelease(root, repo, candidate, active.runtime, (line) =>
    process.stdout.write(`  ${line}\n`),
  );
  installDependencies(staged.path, staged.runtime);
  buildRelease(root, staged.path, staged.runtime, active.config);
  nativeSmokeTest(staged.path, staged.runtime);

  const preInspection = inspectDatabase(staged.path, staged.runtime, active.config.databasePath);
  if (
    preInspection.exists &&
    preInspection.appliedMax !== null &&
    preInspection.appliedMax > preInspection.latest
  ) {
    fail(
      `the database has schema version ${preInspection.appliedMax}, newer than the ${preInspection.latest} ${candidate.tag} knows`,
      'Refusing an update that cannot read the database. Let a newer release handle it, or restore an older backup.',
    );
  }

  const snapshot = snapshotServices(currentUser());
  let journal = newJournal(
    root,
    'update',
    { tag: candidate.tag, sha: candidate.sha, runtime: staged.runtime },
    activeReleaseOf(active),
  );
  journal = persistJournal(journal, { phase: 'staged', snapshot });

  stopWriters();
  const holders = databaseHolders(staged.path, staged.runtime, active.config.databasePath);
  if (holders.length > 0) {
    applySnapshot(snapshot);
    fail(
      `the database is still open in process(es) ${holders.join(', ')} after stopping the units`,
      'Stop whatever else holds the database, then retry the update. The running release is unchanged.',
    );
  }
  const postInspection = inspectDatabase(staged.path, staged.runtime, active.config.databasePath);
  if (
    postInspection.exists &&
    postInspection.appliedMax !== null &&
    postInspection.appliedMax > postInspection.latest
  ) {
    applySnapshot(snapshot);
    fail(`the database became newer than ${candidate.tag} while staging; aborting`);
  }
  journal = persistJournal(journal, { phase: 'writers-stopped' });

  const destination = backupDestination(active.config.dataDir);
  process.stdout.write(`Taking a verified pre-cutover backup at ${destination}\n`);
  const backup = makeBackup(staged.path, staged.runtime, active.config.databasePath, destination);
  journal = persistJournal(journal, { phase: 'backed-up', backupPath: backup.path });

  journal = persistJournal(journal, { phase: 'db-changing' });
  runReleaseScript(staged.path, staged.runtime, 'scripts/migrate.ts', [], {
    extraEnv: serviceEnv(active.config, staged.runtime),
  });
  renderAndInstallUnits(staged.path, staged.runtime, active.config);
  journal = persistJournal(journal, { phase: 'candidate-units' });

  try {
    assertPortFree(active.config.host, active.config.port);
    resetFailedUnit(WEB_SERVICE);
    startUnit(WEB_SERVICE);
    await waitForHttp(httpUrl(active.config.host, active.config.port), healthTimeoutMs());
  } catch (err) {
    return failUpdateActivation(root, journal, active, snapshot, err);
  }
  journal = persistJournal(journal, { phase: 'candidate-web' });

  let bridge = active.bridge;
  if (bridge !== null) {
    if (!bridgeMatchesRecorded(bridge)) {
      process.stdout.write(
        `The Claude status line at ${bridge.settingsPath} was replaced outside the managed installation; leaving it untouched.\n`,
      );
      bridge = null;
    } else {
      try {
        refreshOwnedBridge(staged.path, staged.runtime, active.config, bridge.settingsPath);
        bridge =
          bridgeRecordFromSettings(staged.path, staged.runtime, bridge.settingsPath) ?? bridge;
      } catch (err) {
        return failUpdateActivation(root, journal, active, snapshot, err);
      }
    }
  }
  journal = persistJournal(journal, { phase: 'bridge-refreshed' });

  applySnapshot(snapshot);
  journal = persistJournal(journal, { phase: 'activated' });

  const now = new Date().toISOString();
  const next: InstallationState = {
    ...active,
    tag: candidate.tag,
    sha: candidate.sha,
    previous: activeReleaseOf(active),
    runtime: staged.runtime,
    bridge,
    updatedAt: now,
  };
  writeCommitArtifacts(next, repo);
  journal = persistJournal(journal, { phase: 'committed' });
  pruneRetention(root, next);
  finishJournal(root);
  process.stdout.write(
    [
      '',
      `Updated to ${candidate.tag} (${candidate.sha}).`,
      `  previous : ${active.tag} (${active.sha})`,
      `  backup   : ${backup.path}`,
      `  url      : ${httpUrl(next.config.host, next.config.port)}`,
      '',
    ].join('\n'),
  );
  return 0;
}

function failUpdateActivation(
  root: string,
  journal: OperationJournal,
  active: InstallationState,
  snapshot: OperationJournal['snapshot'],
  err: unknown,
): number {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`the candidate did not become healthy: ${message}\n`);
  process.stderr.write('Rolling back to the previous release and its database backup.\n');
  persistJournal(journal, { failed: message });
  try {
    recoverUpdate({ root, repo: repoUrl(process.env) }, journal, active);
  } catch (recoveryErr) {
    process.stderr.write(
      `automatic recovery failed: ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}\n`,
    );
    process.stderr.write(
      `Writers are stopped. Retained: previous release ${releaseDir(root, active.sha)}, backup ${journal.backupPath}, journal ${root}/operation.json\n`,
    );
    return 1;
  }
  void snapshot;
  return 1;
}

function pruneRetention(root: string, state: InstallationState): void {
  try {
    const unitContents = ([COLLECTOR_SERVICE, COLLECTOR_TIMER, WEB_SERVICE] as UnitName[]).map(
      (name) => {
        const path = unitFilePath(name);
        return exists(path) ? readFileSync(path, 'utf8') : '';
      },
    );
    const plan = planRetention({
      root,
      active: activeReleaseOf(state),
      previous: state.previous,
      unitContents,
      bridgeCommand: state.bridge?.command ?? null,
    });
    for (const path of plan.pruneReleases) {
      rmSync(path, { recursive: true, force: true });
      process.stdout.write(`Pruned release ${path}\n`);
    }
    for (const path of plan.pruneRuntimes) {
      rmSync(path, { recursive: true, force: true });
      process.stdout.write(`Pruned runtime ${path}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `pruning unreferenced releases failed: ${err instanceof Error ? err.message : err}\n`,
    );
    process.stderr.write(`Retained paths: ${releasesDir(root)}, ${join(root, 'runtime')}\n`);
  }
}

// ---------------------------------------------------------------------------
// Claude bridge
// ---------------------------------------------------------------------------

function claudeSettingsPath(): string {
  const explicit = process.env['CLAUDE_CONFIG_DIR']?.trim();
  const base = explicit && explicit !== '' ? explicit : join(homedir(), '.claude');
  return join(base, 'settings.json');
}

function bridgeCommandFromSettings(settingsPath: string): string | null {
  if (!exists(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      statusLine?: { command?: unknown };
    };
    const command = parsed.statusLine?.command;
    return typeof command === 'string' ? command : null;
  } catch {
    return null;
  }
}

export function bridgeMatchesRecorded(bridge: {
  settingsPath: string;
  command: string;
  releasePath: string;
  runtimePath: string;
}): boolean {
  const current = bridgeCommandFromSettings(bridge.settingsPath);
  if (current === null) return false;
  return (
    current.includes(bridge.releasePath) &&
    current.includes(join(bridge.runtimePath, 'bin', 'node'))
  );
}

function bridgeRecordFromSettings(
  releasePath: string,
  runtime: RuntimeRecord,
  settingsPath: string = claudeSettingsPath(),
): InstallationState['bridge'] {
  const command = bridgeCommandFromSettings(settingsPath);
  if (command === null || !command.includes(releasePath)) return null;
  return {
    settingsPath,
    command,
    releasePath,
    runtimePath: runtime.path,
    appliedAt: new Date().toISOString(),
  };
}

/**
 * Refresh the bridge at the *recorded* settings path. The caller's
 * `CLAUDE_CONFIG_DIR` must not move an owned bridge to another settings file:
 * the release script reads `CLAUDE_CONFIG_DIR`, so point it at the directory
 * `state.bridge.settingsPath` records.
 */
function refreshOwnedBridge(
  releasePath: string,
  runtime: RuntimeRecord,
  config: InstalledConfig,
  settingsPath: string,
): void {
  const result = runReleaseScript(
    releasePath,
    runtime,
    'scripts/install-claude-statusline.ts',
    ['--apply'],
    { extraEnv: { ...serviceEnv(config, runtime), CLAUDE_CONFIG_DIR: dirname(settingsPath) } },
  );
  if (result.status !== 0) {
    fail(
      `refreshing the Claude status-line bridge failed: ${result.stderr.trim() || `status ${result.status}`}`,
      'The previous release and database are restored automatically.',
    );
  }
}

async function cmdClaude(root: string, args: ManagerArgs): Promise<number> {
  const state = readState(root);
  if (state === null) {
    fail(`there is no managed installation at ${root}`, 'Run the one-line installer first.');
  }
  const releasePath = releaseDir(root, state.sha);
  const runtime = state.runtime;
  if (!exists(join(releasePath, 'node_modules', 'tsx'))) {
    fail(`the active release at ${releasePath} has no installed dependencies; run update first`);
  }
  const result = runReleaseScript(
    releasePath,
    runtime,
    'scripts/install-claude-statusline.ts',
    [...args.passthrough],
    { extraEnv: serviceEnv(state.config, runtime) },
  );
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  if (result.status !== 0) return result.status ?? 1;

  const uninstall = args.passthrough.includes('--uninstall');
  const apply = args.passthrough.includes('--apply');
  if (uninstall && apply) {
    if (state.bridge !== null) {
      writeState(root, { ...state, bridge: null, updatedAt: new Date().toISOString() });
    }
    return 0;
  }
  if (apply && !uninstall) {
    const record = bridgeRecordFromSettings(releasePath, runtime);
    if (record !== null) {
      writeState(root, { ...state, bridge: record, updatedAt: new Date().toISOString() });
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function cmdStatus(root: string): Promise<number> {
  const state = readState(root);
  const journal = readJournal(root);
  if (state === null) {
    if (journal !== null && journal.phase !== 'committed') {
      process.stdout.write(
        `No managed installation is complete at ${root}; an interrupted ${journal.kind} operation is recorded at phase ${journal.phase}.\n`,
      );
      process.stdout.write(
        `Run the installer to resume, or the launcher's ${journal.kind} command.\n`,
      );
      return 1;
    }
    process.stdout.write(`No managed installation at ${root}.\n`);
    return 1;
  }

  const lines: string[] = [];
  lines.push(`AI Usage Dashboard — managed installation at ${state.installRoot}`);
  lines.push(`  version   : ${state.tag} (${state.sha})`);
  lines.push(
    `  previous  : ${state.previous === null ? 'none' : `${state.previous.tag} (${state.previous.sha})`}`,
  );
  lines.push(`  runtime   : Node v${state.runtime.nodeVersion} at ${state.runtime.path}`);
  lines.push(`  data      : ${state.config.dataDir}`);
  lines.push(
    `  database  : ${state.config.databasePath} (${exists(state.config.databasePath) ? 'present' : 'missing'})`,
  );
  lines.push(`  url       : ${httpUrl(state.config.host, state.config.port)}`);
  lines.push(`  launcher  : ${state.launcherPath}`);
  if (journal !== null && journal.phase !== 'committed') {
    lines.push(`  recovery  : PENDING — interrupted ${journal.kind} at phase ${journal.phase}`);
    lines.push(`              run the update command (or re-run the installer) to recover`);
  } else {
    lines.push('  recovery  : none');
  }

  const webActive = activeState(WEB_SERVICE);
  const webEnabled = enabledState(WEB_SERVICE);
  const timerActive = activeState(COLLECTOR_TIMER);
  const timerEnabled = enabledState(COLLECTOR_TIMER);
  lines.push(`  web       : ${webActive} (${webEnabled})`);
  lines.push(`  timer     : ${timerActive} (${timerEnabled})`);
  lines.push(`  collector : ${activeState(COLLECTOR_SERVICE)} (one-shot)`);
  lines.push(`  linger    : ${lingerState(currentUser())}`);
  if (state.bridge === null) {
    lines.push('  bridge    : not installed');
  } else if (bridgeMatchesRecorded(state.bridge)) {
    lines.push(`  bridge    : owned (${state.bridge.settingsPath})`);
  } else {
    lines.push(`  bridge    : externally managed or removed (${state.bridge.settingsPath})`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (journal !== null && journal.phase !== 'committed') return 1;
  const healthy =
    webActive === 'active' && (timerEnabled === 'enabled' || timerEnabled === 'static');
  return healthy ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function cmdUninstall(root: string, args: ManagerArgs): Promise<number> {
  if (!exists(root)) {
    process.stdout.write(`No managed installation at ${root}; nothing to remove.\n`);
    return 0;
  }
  if (args.dryRun) {
    const stateBefore = readState(root);
    if (stateBefore === null) {
      process.stdout.write(`DRY RUN — would remove any owned remnants at ${root}.\n`);
      return 0;
    }
    const journal = readJournal(root);
    process.stdout.write(
      [
        'DRY RUN — nothing was written or stopped.',
        '',
        `install root : ${root}`,
        `version      : ${stateBefore.tag} (${stateBefore.sha})`,
        `data kept    : ${stateBefore.config.dataDir}`,
        ...(journal === null
          ? []
          : [
              `recovery     : PENDING — interrupted ${journal.kind} at phase ${journal.phase}; a dry run does not recover it`,
            ]),
        '',
        'Would stop the owned timer and web unit, remove owned units, remove an owned',
        'Claude bridge, remove the launcher, releases, runtime, cache, and metadata,',
        'and keep application data, credentials, backups, linger, the lock sentinel, and',
        'the data ownership record.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  const state = readState(root);
  await recoverIfNeeded({ root, repo: repoUrl(process.env) });
  const recovered = readState(root);
  if (state !== null && recovered === null) {
    process.stdout.write('Recovered a committed operation; retrying uninstall.\n');
    return cmdUninstall(root, args);
  }
  if (recovered === null) {
    return uninstallRemnants(root, args);
  }
  return runUninstall(root, recovered);
}

async function uninstallRemnants(root: string, args: ManagerArgs): Promise<number> {
  if (args.dryRun) {
    process.stdout.write(`DRY RUN — would remove any owned remnants at ${root}.\n`);
    return 0;
  }
  const owned = ownedUnits(root);
  const launcher = launcherPathFor();
  const launcherOwned = exists(launcher) && launcherIsOurs(readFileSync(launcher, 'utf8'), root);
  const managedDirs = ['releases', 'runtime', 'cache', 'current'].some((entry) =>
    exists(join(root, entry)),
  );
  if (owned.length === 0 && !launcherOwned && !managedDirs) {
    process.stdout.write(
      `No managed installation at ${root}; nothing to remove. Retained files (if any) are left untouched.\n`,
    );
    return 0;
  }
  for (const name of owned) {
    try {
      stopUnit(name);
    } catch {
      // best effort
    }
  }
  removeUnits(owned);
  if (launcherOwned) rmSync(launcher, { force: true });
  // No state means no live configuration or database claim to protect beyond
  // the data directory and the ownership record, which are never removed here.
  rmSync(join(root, 'current'), { force: true });
  rmSync(releasesDir(root), { recursive: true, force: true });
  rmSync(join(root, 'runtime'), { recursive: true, force: true });
  rmSync(cacheDir(root), { recursive: true, force: true });
  rmSync(join(root, 'state.json'), { force: true });
  finishJournal(root);
  process.stdout.write(
    'Removed the remaining owned execution surfaces; application data and the ownership record were not touched.\n',
  );
  return 0;
}

async function runUninstall(root: string, state: InstallationState): Promise<number> {
  const foreign = foreignManagedUnits(root);
  if (foreign.length > 0) {
    fail(
      `these installed units are not owned by ${root}: ${foreign.map((unit) => `${unit.name} (${unit.path})`).join(', ')}`,
      'Leaving them and the rest of the installation untouched.',
    );
  }
  if (exists(state.launcherPath)) {
    const content = readFileSync(state.launcherPath, 'utf8');
    if (!launcherIsOurs(content, root)) {
      fail(`${state.launcherPath} was not installed by this managed root; leaving it untouched`);
    }
  }
  if (
    isPhysicallyInside(state.config.dataDir, root) ||
    isPhysicallyInside(state.config.databasePath, root)
  ) {
    fail(
      `the application data directory ${state.config.dataDir} or its database physically resolves inside the install root ${root}`,
      'Uninstalling would delete application data. Move AUD_DATA_DIR and the database outside the install root first.',
    );
  }

  let journal = newJournal(root, 'uninstall', activeReleaseOf(state), null);
  journal = persistJournal(journal, { phase: 'starting' });

  stopWriters();
  journal = persistJournal(journal, { phase: 'writers-stopped' });

  if (state.bridge !== null) {
    if (!bridgeMatchesRecorded(state.bridge)) {
      process.stdout.write(
        `The Claude status line at ${state.bridge.settingsPath} is no longer the managed bridge; leaving it as it is.\n`,
      );
    } else {
      const releasePath = releaseDir(root, state.sha);
      const result = runReleaseScript(
        releasePath,
        state.runtime,
        'scripts/install-claude-statusline.ts',
        ['--uninstall', '--apply'],
        {
          extraEnv: {
            ...serviceEnv(state.config, state.runtime),
            CLAUDE_CONFIG_DIR: dirname(state.bridge.settingsPath),
          },
        },
      );
      writeCollectedOutput(result.stdout, result.stderr);
      if (result.status !== 0) {
        persistJournal(journal, {
          failed: `bridge removal failed with status ${result.status}`,
          notes: [`retained-release:${releasePath}`],
        });
        process.stderr.write(
          `The Claude status-line bridge could not be removed safely. Retained the runtime and release at ${releasePath} so the bridge keeps working.\n`,
        );
        return 1;
      }
    }
  }
  journal = persistJournal(journal, { phase: 'bridge-removed' });

  const owned = ownedUnits(root);
  removeUnits(owned);
  journal = persistJournal(journal, { phase: 'units-removed' });

  if (
    exists(state.launcherPath) &&
    launcherIsOurs(readFileSync(state.launcherPath, 'utf8'), root)
  ) {
    rmSync(state.launcherPath, { force: true });
  }
  journal = persistJournal(journal, { phase: 'launcher-removed' });

  rmSync(join(root, 'current'), { force: true });
  rmSync(releasesDir(root), { recursive: true, force: true });
  rmSync(join(root, 'runtime'), { recursive: true, force: true });
  rmSync(cacheDir(root), { recursive: true, force: true });
  rmSync(join(root, 'state.json'), { force: true });
  journal = persistJournal(journal, { phase: 'committed' });
  finishJournal(root);

  const ownership = readOwnership(root);
  process.stdout.write(
    [
      '',
      'AI Usage Dashboard managed installation removed.',
      `  kept data      : ${state.config.dataDir}`,
      `  kept ownership : ${join(root, 'data-ownership.json')} (${ownership.entries.length} entr${ownership.entries.length === 1 ? 'y' : 'ies'})`,
      `  linger         : ${lingerState(currentUser())} (unchanged)`,
      '',
      'Application data, credentials, backups, collector.env, CODEX_HOME, and provider',
      'state were preserved. Reinstalling from this root with the same configuration',
      'reuses the retained database.',
      '',
    ].join('\n'),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runManager(args: ManagerArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const { root, repo } = context(args, env);
  switch (args.command) {
    case 'install': {
      const tag = env['AUD_INSTALL_TAG']?.trim() ?? null;
      const sha = env['AUD_INSTALL_SHA']?.trim() ?? null;
      return cmdInstall(root, repo, args, {
        tag: tag === '' ? null : tag,
        sha: sha === '' ? null : sha,
      });
    }
    case 'update':
      return cmdUpdate(root, repo, args);
    case 'status':
      return cmdStatus(root);
    case 'uninstall':
      return cmdUninstall(root, args);
    case 'claude-statusline':
      return cmdClaude(root, args);
  }
}

export { InstallationError };
