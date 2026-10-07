/**
 * Integration coverage for the managed installer and lifecycle manager.
 *
 * These tests drive the real `scripts/manage-installation.ts` and
 * `scripts/install.sh` against a disposable sandbox: a fixture release
 * repository, a pre-placed private runtime whose `node` is a hard link to the
 * test process's Node, and PATH-level stubs for systemctl/loginctl/ss. Database
 * probes, backups, restores, and collection are fixture programs dispatched by
 * the release's stubbed tsx; the real systemd rehearsal is a separate script.
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startDashboardServer, type DashboardServer } from '../helpers/dashboard-server';

// These tests start real processes, fetch fixture archives, and run git; the
// suite-wide five-second default is too tight when the full suite competes for
// CPU, so this file uses a patient timeout.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..', '..');
const MANAGER = join(repoRoot, 'scripts', 'manage-installation.ts');
const BOOTSTRAP = join(repoRoot, 'scripts', 'install.sh');
const NODE_VERSION = '24.19.0';

/**
 * The managed installer is Linux-only by product contract: `scripts/install.sh`
 * refuses any other kernel, requires `flock`/`sha256sum`/a glibc userland, and
 * installs user systemd units. This suite drives that real bootstrap, so it
 * runs on Linux CI and is reported skipped elsewhere; faking a Linux userland
 * on macOS would test the fake, not the installer. The macOS verification job
 * still runs every other suite through `pnpm run verify`.
 */
const MANAGED_INSTALLER_RUNS_HERE = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Fixture text
// ---------------------------------------------------------------------------

const COREPACK_STUB = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
if [[ "$cmd" == "--version" ]]; then echo 0.35.0; exit 0; fi
if [[ "$cmd" == "install" ]]; then exit 0; fi
if [[ "$cmd" == "pnpm" ]]; then
  shift
  case "\${1:-}" in
    --version)
      node -p "require('./package.json').packageManager" | sed 's/^pnpm@//;s/+.*//'
      ;;
    install)
      exit 0
      ;;
    run)
      if [[ "\${2:-}" == "build" ]]; then mkdir -p .next; printf fixture > .next/BUILD_ID; fi
      ;;
  esac
  exit 0
fi
exit 0
`;

const TSX_STUB = `import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [script, ...args] = process.argv.slice(2);
const name = (script || '').split('/').pop();
const cfgPath = process.env.AUD_TEST_FIXTURE_CONFIG;
const cfg = cfgPath && existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
if (cfgPath) appendFileSync(cfgPath + '.calls', name + '\\n');
const config = cfg.config || {};
if (name === 'installation-probe.ts') {
  if (args[0] === 'config') console.log(JSON.stringify(config));
  else if (args[0] === 'db-inspect') {
    const exists = existsSync(config.databasePath);
    console.log(JSON.stringify({ exists, integrity: cfg.integrity ?? 'ok', appliedMax: cfg.appliedMax ?? null, latest: cfg.latest ?? 5 }));
  } else if (args[0] === 'db-holders') console.log(JSON.stringify({ pids: cfg.holders ?? [] }));
} else if (name === 'migrate.ts') {
  if (cfg.migrateFail) { process.stderr.write('fixture migrate failure\\n'); process.exit(1); }
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  writeFileSync(config.databasePath, 'fixture-db');
} else if (name === 'collect.ts') {
  process.exit(cfg.collectExit ?? 0);
} else if (name === 'db-backup.ts') {
  if (cfg.markerDir) writeFileSync(cfg.markerDir + '/backup-cwd', process.cwd());
  const dest = args[0];
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(config.databasePath, dest);
  console.log(JSON.stringify({ backup: dest, runs: 1 }));
} else if (name === 'db-restore.ts') {
  const source = args[0];
  if (cfg.markerDir) writeFileSync(cfg.markerDir + '/restore-data-dir', process.env.AUD_DATA_DIR || '');
  if (existsSync(config.databasePath)) copyFileSync(config.databasePath, config.databasePath + '.pre-restore-fixture');
  copyFileSync(source, config.databasePath);
  if (cfg.markerDir) writeFileSync(cfg.markerDir + '/restored', source);
  console.log(JSON.stringify({ restored: config.databasePath, from: source, migrated: 0, previous: null }));
} else if (name === 'install-claude-statusline.ts') {
  const settingsPath = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR.replace(/\\/$/, '') + '/settings.json'
    : cfg.settingsPath;
  const apply = args.includes('--apply');
  const uninstall = args.includes('--uninstall');
  if (!apply) { process.stdout.write('DRY RUN\\n'); process.exit(0); }
  let settings = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, 'utf8') || '{}');
  if (uninstall) {
    if (settings.statusLine) {
      const wrapped = /AUD_WRAPPED_CMD='((?:[^']|'\\\\'')*)'/.exec(settings.statusLine.command || '');
      if (wrapped) settings.statusLine = { ...settings.statusLine, type: 'command', command: wrapped[1].replaceAll("'\\\\''", "'") };
      else delete settings.statusLine;
    }
  } else {
    const runtimeNode = process.env.AUD_TEST_RUNTIME_NODE || process.execPath;
    const command = "AUD_SPOOL_PATH='" + config.dataDir + "/spool/claude-statusline.json' '" + runtimeNode + "' '" + process.cwd() + "/scripts/claude-statusline-bridge.mjs'";
    settings.statusLine = settings.statusLine
      ? { ...settings.statusLine, type: 'command', command }
      : { type: 'command', command, padding: 0 };
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  process.stdout.write('fixture status-line installer done\\n');
} else {
  process.stderr.write('unknown fixture script ' + name + '\\n');
  process.exit(1);
}
`;

const INSTALL_SYSTEMD_STUB = `#!/usr/bin/env bash
set -euo pipefail
dir="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$dir"
if [[ -n "\${AUD_DATA_DIR:-}" ]]; then mkdir -p "$AUD_DATA_DIR"; chmod 0700 "$AUD_DATA_DIR"; fi
for name in ai-usage-dashboard-collector.service ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service; do
  if [[ "$name" == *collector.timer* ]]; then
    printf '[Unit]\\nDescription=fixture %s\\n[Timer]\\nUnit=ai-usage-dashboard-collector.service\\n' "$name" > "$dir/$name"
  else
    printf '[Unit]\\nDescription=fixture %s\\n[Service]\\nWorkingDirectory=%s\\nEnvironment=AUD_PORT=%s\\n' "$name" "$PWD" "\${AUD_PORT:-}" > "$dir/$name"
  fi
