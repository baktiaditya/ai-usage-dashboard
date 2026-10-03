/**
 * The private Node/Corepack runtime.
 *
 * The managed installation never uses the user's Node, nvm aliases, or global
 * packages. It provisions the exact Node release its committed manifest pins,
 * verifies the official archive's SHA-256 before extracting, and runs
 * everything through that runtime with a private Corepack/pnpm cache. Shell
 * profiles and the default Node are never touched.
 *
 * Stdlib-only by design (see `semver.ts`).
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exists } from './atomic.ts';
import { run, runOrThrow } from './exec.ts';
import type { RuntimeManifest } from './manifest.ts';
import { runtimeDir } from './install-paths.ts';
import type { RuntimeRecord } from './state.ts';

export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';
}

export const DEFAULT_NODE_DIST_BASE = 'https://nodejs.org/dist';

export function runtimeNodeBin(runtime: RuntimeRecord): string {
  return join(runtime.path, 'bin', 'node');
}

function archiveName(nodeVersion: string): string {
  return `node-v${nodeVersion}-linux-x64.tar.xz`;
}

function distBase(): string {
  const override = process.env['AUD_INSTALL_NODE_DIST_BASE']?.trim();
  return override && override !== '' ? override.replace(/\/+$/, '') : DEFAULT_NODE_DIST_BASE;
}

async function downloadTo(baseUrl: string, fileName: string, destination: string): Promise<void> {
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    const response = await fetch(`${baseUrl}/${fileName}`);
    if (!response.ok || response.body === null) {
      throw new RuntimeError(`downloading ${fileName} failed with HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(destination, { mode: 0o600 }),
    );
    return;
  }
  const local = baseUrl.startsWith('file://') ? baseUrl.slice('file://'.length) : baseUrl;
  await copyFile(join(local, fileName), destination);
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function listArchiveEntries(archive: string): string[] {
  const result = runOrThrow('tar', ['-tJf', archive]);
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

/** Refuse a tar/zip entry that would escape the staging directory. */
export function assertSafeArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const name = entry.replace(/^\.\//, '');
    if (name.startsWith('/') || name.startsWith('-')) {
      throw new RuntimeError(`the runtime archive contains an absolute entry: ${entry}`);
    }
    const components = name.split('/');
    if (components.includes('..')) {
      throw new RuntimeError(`the runtime archive contains a parent-directory entry: ${entry}`);
    }
  }
}

/** Run the extracted runtime's own binaries to prove it is what was promised. */
export function validateRuntimeDir(dir: string, nodeVersion: string): string {
  const node = join(dir, 'bin', 'node');
  if (!exists(node)) throw new RuntimeError(`no node binary at ${node}`);
  const version = runOrThrow(node, ['--version']).stdout.trim();
  if (version !== `v${nodeVersion}`) {
    throw new RuntimeError(`the runtime at ${dir} reports ${version}, expected v${nodeVersion}`);
  }
  const platform = runOrThrow(node, ['-p', 'process.platform']).stdout.trim();
  const arch = runOrThrow(node, ['-p', 'process.arch']).stdout.trim();
  if (platform !== 'linux' || arch !== 'x64') {
    throw new RuntimeError(`the runtime at ${dir} is ${platform}/${arch}, expected linux/x64`);
  }
  const corepack = join(dir, 'bin', 'corepack');
  if (!exists(corepack)) {
    throw new RuntimeError(
      `the runtime at ${dir} has no Corepack; the pinned Node release must ship it (Node 25 and later do not)`,
    );
  }
  const corepackCheck = run(corepack, ['--version'], { env: runtimePathEnv(dir) });
  if (corepackCheck.status !== 0) {
    throw new RuntimeError(
      `the runtime's Corepack does not run: ${corepackCheck.stderr.trim() || 'no output'}`,
    );
  }
  return node;
}

/** PATH with the private runtime first and the standard system directories after. */
export function runtimePathEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(dir, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
  };
}

export interface EnsureRuntimeOptions {
  readonly root: string;
  readonly manifest: RuntimeManifest;
  readonly dryRun?: boolean;
  /** Where an existing installation recorded the runtime, when it has one. */
  readonly existing?: RuntimeRecord | null;
  readonly log?: (line: string) => void;
}

/**
 * Return a validated runtime for `manifest`, provisioning it when needed.
 *
 * A failed download, checksum, extraction, or validation never leaves a
 * completed runtime directory: work happens in `runtime/.staging-*`, which is
 * renamed into place only after every check passes.
 */
export async function ensureRuntime(options: EnsureRuntimeOptions): Promise<RuntimeRecord> {
  const { root, manifest } = options;
  const log = options.log ?? (() => {});
  const dir = runtimeDir(root, manifest.nodeVersion);
  const record: RuntimeRecord = {
    nodeVersion: manifest.nodeVersion,
    path: dir,
    sha256: manifest.nodeSha256LinuxX64,
  };

  if (exists(dir)) {
    try {
      validateRuntimeDir(dir, manifest.nodeVersion);
      return record;
    } catch (err) {
      if (options.existing?.path === dir) {
        // A recorded runtime that no longer validates is corruption, not a
        // stray directory; replace it rather than silently reinstalling.
        log(
          `replacing an invalid managed runtime at ${dir}: ${err instanceof Error ? err.message : err}`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (options.dryRun) {
    log(`would download and extract Node v${manifest.nodeVersion} into ${dir}`);
    return record;
  }

  const stagingRoot = join(root, 'runtime');
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const staging = join(stagingRoot, `.staging-${manifest.nodeVersion}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const archive = join(staging, archiveName(manifest.nodeVersion));
  try {
    const distRoot = `${distBase()}/v${manifest.nodeVersion}`;
    log(`downloading Node v${manifest.nodeVersion} from ${distRoot}`);
    await downloadTo(distRoot, archiveName(manifest.nodeVersion), archive);
    const digest = sha256File(archive);
    if (digest !== manifest.nodeSha256LinuxX64) {
      throw new RuntimeError(
        `Node v${manifest.nodeVersion} archive checksum mismatch: expected ${manifest.nodeSha256LinuxX64}, got ${digest}`,
      );
    }
    const entries = listArchiveEntries(archive);
    assertSafeArchiveEntries(entries);
    const extractDir = join(staging, 'extracted');
    mkdirSync(extractDir, { recursive: true, mode: 0o700 });
    runOrThrow('tar', ['-xJf', archive, '-C', extractDir, '--strip-components=1']);
    validateRuntimeDir(extractDir, manifest.nodeVersion);
    rmSync(archive, { force: true });
    renameSync(extractDir, dir);
    return record;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface PnpmResolution {
  readonly version: string;
  readonly command: string;
}

/**
 * Prepare the exact pnpm the release pins, through the private Corepack.
 *
 * `packageManager` must name `pnpm@<version>+sha512.<hash>`; Corepack checks
 * the download against that hash. Downloads are non-interactive:
 * `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` removes the confirmation that would
 * otherwise wait on a TTY.
 */
export function preparePnpm(releaseDir: string, runtime: RuntimeRecord): PnpmResolution {
  let packageManager: unknown;
  try {
    packageManager = (
      JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf8')) as {
        packageManager?: unknown;
      }
    ).packageManager;
  } catch (err) {
    throw new RuntimeError(
      `could not read ${releaseDir}/package.json: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (typeof packageManager !== 'string') {
    throw new RuntimeError('the release does not pin a packageManager');
  }
  const match = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(packageManager);
  if (match === null) {
    throw new RuntimeError(
      `packageManager ${JSON.stringify(packageManager)} is not pnpm@<version>+sha512.<hash>`,
    );
  }
  const version = match[1] as string;
  const env = runtimeEnv(releaseDir, runtime);
  const install = run(join(runtime.path, 'bin', 'corepack'), ['install'], { cwd: releaseDir, env });
  if (install.status !== 0) {
    throw new RuntimeError(
      `corepack could not install pnpm@${version}: ${install.stderr.trim() || 'no output'}`,
    );
  }
  const check = run(join(runtime.path, 'bin', 'corepack'), ['pnpm', '--version'], {
    cwd: releaseDir,
    env,
  });
  if (check.status !== 0) {
    throw new RuntimeError(
      `corepack could not run pnpm@${version}: ${check.stderr.trim() || 'no output'}`,
    );
  }
  const actual = check.stdout.trim();
  if (actual !== version) {
    throw new RuntimeError(`corepack ran pnpm ${actual}, expected ${version}`);
  }
  return { version, command: join(runtime.path, 'bin', 'corepack') };
}

/** The environment every managed pnpm/Node child runs with. */
export function runtimeEnv(_releaseDir: string, runtime: RuntimeRecord): NodeJS.ProcessEnv {
  const root = join(runtime.path, '..', '..');
  return {
    ...process.env,
    PATH: `${join(runtime.path, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    COREPACK_HOME: join(root, 'cache', 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    HUSKY: '0',
    npm_config_store_dir: join(root, 'cache', 'pnpm-store'),
    npm_config_update_notifier: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    CI: '1',
  };
}

/** Run corepack's pnpm in a release checkout. */
export function runPnpm(
  releaseDir: string,
  runtime: RuntimeRecord,
  args: readonly string[],
  options: { readonly live?: boolean; readonly extraEnv?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof run> {
  const env = { ...runtimeEnv(releaseDir, runtime), ...options.extraEnv };
  const command = join(runtime.path, 'bin', 'corepack');
  const fullArgs = ['pnpm', ...args];
  return options.live === true
    ? runOrThrowLive(command, fullArgs, releaseDir, env)
    : runOrThrow(command, fullArgs, { cwd: releaseDir, env });
}

function runOrThrowLive(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof run> {
  const result = run(command, args, { cwd, env, timeoutMs: 60 * 60 * 1000 });
  if (result.error || result.status !== 0) {
    throw new RuntimeError(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`}`,
    );
  }
  return result;
}

/**
 * The `tsx` entry point inside a release's dependency tree. The manager never
 * uses a globally installed tsx; the release's own devDependencies carry it.
 */
export function releaseTsx(releaseDir: string): string {
  const tsx = join(releaseDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!exists(tsx)) {
    throw new RuntimeError(
      `${releaseDir} has no installed tsx at ${tsx}; run the managed install/update again`,
    );
  }
  return tsx;
}

/** Run one of the release's TypeScript scripts with its own dependencies. */
export function runReleaseScript(
  releaseDir: string,
  runtime: RuntimeRecord,
  script: string,
  args: readonly string[],
  options: {
    readonly live?: boolean;
    readonly extraEnv?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): ReturnType<typeof run> {
  const node = releaseTsx(releaseDir);
  const env = {
    ...runtimeEnv(releaseDir, runtime),
    ...options.extraEnv,
  };
  const fullArgs = [
    '--disable-warning=ExperimentalWarning',
    node,
    join(releaseDir, script),
    ...args,
  ];
  if (options.live === true) {
    const result = run(join(runtime.path, 'bin', 'node'), fullArgs, {
      cwd: releaseDir,
      env,
      timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
    });
    if (result.error || result.status !== 0) {
      throw new RuntimeError(
        `${script} failed: ${result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`}`,
      );
    }
    return result;
  }
  return run(join(runtime.path, 'bin', 'node'), fullArgs, {
    cwd: releaseDir,
    env,
    timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
  });
}