done
`;

const RECORDING_MANAGER = `import { mkdirSync, writeFileSync } from 'node:fs';
const log = process.env.AUD_TEST_MANAGER_LOG;
if (log) {
  writeFileSync(log + '.args', process.argv.slice(2).join(' ') + '\\n');
  writeFileSync(log + '.env', JSON.stringify({ api: process.env.AUD_INSTALL_MANAGER_API, tag: process.env.AUD_INSTALL_TAG, sha: process.env.AUD_INSTALL_SHA, root: process.env.AUD_INSTALL_ROOT }) + '\\n');
}
const root = process.env.AUD_INSTALL_ROOT;
if (root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const sha = process.env.AUD_INSTALL_SHA;
  const tag = process.env.AUD_INSTALL_TAG;
  writeFileSync(root + '/state.json', JSON.stringify({
    schemaVersion: 1, installationId: 'fixture', installRoot: root, launcherPath: root + '/launcher',
    tag, sha, previous: null,
    runtime: { nodeVersion: '${NODE_VERSION}', path: root + '/runtime/node-v${NODE_VERSION}', sha256: 'a'.repeat(64) },
    config: { dataDir: root + '/data', databasePath: root + '/data/usage.db', envFile: root + '/collector.env', host: '127.0.0.1', port: 3838, intervalMinutes: 5, codexHome: root + '/codex', codexDir: null },
    bridge: null, createdAt: now, updatedAt: now,
  }, null, 2));
}
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly bin: string;
  readonly systemd: string;
  readonly root: string;
  readonly dataDir: string;
  readonly configPath: string;
  readonly repo: string;
  readonly runtimeDir: string;
  readonly port: number;
  readonly setPort: (port: number) => void;
  readonly calls: () => string[];
  readonly fixture: (patch: Record<string, unknown>) => void;
  readonly run: (
    command: string,
    args: readonly string[],
    extraEnv?: Record<string, string>,
  ) => { status: number | null; stdout: string; stderr: string };
  readonly runAsync: (
    command: string,
    args: readonly string[],
    extraEnv?: Record<string, string>,
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  readonly runBootstrap: (
    args: readonly string[],
    extraEnv?: Record<string, string>,
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

const cleanups: string[] = [];

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();
}

function writeFile(path: string, content: string | Uint8Array, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

/**
 * A version-faking `node` executable: it reports the pinned version/platform
 * the installer validates, and delegates everything else to the Node running
 * the tests. That keeps fixtures independent of the runner's exact Node
 * version and filesystem layout.
 */
function nodeWrapper(realNode: string, version: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then echo "v${version}"; exit 0; fi
if [[ "\${1:-}" == "-p" && "\${2:-}" == "process.platform" ]]; then echo linux; exit 0; fi
if [[ "\${1:-}" == "-p" && "\${2:-}" == "process.arch" ]]; then echo x64; exit 0; fi
exec "${realNode}" "$@"
`;
}

function releaseFiles(
  version: string,
  options: { readonly manifestSha: string; readonly manager?: string },
): Record<string, string> {
  const pkg = JSON.stringify(
    {
      name: 'fixture-release',
      version,
      private: true,
      packageManager: `pnpm@12.4.2+sha512.${'a'.repeat(128)}`,
      engines: { node: '^24.15.0' },
    },
    null,
    2,
  );
  return {
    'package.json': `${pkg}\n`,
    '.nvmrc': '24\n',
    'scripts/install-runtime.env': `NODE_VERSION=${NODE_VERSION}\nNODE_SHA256_LINUX_X64=${options.manifestSha}\n`,
    'scripts/manage-installation.ts': options.manager ?? 'process.exit(0);\n',
    'scripts/installation-probe.ts': '\n',
    'scripts/migrate.ts': '\n',
    'scripts/collect.ts': '\n',
    'scripts/db-backup.ts': '\n',
    'scripts/db-restore.ts': '\n',
    'scripts/install-claude-statusline.ts': '\n',
    'scripts/claude-statusline-bridge.mjs': '\n',
    'scripts/install-systemd.sh': INSTALL_SYSTEMD_STUB,
    'node_modules/tsx/dist/cli.mjs': TSX_STUB,
    'node_modules/better-sqlite3/package.json':
      '{"name":"better-sqlite3","version":"12.4.1","main":"index.js"}\n',
    'node_modules/better-sqlite3/index.js':
      'module.exports = class FixtureDatabase { constructor() {} close() {} };\n',
  };
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) writeFile(join(dir, relative), content);
}

interface FixtureReleaseSpec {
  readonly version: string;
  readonly tag: string;
  readonly manifestSha: string;
  readonly marker?: string;
}

function buildFixtureRepo(dir: string, releases: readonly FixtureReleaseSpec[]): string {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  if (releases.length === 0) {
    writeFile(join(dir, 'README.md'), 'no releases\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'base without releases'], dir);
  }
  for (const release of releases) {
    writeTree(
      dir,
      releaseFiles(release.version, {
        manifestSha: release.manifestSha,
        manager: RECORDING_MANAGER,
      }),
    );
    if (release.marker) writeFile(join(dir, 'MARKER'), release.marker);
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', `release ${release.tag}`], dir);
    git(['tag', release.tag], dir);
  }
  return dir;
}

function commitNextRelease(
  repo: string,
  release: { version: string; tag: string; manifestSha: string; marker?: string },
): string {
  writeTree(repo, releaseFiles(release.version, { manifestSha: release.manifestSha }));
  if (release.marker) writeFile(join(repo, 'MARKER'), release.marker);
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', `release ${release.tag}`], repo);
  git(['tag', release.tag], repo);
  return git(['rev-parse', `${release.tag}^{commit}`], repo);
}

function tagSha(repo: string, tag: string): string {
  return git(['rev-parse', `${tag}^{commit}`], repo);
}

function placeRuntime(root: string): void {
  const bin = join(root, 'runtime', `node-v${NODE_VERSION}`, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  rmSync(join(bin, 'node'), { force: true });
  writeFile(join(bin, 'node'), nodeWrapper(process.execPath, NODE_VERSION), 0o755);
  writeFile(join(bin, 'corepack'), COREPACK_STUB, 0o755);
  writeFile(join(root, 'runtime', `node-v${NODE_VERSION}`, '.validated'), '');
}

function writeStubs(bin: string): void {
  writeFile(
    join(bin, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
state="\${AUD_TEST_SYSTEMD_STATE:?}"
[[ "\${1:-}" == "--user" ]] && shift
cmd="\${1:-}"; shift || true
case "$cmd" in
  daemon-reload) exit 0 ;;
  is-active)
    if [[ -f "$state/active/$1" ]]; then cat "$state/active/$1"; exit 0; fi
    echo inactive; exit 3 ;;
  is-enabled)
    if [[ -f "$state/enabled/$1" ]]; then echo enabled; exit 0; fi
    echo disabled; exit 1 ;;
  start)
    mkdir -p "$state/active"
    echo active > "$state/active/$1"
    if [[ "\${AUD_TEST_FAIL_START:-}" == "$1" ]]; then exit 1; fi
    exit 0 ;;
  stop)
    if [[ "\${AUD_TEST_FAIL_STOP:-}" == "$1" ]]; then exit 1; fi
    rm -f "$state/active/$1"; exit 0 ;;
  enable)
    name="$1"
    if [[ "$name" == "--now" ]]; then name="\$2"; fi
    mkdir -p "$state/enabled"; echo enabled > "$state/enabled/$name"
    if [[ "$name" == *timer* ]]; then mkdir -p "$state/active"; echo active > "$state/active/$name"; fi
    exit 0 ;;
  disable)
    rm -f "$state/enabled/$1"
    exit 0 ;;
esac
exit 0
`,
    0o755,
  );
  writeFile(
    join(bin, 'loginctl'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  show-user)
    [[ -f "\${AUD_TEST_SYSTEMD_STATE:?}/linger" ]] && echo yes || echo "\${AUD_TEST_LINGER:-no}"
    exit 0 ;;
  enable-linger)
    if [[ "\${AUD_TEST_LINGER_FAIL:-}" == "1" ]]; then echo "fixture: polkit denied" >&2; exit 1; fi
    mkdir -p "\${AUD_TEST_SYSTEMD_STATE:?}"; echo yes > "\${AUD_TEST_SYSTEMD_STATE}/linger"
    exit 0 ;;
esac
exit 0
`,
    0o755,
  );
  writeFile(
    join(bin, 'ss'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${AUD_TEST_PORT_BUSY:-}" == "1" ]]; then echo 'LISTEN 0 128 127.0.0.1:1 0.0.0.0:*'; fi
exit 0
`,
    0o755,
  );
  writeFile(join(bin, 'journalctl'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  writeFile(join(bin, 'codex'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
}

function makeSandbox(options: {
  readonly releases: readonly FixtureReleaseSpec[];
  readonly manifestSha: string;
  readonly port: number;
}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'aud-install-it-'));
  cleanups.push(dir);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const systemd = join(dir, 'systemd');
  const dataDir = join(dir, 'data');
  const root = join(home, '.local', 'share', 'ai-usage-dashboard-install');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, '.config'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(systemd, { recursive: true });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeStubs(bin);

  const configPath = join(dir, 'fixture-config.json');
  buildFixtureRepo(repo, options.releases);

  let port = options.port;
  const fixture = (patch: Record<string, unknown>): void => {
    const base = {
      config: {
        envFile: join(home, '.config', 'ai-usage-dashboard', 'collector.env'),
        dataDir,
        databasePath: join(dataDir, 'usage.db'),
        host: '127.0.0.1',
        port,
        intervalMinutes: 5,
      },
      collectExit: 0,
      holders: [],
      appliedMax: null,
      latest: 5,
      markerDir: join(dir, 'markers'),
    };
    writeFileSync(configPath, JSON.stringify({ ...base, ...patch }, null, 2));
  };
  fixture({});
  mkdirSync(join(dir, 'markers'), { recursive: true });

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: join(home, 'run'),
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    AUD_TEST_SYSTEMD_STATE: systemd,
    AUD_TEST_FIXTURE_CONFIG: configPath,
    AUD_TEST_RUNTIME_NODE: join(root, 'runtime', `node-v${NODE_VERSION}`, 'bin', 'node'),
    AUD_INSTALL_REPO_URL: repo,
    AUD_INSTALL_HEALTH_TIMEOUT_SECONDS: '3',
    ...extra,
  });

  return {
    dir,
    home,
    bin,
    systemd,
    root,
    dataDir,
    configPath,
    repo,
    runtimeDir: join(root, 'runtime', `node-v${NODE_VERSION}`),
    get port() {
      return port;
    },
    setPort: (assignedPort) => {
      port = assignedPort;
      const current = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(
        configPath,
        JSON.stringify({ ...current, config: { ...current.config, port } }, null, 2),
      );
    },
    calls: () => {
      const path = `${configPath}.calls`;
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : [];
    },
    fixture,
    run: (command, args, extraEnv = {}) => {
      const result = spawnSync(command, [...args], {
        encoding: 'utf8',
        env: env(extraEnv),
        cwd: dir,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    runAsync: async (command, args, extraEnv = {}) => {
      try {
        const result = await execFileAsync(command, [...args], {
          encoding: 'utf8',
          env: env(extraEnv),
          cwd: dir,
        });
        return { status: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (err) {
        const failure = err as { code?: number; stdout?: string; stderr?: string };
        return {
          status: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
        };
      }
    },
    runBootstrap: async (args, extraEnv = {}) => {
      try {
        const result = await execFileAsync('/usr/bin/bash', [BOOTSTRAP, ...args], {
          encoding: 'utf8',
          env: env(extraEnv),
          cwd: dir,
        });
        return { status: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (err) {
        const failure = err as { code?: number; stdout?: string; stderr?: string };
        return {
          status: typeof failure.code === 'number' ? failure.code : 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
        };
      }
    },
  };
}

function manager(sandbox: Sandbox, args: readonly string[], extraEnv: Record<string, string> = {}) {
  return sandbox.run(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', MANAGER, ...args],
    extraEnv,
  );
}

function installEnv(
  sandbox: Sandbox,
  tag: string,
  sha: string,
  extra: Record<string, string> = {},
) {
  return {
    AUD_INSTALL_MANAGER_API: '1',
    AUD_INSTALL_ROOT: sandbox.root,
    AUD_INSTALL_TAG: tag,
    AUD_INSTALL_SHA: sha,
    AUD_INSTALL_REPO_URL: sandbox.repo,
    ...extra,
  };
}

async function waitForHttpToStop(port: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const probe = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    if (probe === null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readState(sandbox: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sandbox.root, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function unitFile(sandbox: Sandbox, name: string): string | null {
  const path = join(sandbox.home, '.config', 'systemd', 'user', name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const COLLECTOR = 'ai-usage-dashboard-collector.service';
const TIMER = 'ai-usage-dashboard-collector.timer';
const WEB = 'ai-usage-dashboard-web.service';

/** A service snapshot as `snapshotServices` would have captured it. */
function unitSnapshot(sandbox: Sandbox): Record<string, unknown> {
  const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
  return {
    unitFiles: Object.fromEntries(
      [COLLECTOR, TIMER, WEB].map((name) => [
        name,
        existsSync(join(unitDir, name)) ? readFileSync(join(unitDir, name), 'utf8') : null,
      ]),
    ),
    enabled: { [COLLECTOR]: 'disabled', [TIMER]: 'enabled', [WEB]: 'enabled' },
    active: { [COLLECTOR]: 'inactive', [TIMER]: 'active', [WEB]: 'active' },
    linger: 'no',
  };
}

/** A valid interrupted-update journal for recovery-path tests. */
function writeUpdateJournal(
  sandbox: Sandbox,
  options: {
    readonly phase: string;
    readonly candidateSha: string;
    readonly backupPath?: string | null;
    readonly snapshot?: Record<string, unknown> | null;
  },
): void {
  const active = readState(sandbox);
  const runtime = {
    nodeVersion: NODE_VERSION,
    path: join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`),
    sha256: 'a'.repeat(64),
  };
  writeFile(
    join(sandbox.root, 'operation.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        operationId: 'crashed-op',
        kind: 'update',
        phase: options.phase,
        pid: 999999,
        root: sandbox.root,
        candidate: { tag: 'v0.1.1', sha: options.candidateSha, runtime },
        previous: { tag: active['tag'], sha: active['sha'], runtime },
        backupPath: options.backupPath ?? null,
        snapshot: options.snapshot ?? null,
        dbOwnershipRecorded: false,
        failed: null,
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function writeInstallJournal(
  sandbox: Sandbox,
  options: {
    readonly phase: string;
    readonly candidateSha: string;
    readonly databasePath?: string;
    readonly dbOwnershipRecorded?: boolean;
  },
): void {
  const runtime = {
    nodeVersion: NODE_VERSION,
    path: join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`),
    sha256: 'a'.repeat(64),
  };
  writeFile(
    join(sandbox.root, 'operation.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        operationId: 'interrupted-install',
        kind: 'install',
        phase: options.phase,
        pid: 999999,
        root: sandbox.root,
        candidate: { tag: 'v0.1.0', sha: options.candidateSha, runtime },
        previous: null,
        backupPath: null,
        snapshot: null,
        databasePath: options.databasePath ?? join(sandbox.dataDir, 'usage.db'),
        dbOwnershipRecorded: options.dbOwnershipRecorded ?? true,
        failed: null,
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function markUnitActive(sandbox: Sandbox, name: string, active: boolean): void {
  const path = join(sandbox.systemd, 'active', name);
  if (active) {
    mkdirSync(join(sandbox.systemd, 'active'), { recursive: true });
    writeFile(path, 'active');
  } else {
    rmSync(path, { force: true });
  }
}

const PORT_BASE = 41_000 + Math.floor(Math.random() * 2_000);
let portCounter = 0;
function nextPort(): number {
  portCounter += 1;
  return PORT_BASE + portCounter;
}

/** Each live fixture owns an OS-assigned port and is registered for cleanup. */
async function startDashboard(sandbox: Sandbox): Promise<DashboardServer> {
  const server = await startDashboardServer();
  suiteServer.push(server);
  sandbox.setPort(server.port);
  return server;
}

const suiteServer: DashboardServer[] = [];
const archiveRegistry = new Map<string, Buffer>();
let archiveServer: Server | null = null;
let archiveServerPort = 0;

beforeAll(async () => {
  archiveServer = createServer((request, response) => {
    const body = archiveRegistry.get(request.url ?? '');
    if (body === undefined) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200);
    response.end(body);
  });
  await new Promise<void>((resolve) => archiveServer?.listen(0, '127.0.0.1', resolve));
  archiveServerPort = (archiveServer.address() as AddressInfo).port;
});

afterAll(() => {
  archiveServer?.close();
});

function registerArchive(archivePath: string): void {
  archiveRegistry.set(
    `/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
    readFileSync(archivePath),
  );
}

/**
 * Create the runtime tarball with tar's `-J` xz filter, which both GNU tar and
 * BSD tar/libarchive support. GNU tar's `-I 'xz -T0 -0'` spelling relies on
 * spawning `xz` and on GNU option handling, so BSD tar rejects it.
 */
function createNodeArchive(build: string, archivePath: string): void {
  execFileSync('tar', ['-cJf', archivePath, '-C', build, `node-v${NODE_VERSION}-linux-x64`]);
}

afterEach(async () => {
  await Promise.all(suiteServer.splice(0).map((server) => server.close()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!MANAGED_INSTALLER_RUNS_HERE)('managed installer bootstrap', () => {
  let archivePath: string;
  let manifestSha: string;

  beforeAll(() => {
    const build = mkdtempSync(join(tmpdir(), 'aud-node-archive-'));
    cleanups.push(build);
    const tree = join(build, `node-v${NODE_VERSION}-linux-x64`);
    mkdirSync(join(tree, 'bin'), { recursive: true });
    writeFile(join(tree, 'bin', 'node'), nodeWrapper(process.execPath, NODE_VERSION), 0o755);
    writeFile(join(tree, 'bin', 'corepack'), COREPACK_STUB, 0o755);
    archivePath = join(build, `node-v${NODE_VERSION}-linux-x64.tar.xz`);
    createNodeArchive(build, archivePath);
    manifestSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  }, 60_000);

  it('cold-bootstraps with no node/pnpm on PATH, provisions the runtime, and hands off with tag/SHA/API', async () => {
    const port = nextPort();
    const sandbox = makeSandbox({
      releases: [{ version: '0.1.0', tag: 'v0.1.0', manifestSha }],
      manifestSha,
      port,
    });
    registerArchive(archivePath);
    const log = join(sandbox.dir, 'manager-log');
    // A PATH with the required tools but no node/pnpm/corepack from the host.
    const tools = [
      'uname',
      'id',
      'getconf',
      'git',
      'curl',
      'tar',
      'xz',
      'sha256sum',
      'flock',
      'mktemp',
      'rm',
      'mkdir',
      'mv',
      'chmod',
      'sed',
      'grep',
      'head',
      'tr',
      'sort',
      'awk',
      'env',
      'bash',
      'blockdev',
      'dirname',
    ];
    const minbin = join(sandbox.dir, 'minbin');
    mkdirSync(minbin, { recursive: true });
    for (const tool of tools) {
      const which = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' }).stdout.trim();
      if (which !== '' && existsSync(which)) symlinkSync(which, join(minbin, tool));
    }
    const sha = tagSha(sandbox.repo, 'v0.1.0');
    const result = await sandbox.runBootstrap(['--version', 'v0.1.0'], {
      PATH: `${minbin}:${sandbox.bin}`,
      AUD_TEST_MANAGER_LOG: log,
      AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
    });
    expect(result.stderr).not.toContain('error:');
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`, 'bin', 'node'))).toBe(
      true,
    );
    expect(existsSync(join(sandbox.root, 'releases', sha))).toBe(true);
    const envRecord = JSON.parse(readFileSync(`${log}.env`, 'utf8')) as Record<string, string>;
    expect(envRecord.api).toBe('1');
    expect(envRecord.tag).toBe('v0.1.0');
    expect(envRecord.sha).toBe(sha);
    expect(readFileSync(`${log}.args`, 'utf8')).toContain('install');
  });

  it('selects the highest stable release reachable from main when no version is given', async () => {
    const port = nextPort();
    const sandbox = makeSandbox({
      releases: [
        { version: '0.1.0', tag: 'v0.1.0', manifestSha },
        { version: '0.1.1', tag: 'v0.1.1', manifestSha },
        { version: '0.2.0-rc.1', tag: 'v0.2.0-rc.1', manifestSha },
      ],
      manifestSha,
      port,
    });
    registerArchive(archivePath);
    const log = join(sandbox.dir, 'manager-log');
    const result = await sandbox.runBootstrap([], {
      PATH: `${sandbox.bin}:${process.env['PATH'] ?? ''}`,
      AUD_TEST_MANAGER_LOG: log,
      AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
    });
    expect(result.status, result.stderr).toBe(0);
    const envRecord = JSON.parse(readFileSync(`${log}.env`, 'utf8')) as Record<string, string>;
    expect(envRecord.tag).toBe('v0.1.1');
    expect(envRecord.sha).toBe(tagSha(sandbox.repo, 'v0.1.1'));
  });

  it('refuses a checksum mismatch without leaving a completed runtime', async () => {
    const port = nextPort();
    const sandbox = makeSandbox({
      releases: [{ version: '0.1.0', tag: 'v0.1.0', manifestSha: 'f'.repeat(64) }],
      manifestSha: 'f'.repeat(64),
      port,
    });
    registerArchive(archivePath);
    const result = await sandbox.runBootstrap(['--version', 'v0.1.0'], {
      AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(existsSync(join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`, 'bin', 'node'))).toBe(
      false,
    );
  });

  it('fails on a missing explicit release before provisioning anything', async () => {
    const sandbox = makeSandbox({
      releases: [{ version: '0.1.0', tag: 'v0.1.0', manifestSha }],
      manifestSha,
      port: nextPort(),
    });
    const result = await sandbox.runBootstrap(['--version', 'v9.9.9'], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
  });

  it('fails when no stable release exists', async () => {
    const sandbox = makeSandbox({ releases: [], manifestSha, port: nextPort() });
    const result = await sandbox.runBootstrap([], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no stable release/);
  });

  it('refuses a moved tag recorded in state instead of upgrading it', async () => {
    const port = nextPort();
    const sandbox = makeSandbox({
      releases: [{ version: '0.1.0', tag: 'v0.1.0', manifestSha }],
      manifestSha,
      port,
    });
    registerArchive(archivePath);
    const log = join(sandbox.dir, 'manager-log');
    const first = await sandbox.runBootstrap(['--version', 'v0.1.0'], {
      AUD_TEST_MANAGER_LOG: log,
      AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
    });
    expect(first.status, first.stderr).toBe(0);
    writeTree(sandbox.repo, releaseFiles('0.1.0', { manifestSha }));
    writeFile(join(sandbox.repo, 'CHANGED'), 'moved');
    git(['add', '-A'], sandbox.repo);
    git(['commit', '-q', '-m', 'move tag'], sandbox.repo);
    git(['tag', '-f', 'v0.1.0'], sandbox.repo);
    const second = await sandbox.runBootstrap(['--version', 'v0.1.0'], {
      AUD_TEST_MANAGER_LOG: log,
      AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
    });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('moved');
  });

  it('runs piped from stdin without a TTY and never needs an answer', () => {
    const piped = spawnSync(
      '/usr/bin/bash',
      ['-c', `cat "${BOOTSTRAP}" | /usr/bin/bash -s -- --help`],
      {
        encoding: 'utf8',
      },
    );
    expect(piped.status).toBe(0);
    expect(piped.stdout).toContain('managed Linux installation bootstrap');
    const bad = spawnSync(
      '/usr/bin/bash',
      ['-c', `cat "${BOOTSTRAP}" | /usr/bin/bash -s -- --bogus`],
      {
        encoding: 'utf8',
      },
    );
    expect(bad.status).toBe(2);
  });

  it('rejects an unknown bootstrap-to-manager interface before mutation', () => {
    const result = manager(
      makeSandbox({ releases: [], manifestSha, port: nextPort() }),
      ['install', '--install-dir', '/tmp/does-not-matter'],
      { AUD_INSTALL_MANAGER_API: '2' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interface');
  });
});

describe.skipIf(!MANAGED_INSTALLER_RUNS_HERE)('managed installation lifecycle', () => {
  let archivePath = '';
  let manifestSha = 'a'.repeat(64);

  beforeAll(() => {
    const build = mkdtempSync(join(tmpdir(), 'aud-node-archive-'));
    cleanups.push(build);
    const tree = join(build, `node-v${NODE_VERSION}-linux-x64`);
    mkdirSync(join(tree, 'bin'), { recursive: true });
    writeFile(join(tree, 'bin', 'node'), nodeWrapper(process.execPath, NODE_VERSION), 0o755);
    writeFile(join(tree, 'bin', 'corepack'), COREPACK_STUB, 0o755);
    archivePath = join(build, `node-v${NODE_VERSION}-linux-x64.tar.xz`);
    createNodeArchive(build, archivePath);
    manifestSha = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  }, 60_000);

  function freshSandbox(port = nextPort()): Sandbox {
    return makeSandbox({
      releases: [{ version: '0.1.0', tag: 'v0.1.0', manifestSha }],
      manifestSha,
      port,
    });
  }

  function installV010(sandbox: Sandbox, extra: Record<string, string> = {}) {
    placeRuntime(sandbox.root);
    return manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', tagSha(sandbox.repo, 'v0.1.0'), extra),
    );
  }

  it('status reports absent without creating anything', () => {
    const sandbox = freshSandbox();
    const result = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('No managed installation');
    expect(existsSync(sandbox.root)).toBe(false);
    expect(sandbox.calls()).toEqual([]);
  });

  it('rejects unknown arguments and exposes help without installation', async () => {
    const sandbox = freshSandbox();
    expect(manager(sandbox, ['frobnicate']).status).toBe(2);
    expect(manager(sandbox, ['--bogus']).status).toBe(2);
    expect(manager(sandbox, ['--help']).status).toBe(0);
    expect((await sandbox.runBootstrap(['--help'])).status).toBe(0);
    expect(manager(sandbox, ['update', '--enable-linger']).status).toBe(2);
  });

  it('installs a fresh managed root: private runtime, units, timer, launcher, ownership, and health', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    const result = installV010(sandbox);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('is installed');

    const state = readState(sandbox);
    expect(state['tag']).toBe('v0.1.0');
    expect(state['sha']).toBe(tagSha(sandbox.repo, 'v0.1.0'));
    expect(state['previous']).toBeNull();
    const config = state['config'] as Record<string, unknown>;
    expect(config['databasePath']).toBe(join(sandbox.dataDir, 'usage.db'));
    expect(config['codexDir']).toBe(sandbox.bin);
    expect(existsSync(join(sandbox.dataDir, 'usage.db'))).toBe(true);

    const launcher = join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard');
    expect(existsSync(launcher)).toBe(true);
    expect(statSync(launcher).mode & 0o111).toBeGreaterThan(0);
    expect(readFileSync(launcher, 'utf8')).toContain('runtime/current/bin/node');
    expect(existsSync(join(sandbox.root, 'current', 'scripts', 'manage-installation.ts'))).toBe(
      true,
    );
    expect(readlinkSync(join(sandbox.root, 'current'))).toContain('/releases/');
    expect(existsSync(join(sandbox.root, 'runtime', 'current', 'bin', 'node'))).toBe(true);

    const web = unitFile(sandbox, 'ai-usage-dashboard-web.service');
    expect(web).toContain(`WorkingDirectory=${sandbox.root}/releases/`);
    expect(existsSync(join(sandbox.systemd, 'enabled', 'ai-usage-dashboard-web.service'))).toBe(
      true,
    );
    expect(existsSync(join(sandbox.systemd, 'active', 'ai-usage-dashboard-web.service'))).toBe(
      true,
    );
    expect(existsSync(join(sandbox.systemd, 'enabled', 'ai-usage-dashboard-collector.timer'))).toBe(
      true,
    );
    expect(existsSync(join(sandbox.systemd, 'active', 'ai-usage-dashboard-collector.timer'))).toBe(
      true,
    );

    const ownership = JSON.parse(
      readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8'),
    ) as {
      entries: { databasePath: string; installationId: string }[];
    };
    expect(ownership.entries).toHaveLength(1);
    expect(ownership.entries[0]?.databasePath).toBe(join(sandbox.dataDir, 'usage.db'));
    expect(ownership.entries[0]?.installationId).toBe(state['installationId']);
    expect(sandbox.calls()).toContain('collect.ts');
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);

    const status = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('v0.1.0');
    expect(status.stdout).toContain('web       : active');
    expect(status.stdout).toContain('recovery  : none');
    await server.close();
  });

  it('treats collector exit 1 as installation success and exit 2 as recoverable failure', async () => {
    const success = freshSandbox();
    const server = await startDashboard(success);
    success.fixture({ collectExit: 1 });
    const ok = installV010(success);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('providers need setup or reported an error');
    expect(existsSync(join(success.root, 'state.json'))).toBe(true);
    await server.close();

    const failing = freshSandbox();
    placeRuntime(failing.root);
    await startDashboard(failing);
    failing.fixture({ collectExit: 2 });
    const failed = installV010(failing);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('collector could not start');
    expect(existsSync(join(failing.root, 'state.json'))).toBe(false);
    expect(existsSync(join(failing.dataDir, 'usage.db'))).toBe(true);
    const journal = JSON.parse(readFileSync(join(failing.root, 'operation.json'), 'utf8')) as {
      kind: string;
      phase: string;
      failed: string | null;
    };
    expect(journal.kind).toBe('install');
    expect(journal.failed).toContain('collector could not start');
    expect(unitFile(failing, 'ai-usage-dashboard-web.service')).toBeNull();
    expect(existsSync(join(failing.root, 'launcher'))).toBe(false);

    // A resumed install with a healthy collector completes without recreating the database.
    failing.fixture({ collectExit: 0 });
    const resumed = installV010(failing);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(existsSync(join(failing.root, 'state.json'))).toBe(true);
    expect(existsSync(join(failing.root, 'operation.json'))).toBe(false);
  });

  it('refuses to take over an occupied root, a foreign unit, or a foreign launcher', () => {
    const occupied = freshSandbox();
    mkdirSync(occupied.root, { recursive: true });
    writeFile(join(occupied.root, 'unrelated.txt'), 'keep me');
    const occupiedResult = installV010(occupied);
    expect(occupiedResult.status).toBe(1);
    expect(occupiedResult.stderr).toContain('not empty');
    expect(readFileSync(join(occupied.root, 'unrelated.txt'), 'utf8')).toBe('keep me');

    const foreignUnit = freshSandbox();
    writeFile(
      join(foreignUnit.home, '.config', 'systemd', 'user', 'ai-usage-dashboard-web.service'),
      '[Service]\nWorkingDirectory=/home/someone/manual-checkout\n',
    );
    const foreignResult = installV010(foreignUnit);
    expect(foreignResult.status).toBe(1);
    expect(foreignResult.stderr).toContain('not owned');
    expect(foreignResult.stdout + foreignResult.stderr).not.toContain('is installed');

    const foreignLauncher = freshSandbox();
    writeFile(
      join(foreignLauncher.home, '.local', 'bin', 'ai-usage-dashboard'),
      '#!/bin/sh\necho mine\n',
      0o755,
    );
    const launcherResult = installV010(foreignLauncher);
    expect(launcherResult.status).toBe(1);
    expect(launcherResult.stderr).toContain('launcher');
    expect(
      readFileSync(join(foreignLauncher.home, '.local', 'bin', 'ai-usage-dashboard'), 'utf8'),
    ).toContain('echo mine');
  });

  it('provisions the private runtime through the manager when none is present', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    registerArchive(archivePath);
    const result = await sandbox.runAsync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', MANAGER, 'install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', tagSha(sandbox.repo, 'v0.1.0'), {
        AUD_INSTALL_NODE_DIST_BASE: `http://127.0.0.1:${archiveServerPort}`,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`, 'bin', 'node'))).toBe(
      true,
    );
    expect(existsSync(join(sandbox.root, 'runtime', 'current', 'bin', 'node'))).toBe(true);
    await server.close();
  });

  it('refuses an unrecorded, in-use, or newer database before any writable open', async () => {
    const unrecorded = freshSandbox();
    placeRuntime(unrecorded.root);
    mkdirSync(unrecorded.dataDir, { recursive: true, mode: 0o700 });
    writeFile(join(unrecorded.dataDir, 'usage.db'), 'someone-elses-db');
    const unrecordedResult = installV010(unrecorded);
    expect(unrecordedResult.status).toBe(1);
    expect(unrecordedResult.stderr).toContain('ownership record does not name it');
    expect(readFileSync(join(unrecorded.dataDir, 'usage.db'), 'utf8')).toBe('someone-elses-db');
    expect(unrecorded.calls()).not.toContain('migrate.ts');

    const inUse = freshSandbox();
    placeRuntime(inUse.root);
    await startDashboard(inUse);
    inUse.fixture({ holders: [4321] });
    // Installed once, then re-run with the recorded database in use.
    const first = installV010WithFixture(inUse, { collectExit: 0 });
    expect(first.status, first.stderr).toBe(0);
    inUse.fixture({ holders: [4321] });
    const second = installV010(inUse);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('open in process(es) 4321');

    const newer = freshSandbox();
    placeRuntime(newer.root);
    await startDashboard(newer);
    const seeded = installV010WithFixture(newer, { collectExit: 0, appliedMax: 7, latest: 5 });
    expect(seeded.status, seeded.stderr).toBe(0);
    newer.fixture({ appliedMax: 7, latest: 5 });
    const newerResult = installV010(newer);
    expect(newerResult.status).toBe(1);
    expect(newerResult.stderr).toContain('newer than');
  });

  it('fails installation when the port is busy and removes only newly created units', () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    sandbox.fixture({});
    const result = manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', tagSha(sandbox.repo, 'v0.1.0'), { AUD_TEST_PORT_BUSY: '1' }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already in use');
    expect(result.stdout + result.stderr).not.toContain('is installed');
    expect(unitFile(sandbox, 'ai-usage-dashboard-web.service')).toBeNull();
    expect(existsSync(join(sandbox.dataDir, 'usage.db'))).toBe(true);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(true);
  });

  it('refuses concurrent lifecycle operations before mutation', async () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const holder = spawn(
      'flock',
      ['--nonblock', join(sandbox.root, 'lifecycle.lock'), 'sleep', '3'],
      {
        stdio: 'ignore',
        detached: true,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = readFileSync(join(sandbox.root, 'state.json'), 'utf8');
    const contended = manager(sandbox, ['update', '--install-dir', sandbox.root]);
    expect(contended.status).toBe(1);
    expect(contended.stderr).toContain('already running');
    expect(readFileSync(join(sandbox.root, 'state.json'), 'utf8')).toBe(before);
    holder.kill('SIGKILL');
    await server.close();
  });

  it('updates to a new release, records the previous release, and takes a verified backup', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status, 'install').toBe(0);
    const previousSha = readState(sandbox)['sha'] as string;
    const nextSha = commitNextRelease(sandbox.repo, {
      version: '0.1.1',
      tag: 'v0.1.1',
      manifestSha,
    });
    const result = manager(sandbox, [
      'update',
      '--install-dir',
      sandbox.root,
      '--version',
      'v0.1.1',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Updated to v0.1.1');
    expect(readFileSync(join(sandbox.dir, 'markers', 'backup-cwd'), 'utf8')).toBe(
      join(sandbox.root, 'releases', previousSha),
    );
    const state = readState(sandbox);
    expect(state['sha']).toBe(nextSha);
    const previous = state['previous'] as Record<string, unknown>;
    expect(previous['tag']).toBe('v0.1.0');
    expect(readlinkSync(join(sandbox.root, 'current'))).toContain(nextSha);
    const backups = readdirSync(join(sandbox.dataDir, 'backups'));
    expect(backups.some((name) => name.startsWith('installation-'))).toBe(true);
    expect(sandbox.calls()).toContain('db-backup.ts');
    expect(sandbox.calls()).toContain('migrate.ts');
    expect(unitFile(sandbox, 'ai-usage-dashboard-web.service')).toContain(nextSha);

    const noop = manager(sandbox, ['update', '--install-dir', sandbox.root]);
    expect(noop.status).toBe(0);
    expect(noop.stdout).toContain('already active');
    await server.close();
  });

  it('refuses a downgrade and a tag moved after resolution', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    expect(
      manager(sandbox, ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1']).status,
    ).toBe(0);
    const downgrade = manager(sandbox, [
      'update',
      '--install-dir',
      sandbox.root,
      '--version',
      'v0.1.0',
    ]);
    expect(downgrade.status).toBe(1);
    expect(downgrade.stderr).toContain('downgrade');
    await server.close();
  });

  it('recovers a failed candidate activation by restoring the previous release and database', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const active = readState(sandbox);
    expect(active['tag']).toBe('v0.1.0');
    const oldRelease = join(sandbox.root, 'releases', active['sha'] as string);
    const nextSha = commitNextRelease(sandbox.repo, {
      version: '0.1.1',
      tag: 'v0.1.1',
      manifestSha,
    });
    // The candidate's web never answers: stop the fixture server first.
    await server.close();
    await waitForHttpToStop(sandbox.port);
    const result = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1'],
      {
        AUD_INSTALL_HEALTH_TIMEOUT_SECONDS: '1',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not answer');
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(true);
    expect(readFileSync(join(sandbox.dir, 'markers', 'restored'), 'utf8')).toContain(
      'backups/installation-',
    );
    const recovered = readState(sandbox);
    expect(recovered['tag']).toBe('v0.1.0');
    expect(recovered['sha']).toBe(active['sha']);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    expect(unitFile(sandbox, 'ai-usage-dashboard-web.service')).toContain(oldRelease);
    // The failed candidate release is retained, and so is the pre-cutover backup.
    expect(existsSync(oldRelease)).toBe(true);
    expect(sandbox.calls()).toContain('db-restore.ts');
    expect(nextSha).not.toBe(active['sha']);
  });

  it('recovers when the candidate web unit fails to start', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const active = readState(sandbox);
    commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    const result = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1'],
      {
        AUD_TEST_FAIL_START: 'ai-usage-dashboard-web.service',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not become healthy');
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(true);
    const recovered = readState(sandbox);
    expect(recovered['tag']).toBe('v0.1.0');
    expect(recovered['sha']).toBe(active['sha']);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    await server.close();
  });

  it('recovers an interrupted update journal at the database boundary on the next invocation', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const active = readState(sandbox);
    const nextSha = commitNextRelease(sandbox.repo, {
      version: '0.1.1',
      tag: 'v0.1.1',
      manifestSha,
    });
    // Simulate a crash after the database-change boundary: journal present,
    // candidate staged, backup taken, state still previous.
    const backupPath = join(sandbox.dataDir, 'backups', 'installation-crash.db');
    mkdirSync(join(sandbox.dataDir, 'backups'), { recursive: true });
    copyFileSync(join(sandbox.dataDir, 'usage.db'), backupPath);
    const runtime = {
      nodeVersion: NODE_VERSION,
      path: join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`),
      sha256: 'a'.repeat(64),
    };
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    const snapshot = {
      unitFiles: Object.fromEntries(
        [
          'ai-usage-dashboard-collector.service',
          'ai-usage-dashboard-collector.timer',
          'ai-usage-dashboard-web.service',
        ].map((name) => [
          name,
          existsSync(join(unitDir, name)) ? readFileSync(join(unitDir, name), 'utf8') : null,
        ]),
      ),
      enabled: {
        'ai-usage-dashboard-collector.service': 'disabled',
        'ai-usage-dashboard-collector.timer': 'enabled',
        'ai-usage-dashboard-web.service': 'enabled',
      },
      active: {
        'ai-usage-dashboard-collector.service': 'inactive',
        'ai-usage-dashboard-collector.timer': 'active',
        'ai-usage-dashboard-web.service': 'active',
      },
      linger: 'no',
    };
    writeFile(
      join(sandbox.root, 'operation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          operationId: 'crashed-op',
          kind: 'update',
          phase: 'db-changing',
          pid: 999999,
          root: sandbox.root,
          candidate: { tag: 'v0.1.1', sha: nextSha, runtime },
          previous: { tag: 'v0.1.0', sha: active['sha'], runtime },
          backupPath,
          snapshot,
          dbOwnershipRecorded: false,
          failed: null,
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const result = manager(sandbox, [
      'update',
      '--install-dir',
      sandbox.root,
      '--version',
      'v0.1.1',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Recovering an interrupted update');
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(true);
    const state = readState(sandbox);
    expect(state['tag']).toBe('v0.1.1');
    expect((state['previous'] as Record<string, unknown>)['sha']).toBe(active['sha']);
    await server.close();
  });

  it('finalizes a committed journal instead of rolling it back', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const active = readState(sandbox);
    const runtime = {
      nodeVersion: NODE_VERSION,
      path: join(sandbox.root, 'runtime', `node-v${NODE_VERSION}`),
      sha256: 'a'.repeat(64),
    };
    writeFile(
      join(sandbox.root, 'operation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          operationId: 'committed-op',
          kind: 'update',
          phase: 'committed',
          pid: 999999,
          root: sandbox.root,
          candidate: { tag: 'v0.1.0', sha: active['sha'], runtime },
          previous: null,
          backupPath: null,
          snapshot: null,
          dbOwnershipRecorded: false,
          failed: null,
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const result = manager(sandbox, ['update', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Finalized');
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(false);
    await server.close();
  });

  it('keeps only active/previous releases after repeated updates and never prunes a referenced one', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const v011 = commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    expect(
      manager(sandbox, ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1']).status,
    ).toBe(0);
    const v012 = commitNextRelease(sandbox.repo, { version: '0.1.2', tag: 'v0.1.2', manifestSha });
    expect(
      manager(sandbox, ['update', '--install-dir', sandbox.root, '--version', 'v0.1.2']).status,
    ).toBe(0);
    const releases = readdirSync(join(sandbox.root, 'releases'));
    expect(releases).toHaveLength(2);
    expect(releases).toContain(v011);
    expect(releases).toContain(v012);
    await server.close();
  });

  it('leaves Claude settings unchanged until explicit apply, then follows update and uninstall', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    const settingsPath = join(sandbox.home, '.claude', 'settings.json');
    const original = {
      statusLine: { type: 'command', command: 'my-status --fancy', padding: 2, customField: true },
      other: { keep: true },
    };
    writeFile(settingsPath, JSON.stringify(original, null, 2));
    sandbox.fixture({ settingsPath });
    expect(installV010(sandbox).status).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(original);

    const apply = manager(sandbox, ['claude-statusline', '--install-dir', sandbox.root, '--apply']);
    expect(apply.status, apply.stderr).toBe(0);
    const stateAfterApply = readState(sandbox);
    const bridge = stateAfterApply['bridge'] as Record<string, unknown>;
    expect(bridge['releasePath']).toContain(`/releases/${stateAfterApply['sha'] as string}`);
    const command = (
      JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        statusLine: { command: string; padding: number; customField: boolean };
      }
    ).statusLine;
    expect(command.command).toContain('claude-statusline-bridge.mjs');
    expect(command.padding).toBe(2);
    expect(command.customField).toBe(true);

    const nextSha = commitNextRelease(sandbox.repo, {
      version: '0.1.1',
      tag: 'v0.1.1',
      manifestSha,
    });
    expect(
      manager(sandbox, ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1']).status,
    ).toBe(0);
    const refreshed = (
      JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } }
    ).statusLine;
    expect(refreshed.command).toContain(nextSha);

    // Externally replaced bridge is left untouched on the next update.
    writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: 'replaced-by-user' } }, null, 2),
    );
    commitNextRelease(sandbox.repo, { version: '0.1.2', tag: 'v0.1.2', manifestSha });
    expect(
      manager(sandbox, ['update', '--install-dir', sandbox.root, '--version', 'v0.1.2']).status,
    ).toBe(0);
    expect(
      (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } })
        .statusLine.command,
    ).toBe('replaced-by-user');
    expect(readState(sandbox)['bridge']).not.toBeNull();
    const afterExternal = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(afterExternal.stdout).toContain('externally managed or removed');
    await server.close();
  });

  it('uninstalls only owned execution surfaces, preserves data, and repeats safely through the bootstrap', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    writeFile(join(sandbox.dataDir, 'credential-sentinel'), 'keep');
    const ownershipBefore = readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8');
    const lingerBefore = existsSync(join(sandbox.systemd, 'linger'));

    const result = manager(sandbox, ['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('managed installation removed');
    expect(readFileSync(join(sandbox.dataDir, 'credential-sentinel'), 'utf8')).toBe('keep');
    expect(readFileSync(join(sandbox.dataDir, 'usage.db'), 'utf8')).toBe('fixture-db');
    expect(existsSync(join(sandbox.root, 'state.json'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'launcher'))).toBe(false);
    expect(existsSync(join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard'))).toBe(false);
    expect(unitFile(sandbox, 'ai-usage-dashboard-web.service')).toBeNull();
    expect(readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8')).toBe(ownershipBefore);
    expect(existsSync(join(sandbox.root, 'lifecycle.lock'))).toBe(true);
    expect(existsSync(join(sandbox.systemd, 'linger'))).toBe(lingerBefore);

    // Repeated uninstall via the bootstrap recovery entry point is a clean no-op.
    const again = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('application data was left untouched');

    // Foreign units are never removed by the bootstrap fallback.
    const foreign = join(
      sandbox.home,
      '.config',
      'systemd',
      'user',
      'ai-usage-dashboard-collector.service',
    );
    writeFile(foreign, '[Service]\nWorkingDirectory=/manual/checkout\n');
    const bootstrapAgain = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(bootstrapAgain.status).toBe(0);
    expect(existsSync(foreign)).toBe(true);
    await server.close();
  });

  it('reinstalls from the same root and configuration, reusing the retained database after a verified backup', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const firstState = readState(sandbox);
    expect(manager(sandbox, ['uninstall', '--install-dir', sandbox.root]).status).toBe(0);
    sandbox.fixture({});
    const reinstall = installV010(sandbox);
    expect(reinstall.status, reinstall.stderr).toBe(0);
    expect(sandbox.calls()).toContain('db-backup.ts');
    const backups = readdirSync(join(sandbox.dataDir, 'backups'));
    expect(backups.some((name) => name.startsWith('installation-'))).toBe(true);
    const secondState = readState(sandbox);
    expect(secondState['installationId']).not.toBe(firstState['installationId']);
    const ownership = JSON.parse(
      readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8'),
    ) as {
      entries: unknown[];
    };
    expect(ownership.entries).toHaveLength(1);
    await server.close();
  });

  it('performs status without database, provider, or migration activity and reports units distinctly', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const callsBefore = sandbox.calls().length;
    rmSync(join(sandbox.systemd, 'active', 'ai-usage-dashboard-web.service'), { force: true });
    const degraded = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(degraded.status).toBe(1);
    expect(degraded.stdout).toContain('web       : inactive');
    expect(sandbox.calls().length).toBe(callsBefore);
    // A timer that is enabled but stopped leaves the installation unhealthy.
    markUnitActive(sandbox, 'ai-usage-dashboard-web.service', true);
    markUnitActive(sandbox, 'ai-usage-dashboard-collector.timer', false);
    const timerDown = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(timerDown.status).toBe(1);
    expect(timerDown.stdout).toContain('timer     : inactive');
    // Corrupt state is an invalid-state result, not a generic failure.
    writeFile(join(sandbox.root, 'state.json'), '{');
    const corrupt = manager(sandbox, ['status', '--install-dir', sandbox.root]);
    expect(corrupt.status).toBe(2);
    expect(corrupt.stderr).toContain('not valid JSON');
    await server.close();
  });

  it('dry runs uninstall without side effects', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const stateBefore = readFileSync(join(sandbox.root, 'state.json'), 'utf8');
    const result = manager(sandbox, ['uninstall', '--install-dir', sandbox.root, '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(readFileSync(join(sandbox.root, 'state.json'), 'utf8')).toBe(stateBefore);
    expect(existsSync(join(sandbox.systemd, 'active', 'ai-usage-dashboard-web.service'))).toBe(
      true,
    );
    expect(unitFile(sandbox, 'ai-usage-dashboard-web.service')).not.toBeNull();
    await server.close();
  });

  it('reports a requested linger failure as a clear nonzero result without sudo', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    const result = installV010(sandbox, {
      AUD_TEST_LINGER_FAIL: '1',
      AUD_INSTALL_ENABLE_LINGER: '1',
    });
    expect(result.status).toBe(0);
    const linger = manager(sandbox, ['uninstall', '--install-dir', sandbox.root, '--dry-run'], {
      AUD_TEST_LINGER_FAIL: '1',
    });
    expect(linger.status).toBe(0);
    await server.close();
  });

  it('takes the lifecycle lock before provisioning or changing the root', async () => {
    const sandbox = freshSandbox();
    mkdirSync(sandbox.root, { recursive: true });
    chmodSync(sandbox.root, 0o755);
    const holder = spawn(
      'flock',
      ['--nonblock', join(sandbox.root, 'lifecycle.lock'), 'sleep', '5'],
      { stdio: 'ignore', detached: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await sandbox.runBootstrap(['--install-dir', sandbox.root]);
    holder.kill('SIGKILL');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already running');
    expect(statSync(sandbox.root).mode & 0o777).toBe(0o755);
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
  });

  it('refuses to overwrite a unit replaced by a manual installation', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    const webUnit = join(sandbox.home, '.config', 'systemd', 'user', WEB);
    writeFile(webUnit, '[Service]\nWorkingDirectory=/manual/checkout\n');
    const result = manager(sandbox, [
      'update',
      '--install-dir',
      sandbox.root,
      '--version',
      'v0.1.1',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not owned');
    expect(readFileSync(webUnit, 'utf8')).toContain('/manual/checkout');
    expect(readState(sandbox)['tag']).toBe('v0.1.0');
    await server.close();
  });

  it('refuses to uninstall when the data directory or database symlinks inside the root', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const active = readState(sandbox);
    const victim = join(sandbox.root, 'releases', active['sha'] as string, 'victim-data');
    mkdirSync(victim, { recursive: true });
    writeFile(join(victim, 'usage.db'), 'fixture-db');
    // The recorded data directory now names an outside path that resolves
    // inside the release the uninstall would delete.
    rmSync(sandbox.dataDir, { recursive: true, force: true });
    symlinkSync(victim, sandbox.dataDir);
    const result = manager(sandbox, ['uninstall', '--install-dir', sandbox.root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('physically resolves inside the install root');
    expect(existsSync(join(victim, 'usage.db'))).toBe(true);
    expect(existsSync(join(sandbox.root, 'state.json'))).toBe(true);
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(true);
    await server.close();
  });

  it('leaves another root launcher and units alone in the bootstrap fallback', async () => {
    const sandbox = freshSandbox();
    const otherRoot = join(sandbox.home, 'other-install');
    const otherRelease = join(otherRoot, 'releases', 'b'.repeat(40));
    mkdirSync(otherRelease, { recursive: true });
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    writeFile(join(unitDir, COLLECTOR), `[Service]\nWorkingDirectory=${otherRelease}\n`);
    writeFile(join(unitDir, TIMER), '[Timer]\nUnit=ai-usage-dashboard-collector.service\n');
    writeFile(join(unitDir, WEB), `[Service]\nWorkingDirectory=${otherRelease}\n`);
    const launcher = join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard');
    writeFile(
      launcher,
      `#!/usr/bin/env bash\n# managed by the ai-usage-dashboard installer\nAUD_INSTALL_ROOT='${otherRoot}'\n`,
      0o755,
    );
    const missingRoot = join(sandbox.home, 'missing-install');
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', missingRoot]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(missingRoot)).toBe(false);
    expect(existsSync(launcher)).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain(`AUD_INSTALL_ROOT='${otherRoot}'`);
    expect(unitFile(sandbox, COLLECTOR)).not.toBeNull();
    expect(unitFile(sandbox, TIMER)).not.toBeNull();
    expect(unitFile(sandbox, WEB)).not.toBeNull();
  });

  it.each(['units', 'launcher', 'both'])(
    'cleans owned %s remnants when the bootstrap root is absent without creating it',
    async (kind) => {
      const sandbox = freshSandbox();
      const ownsUnits = kind !== 'launcher';
      const ownsLauncher = kind !== 'units';
      const otherRoot = join(sandbox.home, 'other-install');
      const unitRoot = ownsUnits ? sandbox.root : otherRoot;
      const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
      writeFile(
        join(unitDir, COLLECTOR),
        `[Service]\nWorkingDirectory=${unitRoot}/releases/missing\n`,
      );
      writeFile(join(unitDir, TIMER), '[Timer]\nUnit=ai-usage-dashboard-collector.service\n');
      writeFile(join(unitDir, WEB), `[Service]\nWorkingDirectory=${unitRoot}/releases/missing\n`);
      const launcher = join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard');
      const launcherRoot = ownsLauncher ? sandbox.root : otherRoot;
      writeFile(
        launcher,
        `#!/usr/bin/env bash\n# managed by the ai-usage-dashboard installer\nAUD_INSTALL_ROOT='${launcherRoot}'\n`,
        0o755,
      );
      const before = [COLLECTOR, TIMER, WEB].map((unit) => unitFile(sandbox, unit));
      const launcherBefore = readFileSync(launcher, 'utf8');
      for (const unit of [COLLECTOR, TIMER, WEB]) {
        markUnitActive(sandbox, unit, true);
        writeFile(join(sandbox.systemd, 'enabled', unit), 'enabled');
      }
      const database = join(sandbox.dataDir, 'usage.db');
      writeFile(database, 'keep database');
      expect(existsSync(sandbox.root)).toBe(false);
      const preview = await sandbox.runBootstrap([
        'uninstall',
        '--install-dir',
        sandbox.root,
        '--dry-run',
      ]);
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout).toContain('DRY RUN');
      if (ownsUnits) {
        for (const unit of [COLLECTOR, TIMER, WEB]) {
          expect(preview.stdout).toContain(`unit     : ${unit}`);
        }
      } else {
        expect(preview.stdout).not.toContain('unit     :');
      }
      if (ownsLauncher) {
        expect(preview.stdout).toContain('launcher :');
      } else {
        expect(preview.stdout).not.toContain('launcher :');
      }
      expect(preview.stdout).toContain('root     : absent; it would not be created');
      expect([COLLECTOR, TIMER, WEB].map((unit) => unitFile(sandbox, unit))).toEqual(before);
      expect(readFileSync(launcher, 'utf8')).toBe(launcherBefore);
      expect(existsSync(sandbox.root)).toBe(false);

      const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
      expect(result.status, result.stderr).toBe(0);
      for (const [index, unit] of [COLLECTOR, TIMER, WEB].entries()) {
        expect(unitFile(sandbox, unit)).toBe(ownsUnits ? null : before[index]);
        expect(existsSync(join(sandbox.systemd, 'active', unit))).toBe(!ownsUnits);
        expect(existsSync(join(sandbox.systemd, 'enabled', unit))).toBe(!ownsUnits);
      }
      expect(existsSync(launcher)).toBe(!ownsLauncher);
      if (!ownsLauncher) expect(readFileSync(launcher, 'utf8')).toBe(launcherBefore);
      expect(existsSync(sandbox.root)).toBe(false);
      expect(readFileSync(database, 'utf8')).toBe('keep database');
      const again = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
      expect(again.status, again.stderr).toBe(0);
      expect(existsSync(sandbox.root)).toBe(false);
    },
  );

  it('leaves a root that appears during external-remnant cleanup untouched', async () => {
    const sandbox = freshSandbox();
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    writeFile(join(unitDir, WEB), `[Service]\nWorkingDirectory=${sandbox.root}/releases/missing\n`);
    writeFile(
      join(sandbox.bin, 'systemctl'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "--user stop ${WEB}" ]]; then
  mkdir -p '${sandbox.root}/releases' '${sandbox.root}/runtime' '${sandbox.root}/cache'
  for tree in releases runtime cache; do
    printf 'new operation' > '${sandbox.root}/'"$tree"'/MARKER'
  done
  printf 'new journal' > '${sandbox.root}/operation.json'
fi
exit 0
`,
      0o755,
    );
    expect(existsSync(sandbox.root)).toBe(false);
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(unitFile(sandbox, WEB)).toBeNull();
    for (const tree of ['releases', 'runtime', 'cache']) {
      expect(readFileSync(join(sandbox.root, tree, 'MARKER'), 'utf8')).toBe('new operation');
    }
    expect(readFileSync(join(sandbox.root, 'operation.json'), 'utf8')).toBe('new journal');
    expect(existsSync(join(sandbox.root, 'lifecycle.lock'))).toBe(false);
  });

  it('removes this root collector timer in the bootstrap fallback', async () => {
    const sandbox = freshSandbox();
    const release = join(sandbox.root, 'releases', 'c'.repeat(40));
    mkdirSync(release, { recursive: true });
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    writeFile(join(unitDir, COLLECTOR), `[Service]\nWorkingDirectory=${release}\n`);
    writeFile(join(unitDir, TIMER), '[Timer]\nUnit=ai-usage-dashboard-collector.service\n');
    writeFile(join(unitDir, WEB), `[Service]\nWorkingDirectory=${release}\n`);
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(unitFile(sandbox, COLLECTOR)).toBeNull();
    expect(unitFile(sandbox, TIMER)).toBeNull();
    expect(unitFile(sandbox, WEB)).toBeNull();
  });

  it('removes launcher-only remnants in the bootstrap fallback', async () => {
    const sandbox = freshSandbox();
    for (const tree of ['releases', 'runtime', 'cache']) {
      writeFile(join(sandbox.root, tree, 'MARKER'), 'owned');
    }
    const launcher = join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard');
    writeFile(
      launcher,
      `#!/usr/bin/env bash\n# managed by the ai-usage-dashboard installer\nAUD_INSTALL_ROOT='${sandbox.root}'\n`,
      0o755,
    );
    // No metadata or units exist; the launcher's exact root is the only proof.
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(launcher)).toBe(false);
    for (const tree of ['releases', 'runtime', 'cache']) {
      expect(existsSync(join(sandbox.root, tree))).toBe(false);
    }
    expect(existsSync(join(sandbox.root, 'lifecycle.lock'))).toBe(true);
    expect(existsSync(sandbox.dataDir)).toBe(true);
  });

  it('refuses bootstrap fallback uninstall while another operation holds the lifecycle lock', async () => {
    const sandbox = freshSandbox();
    const release = join(sandbox.root, 'releases', 'd'.repeat(40));
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    const launcher = join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard');
    const preserved = [
      join(release, 'MARKER'),
      join(sandbox.root, 'runtime', 'MARKER'),
      join(sandbox.root, 'cache', 'MARKER'),
      join(sandbox.root, 'operation.json'),
      join(sandbox.root, 'data-ownership.json'),
      join(sandbox.dataDir, 'usage.db'),
      join(unitDir, COLLECTOR),
      join(unitDir, TIMER),
      join(unitDir, WEB),
      launcher,
    ];
    for (const path of preserved) writeFile(path, 'keep');
    writeInstallJournal(sandbox, {
      phase: 'db-creating',
      candidateSha: 'd'.repeat(40),
      dbOwnershipRecorded: false,
    });
    writeFile(join(unitDir, COLLECTOR), `[Service]\nWorkingDirectory=${release}\n`);
    writeFile(join(unitDir, TIMER), '[Timer]\nUnit=ai-usage-dashboard-collector.service\n');
    writeFile(join(unitDir, WEB), `[Service]\nWorkingDirectory=${release}\n`);
    writeFile(
      launcher,
      `#!/usr/bin/env bash\n# managed by the ai-usage-dashboard installer\nAUD_INSTALL_ROOT='${sandbox.root}'\n`,
      0o755,
    );
    for (const unit of [COLLECTOR, TIMER, WEB]) markUnitActive(sandbox, unit, true);
    const before = preserved.map((path) => readFileSync(path, 'utf8'));
    // Signal readiness only after flock succeeds. --no-fork lets closing stdin
    // end the holder itself, so no orphan child keeps the lock after the test.
    const holder = spawn(
      'flock',
      [
        '--nonblock',
        '--no-fork',
        join(sandbox.root, 'lifecycle.lock'),
        process.execPath,
        '-e',
        'process.stdout.write("locked\\n"); process.stdin.resume();',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    try {
      await once(holder.stdout, 'data');
      const status = await sandbox.runBootstrap(['status', '--install-dir', sandbox.root]);
      expect(status.status).toBe(1);
      expect(status.stdout).toContain('No managed installation');
      const preview = await sandbox.runBootstrap([
        'uninstall',
        '--install-dir',
        sandbox.root,
        '--dry-run',
      ]);
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout).toContain('DRY RUN');
      expect(preview.stdout).toContain(`unit     : ${WEB}`);
      expect(preview.stdout).toContain('launcher :');
      expect(preview.stdout).toContain('path     :');
      expect(preserved.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('already running');
      expect(preserved.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      for (const unit of [COLLECTOR, TIMER, WEB]) {
        expect(existsSync(join(sandbox.systemd, 'active', unit))).toBe(true);
      }
    } finally {
      const exited = once(holder, 'exit');
      holder.stdin.end();
      await exited;
    }
    const retry = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(retry.status, retry.stderr).toBe(0);
    for (const tree of ['releases', 'runtime', 'cache', 'operation.json']) {
      expect(existsSync(join(sandbox.root, tree))).toBe(false);
    }
    expect(existsSync(launcher)).toBe(false);
    expect(readFileSync(join(sandbox.dataDir, 'usage.db'), 'utf8')).toBe('keep');
    expect(readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8')).toBe('keep');
  });

  it.each([
    { args: ['status'], status: 1 },
    { args: ['uninstall', '--dry-run'], status: 0 },
    { args: ['uninstall'], status: 0 },
  ])('keeps an absent bootstrap root absent for $args', async ({ args, status }) => {
    const sandbox = freshSandbox();
    const result = await sandbox.runBootstrap([...args, '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(status);
    if (args.includes('--dry-run')) {
      expect(result.stdout).toContain('nothing to remove');
    }
    expect(existsSync(sandbox.root)).toBe(false);
  });

  it.each(['empty', 'notes'])('leaves an unowned %s root unchanged on uninstall', async (kind) => {
    const sandbox = freshSandbox();
    mkdirSync(sandbox.root, { recursive: true });
    chmodSync(sandbox.root, 0o755);
    if (kind === 'notes') writeFile(join(sandbox.root, 'notes.txt'), 'leave me');
    const entries = readdirSync(sandbox.root);
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(sandbox.root)).toEqual(entries);
    expect(statSync(sandbox.root).mode & 0o777).toBe(0o755);
    if (kind === 'notes') {
      expect(readFileSync(join(sandbox.root, 'notes.txt'), 'utf8')).toBe('leave me');
    }
  });

  it('removes proven execution trees in the bootstrap fallback', async () => {
    const sandbox = freshSandbox();
    const release = join(sandbox.root, 'releases', 'd'.repeat(40));
    mkdirSync(release, { recursive: true });
    writeFile(join(sandbox.root, 'cache', 'marker'), 'cache');
    writeFile(
      join(sandbox.root, 'operation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          operationId: 'interrupted-uninstall',
          kind: 'uninstall',
          phase: 'launcher-removed',
          pid: 999999,
          root: sandbox.root,
          candidate: null,
          previous: null,
          backupPath: null,
          snapshot: null,
          databasePath: null,
          dbOwnershipRecorded: false,
          failed: null,
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    // No units and no launcher remain: only this root's own journal proves it.
    const preview = await sandbox.runBootstrap([
      'uninstall',
      '--install-dir',
      sandbox.root,
      '--dry-run',
    ]);
    expect(preview.status, preview.stderr).toBe(0);
    for (const path of ['releases', 'cache', 'operation.json']) {
      expect(preview.stdout).toContain(`path     : ${join(sandbox.root, path)}\n`);
    }
    // The runtime tree is already gone, so the preview does not name it.
    expect(preview.stdout).not.toContain(join(sandbox.root, 'runtime'));
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(true);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(true);
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'cache'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
  });

  it('previews a proven root with no execution trees left as nothing to remove', async () => {
    const sandbox = freshSandbox();
    writeFile(join(sandbox.root, 'data-ownership.json'), '{}');
    const preview = await sandbox.runBootstrap([
      'uninstall',
      '--install-dir',
      sandbox.root,
      '--dry-run',
    ]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('nothing to remove');
    expect(preview.stdout).not.toContain('path     :');
    expect(readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8')).toBe('{}');
  });

  it('leaves an unproven root tree alone in the bootstrap fallback', async () => {
    const sandbox = freshSandbox();
    const foreignRoot = join(sandbox.home, 'foreign-install');
    const foreignRelease = join(foreignRoot, 'releases', 'e'.repeat(40));
    mkdirSync(foreignRelease, { recursive: true });
    writeFile(join(foreignRelease, 'MARKER'), 'keep');
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', foreignRoot]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(foreignRelease, 'MARKER'), 'utf8')).toBe('keep');
    expect(existsSync(join(foreignRoot, 'lifecycle.lock'))).toBe(false);
  });

  it('install --dry-run neither creates the root nor recovers', () => {
    const sandbox = freshSandbox();
    const result = manager(sandbox, ['install', '--install-dir', sandbox.root, '--dry-run'], {
      AUD_INSTALL_MANAGER_API: '1',
      AUD_INSTALL_REPO_URL: join(sandbox.dir, 'absent-repo'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('would resolve the highest stable release');
    expect(existsSync(sandbox.root)).toBe(false);
  });

  it('update --dry-run neither recovers nor resolves over the network', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const backupPath = join(sandbox.dataDir, 'backups', 'dry-run-backup.db');
    mkdirSync(join(sandbox.dataDir, 'backups'), { recursive: true });
    copyFileSync(join(sandbox.dataDir, 'usage.db'), backupPath);
    writeUpdateJournal(sandbox, {
      phase: 'writers-stopped',
      candidateSha: 'e'.repeat(40),
      backupPath,
    });
    const databaseBefore = readFileSync(join(sandbox.dataDir, 'usage.db'), 'utf8');
    const result = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--dry-run', '--version', 'v9.9.9'],
      { AUD_INSTALL_REPO_URL: join(sandbox.dir, 'absent-repo') },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('would resolve --version v9.9.9');
    expect(result.stdout).toContain('does not recover');
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(true);
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(false);
    expect(readFileSync(join(sandbox.dataDir, 'usage.db'), 'utf8')).toBe(databaseBefore);
    await server.close();
  });

  it('restores the stored configuration database during recovery, not the caller environment', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    const candidateSha = tagSha(sandbox.repo, 'v0.1.1');
    const backupPath = join(sandbox.dataDir, 'backups', 'installation-crash.db');
    mkdirSync(join(sandbox.dataDir, 'backups'), { recursive: true });
    copyFileSync(join(sandbox.dataDir, 'usage.db'), backupPath);
    writeUpdateJournal(sandbox, {
      phase: 'db-changing',
      candidateSha,
      backupPath,
      snapshot: unitSnapshot(sandbox),
    });
    const callerData = join(sandbox.dir, 'caller-data');
    mkdirSync(callerData, { recursive: true });
    writeFile(join(callerData, 'usage.db'), 'caller-db');
    const result = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1'],
      { AUD_DATA_DIR: callerData },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(sandbox.dir, 'markers', 'restore-data-dir'), 'utf8')).toBe(
      sandbox.dataDir,
    );
    expect(readFileSync(join(callerData, 'usage.db'), 'utf8')).toBe('caller-db');
    await server.close();
  });

  it('refuses an update when the resolved tag was moved after installation', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const before = readState(sandbox);
    const moved = commitNextRelease(sandbox.repo, {
      version: '0.1.0',
      tag: 'v0.2.0',
      manifestSha,
    });
    git(['tag', '-f', 'v0.1.0', moved], sandbox.repo);
    const result = manager(sandbox, [
      'update',
      '--install-dir',
      sandbox.root,
      '--version',
      'v0.1.0',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('moved');
    const after = readState(sandbox);
    expect(after['sha']).toBe(before['sha']);
    await server.close();
  });

  it('restores service state when an update is interrupted while stopping the writers', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const snapshot = unitSnapshot(sandbox);
    // SIGKILL inside stopWriters: services are down, the journal still says
    // staged, and the release plus database are untouched.
    markUnitActive(sandbox, WEB, false);
    markUnitActive(sandbox, TIMER, false);
    writeUpdateJournal(sandbox, {
      phase: 'staged',
      candidateSha: 'd'.repeat(40),
      snapshot,
    });
    const result = manager(sandbox, ['update', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('interrupted while stopping the writers');
    expect(existsSync(join(sandbox.systemd, 'active', WEB))).toBe(true);
    expect(existsSync(join(sandbox.systemd, 'active', TIMER))).toBe(true);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    expect(existsSync(join(sandbox.dir, 'markers', 'restored'))).toBe(false);
    await server.close();
  });

  it('restores the Claude status line when recovery rolls back a refreshed bridge', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    const settingsPath = join(sandbox.home, '.claude', 'settings.json');
    writeFile(
      settingsPath,
      JSON.stringify(
        { statusLine: { type: 'command', command: 'my-status --fancy', padding: 2 } },
        null,
        2,
      ),
    );
    sandbox.fixture({ settingsPath });
    expect(installV010(sandbox).status).toBe(0);
    expect(
      manager(sandbox, ['claude-statusline', '--install-dir', sandbox.root, '--apply']).status,
    ).toBe(0);
    const active = readState(sandbox);
    const activeRelease = join(sandbox.root, 'releases', active['sha'] as string);

    // The crashed update had already repointed the status line at the
    // candidate release before the commit.
    const candidateSha = 'f'.repeat(40);
    const candidateRelease = join(sandbox.root, 'releases', candidateSha);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      statusLine: { command: string };
    };
    settings.statusLine.command = `AUD_SPOOL_PATH='x' '${process.execPath}' '${join(candidateRelease, 'scripts/claude-statusline-bridge.mjs')}'`;
    writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const backupPath = join(sandbox.dataDir, 'backups', 'bridge-crash.db');
    mkdirSync(join(sandbox.dataDir, 'backups'), { recursive: true });
    copyFileSync(join(sandbox.dataDir, 'usage.db'), backupPath);
    writeUpdateJournal(sandbox, {
      phase: 'bridge-refreshed',
      candidateSha,
      backupPath,
      snapshot: unitSnapshot(sandbox),
    });

    // The caller's CLAUDE_CONFIG_DIR must not redirect the restoration.
    const elsewhere = join(sandbox.dir, 'claude-elsewhere');
    const result = manager(sandbox, ['update', '--install-dir', sandbox.root], {
      CLAUDE_CONFIG_DIR: elsewhere,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Restored the Claude status line');
    const restored = (
      JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } }
    ).statusLine.command;
    expect(restored).toContain(activeRelease);
    expect(restored).not.toContain(candidateRelease);
    expect(existsSync(join(elsewhere, 'settings.json'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    await server.close();
  });

  it('leaves an unowned root untouched instead of provisioning into it', async () => {
    const sandbox = freshSandbox();
    mkdirSync(sandbox.root, { recursive: true });
    chmodSync(sandbox.root, 0o755);
    writeFile(join(sandbox.root, 'unrelated.txt'), 'leave me');
    const result = await sandbox.runBootstrap(['--install-dir', sandbox.root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unrelated entries');
    expect(statSync(sandbox.root).mode & 0o777).toBe(0o755);
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'cache'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'lifecycle.lock'))).toBe(false);
  });

  it('prints a bootstrap dry run without fetching or creating the root', async () => {
    const sandbox = freshSandbox();
    const result = await sandbox.runBootstrap(['--dry-run', '--install-dir', sandbox.root], {
      AUD_INSTALL_REPO_URL: join(sandbox.dir, 'absent-repo'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('requires network access');
    expect(existsSync(sandbox.root)).toBe(false);
  });

  it('ignores commented directives when the bootstrap fallback decides unit ownership', async () => {
    const sandbox = freshSandbox();
    // A retained lock identifies this root as a managed remnant, so fallback
    // still inspects unit ownership even though the active directive is foreign.
    writeFile(join(sandbox.root, 'lifecycle.lock'), '');
    const unitDir = join(sandbox.home, '.config', 'systemd', 'user');
    writeFile(
      join(unitDir, WEB),
      `[Service]\n# Previous WorkingDirectory=${sandbox.root}/releases/${'a'.repeat(40)}\nWorkingDirectory=/manual/checkout\n`,
    );
    const result = await sandbox.runBootstrap(['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('foreign unit');
    expect(unitFile(sandbox, WEB)).not.toBeNull();
  });

  it('keeps the bridge at the recorded settings path regardless of the caller environment', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    const dirA = join(sandbox.dir, 'claude-a');
    const dirB = join(sandbox.dir, 'claude-b');
    expect(installV010(sandbox).status).toBe(0);
    const apply = manager(
      sandbox,
      ['claude-statusline', '--install-dir', sandbox.root, '--apply'],
      { CLAUDE_CONFIG_DIR: dirA },
    );
    expect(apply.status, apply.stderr).toBe(0);
    const settingsA = join(dirA, 'settings.json');
    expect((readState(sandbox)['bridge'] as Record<string, unknown>)['settingsPath']).toBe(
      settingsA,
    );

    const nextSha = commitNextRelease(sandbox.repo, {
      version: '0.1.1',
      tag: 'v0.1.1',
      manifestSha,
    });
    const update = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1'],
      { CLAUDE_CONFIG_DIR: dirB },
    );
    expect(update.status, update.stderr).toBe(0);
    const commandA = (
      JSON.parse(readFileSync(settingsA, 'utf8')) as { statusLine: { command: string } }
    ).statusLine.command;
    expect(commandA).toContain(nextSha);
    expect(existsSync(join(dirB, 'settings.json'))).toBe(false);
    expect((readState(sandbox)['bridge'] as Record<string, unknown>)['settingsPath']).toBe(
      settingsA,
    );

    const uninstall = manager(sandbox, ['uninstall', '--install-dir', sandbox.root], {
      CLAUDE_CONFIG_DIR: dirB,
    });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    const after = JSON.parse(readFileSync(settingsA, 'utf8')) as { statusLine?: unknown };
    expect(after.statusLine).toBeUndefined();
    expect(existsSync(join(dirB, 'settings.json'))).toBe(false);
    await server.close();
  });

  it('resumes an interrupted first install and records the database it was creating', async () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    const sha = tagSha(sandbox.repo, 'v0.1.0');
    writeFile(join(sandbox.dataDir, 'usage.db'), 'partial-db');
    writeInstallJournal(sandbox, { phase: 'db-creating', candidateSha: sha });
    const server = await startDashboard(sandbox);
    const result = manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', sha),
    );
    expect(result.status, result.stderr).toBe(0);
    const state = readState(sandbox);
    expect(state['tag']).toBe('v0.1.0');
    const ownership = JSON.parse(
      readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(ownership.entries).toHaveLength(1);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    // The remnant is adopted, not backed up as if it were somebody else's.
    expect(sandbox.calls()).not.toContain('db-backup.ts');
    await server.close();
  });

  it('refuses to adopt a database the interrupted install was not creating', () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    const sha = tagSha(sandbox.repo, 'v0.1.0');
    const otherData = join(sandbox.dir, 'other-data');
    mkdirSync(otherData, { recursive: true, mode: 0o700 });
    writeFile(join(otherData, 'usage.db'), 'someone-elses-db');
    // The retry resolves a different data directory than the journal recorded.
    sandbox.fixture({
      config: {
        envFile: join(sandbox.home, '.config', 'ai-usage-dashboard', 'collector.env'),
        dataDir: otherData,
        databasePath: join(otherData, 'usage.db'),
        host: '127.0.0.1',
        port: sandbox.port,
        intervalMinutes: 5,
      },
    });
    writeInstallJournal(sandbox, { phase: 'db-creating', candidateSha: sha });
    const result = manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', sha),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ownership record does not name it');
    expect(readFileSync(join(otherData, 'usage.db'), 'utf8')).toBe('someone-elses-db');
    expect(existsSync(join(sandbox.root, 'data-ownership.json'))).toBe(false);
    expect(sandbox.calls()).not.toContain('migrate.ts');
    expect(sandbox.calls()).not.toContain('db-backup.ts');
  });

  it('keeps the holder check for an adopted database', () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    const sha = tagSha(sandbox.repo, 'v0.1.0');
    writeFile(join(sandbox.dataDir, 'usage.db'), 'partial-db');
    writeInstallJournal(sandbox, { phase: 'db-creating', candidateSha: sha });
    sandbox.fixture({ holders: [4321] });
    const result = manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', sha),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('open in process(es) 4321');
    expect(sandbox.calls()).not.toContain('migrate.ts');
    expect(existsSync(join(sandbox.root, 'data-ownership.json'))).toBe(false);
  });

  it('keeps the integrity check for an adopted database', () => {
    const sandbox = freshSandbox();
    placeRuntime(sandbox.root);
    const sha = tagSha(sandbox.repo, 'v0.1.0');
    writeFile(join(sandbox.dataDir, 'usage.db'), 'partial-db');
    writeInstallJournal(sandbox, { phase: 'db-creating', candidateSha: sha });
    sandbox.fixture({ integrity: 'corrupt' });
    const result = manager(
      sandbox,
      ['install', '--install-dir', sandbox.root],
      installEnv(sandbox, 'v0.1.0', sha),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed its integrity check');
    expect(sandbox.calls()).not.toContain('migrate.ts');
  });

  it('re-runs the bootstrap when only a stale atomic temp file sits in a managed root', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    writeFile(join(sandbox.root, '.4242.1700000000000.tmp'), 'stale');
    const rerun = await sandbox.runBootstrap(['--install-dir', sandbox.root]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stderr).not.toContain('unrelated entries');
    expect(readState(sandbox)['tag']).toBe('v0.1.0');
    await server.close();
  });

  it('restores the service snapshot when stopping a writer fails mid-update', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    commitNextRelease(sandbox.repo, { version: '0.1.1', tag: 'v0.1.1', manifestSha });
    const result = manager(
      sandbox,
      ['update', '--install-dir', sandbox.root, '--version', 'v0.1.1'],
      { AUD_TEST_FAIL_STOP: 'ai-usage-dashboard-web.service' },
    );
    expect(result.status).toBe(1);
    expect(existsSync(join(sandbox.systemd, 'active', WEB))).toBe(true);
    expect(existsSync(join(sandbox.systemd, 'active', TIMER))).toBe(true);
    expect(readState(sandbox)['tag']).toBe('v0.1.0');
    await server.close();
  });

  it('resumes an interrupted uninstall after state.json is already gone', async () => {
    const sandbox = freshSandbox();
    const server = await startDashboard(sandbox);
    expect(installV010(sandbox).status).toBe(0);
    const ownershipBefore = readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8');
    // Simulate a kill after state.json and the launcher were removed but
    // before the heavy releases/runtime trees: the remnant path must finish.
    rmSync(join(sandbox.root, 'state.json'), { force: true });
    rmSync(join(sandbox.home, '.local', 'bin', 'ai-usage-dashboard'), { force: true });
    writeFile(
      join(sandbox.root, 'operation.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          operationId: 'interrupted-uninstall',
          kind: 'uninstall',
          phase: 'launcher-removed',
          pid: 999999,
          root: sandbox.root,
          candidate: null,
          previous: null,
          backupPath: null,
          snapshot: null,
          dbOwnershipRecorded: false,
          failed: null,
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    const result = manager(sandbox, ['uninstall', '--install-dir', sandbox.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Resuming an interrupted uninstall');
    expect(existsSync(join(sandbox.root, 'releases'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'runtime'))).toBe(false);
    expect(existsSync(join(sandbox.root, 'operation.json'))).toBe(false);
    expect(readFileSync(join(sandbox.root, 'data-ownership.json'), 'utf8')).toBe(ownershipBefore);
    expect(readFileSync(join(sandbox.dataDir, 'usage.db'), 'utf8')).toBe('fixture-db');
    await server.close();
  });
});

function installV010WithFixture(sandbox: Sandbox, patch: Record<string, unknown>) {
  placeRuntime(sandbox.root);
  sandbox.fixture(patch);
  return manager(
    sandbox,
    ['install', '--install-dir', sandbox.root],
    installEnv(sandbox, 'v0.1.0', tagSha(sandbox.repo, 'v0.1.0')),
  );
}

afterAll(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});
