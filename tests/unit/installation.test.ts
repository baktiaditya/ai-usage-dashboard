/**
 * Unit coverage for the managed-installation foundation: release selection,
 * manifest validation, strict state/journal/ownership parsing, path safety,
 * retention, unit ownership, and launcher/bridge helpers.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareTagStrings,
  parseStableTag,
  pickHighestStableTag,
} from '../../src/lib/installation/semver';
import {
  ManifestError,
  parseRuntimeManifest,
  validateManifestForEngine,
} from '../../src/lib/installation/manifest';
import {
  OWNERSHIP_SCHEMA_VERSION,
  readJournal,
  readOwnership,
  readState,
  validateJournal,
  validateOwnership,
  validateState,
  writeJournal,
  writeOwnership,
  writeState,
} from '../../src/lib/installation/state';
import type {
  InstallationState,
  OperationJournal,
  OwnershipRecord,
} from '../../src/lib/installation/state';
import {
  assertSafePathValue,
  classifyRoot,
  defaultInstallRoot,
  isInside,
  isPhysicallyInside,
  normaliseAbsolute,
  physicalPath,
} from '../../src/lib/installation/install-paths';
import { planRetention } from '../../src/lib/installation/retention';
import { renderUnit, systemdValue } from '../../src/lib/systemd-unit';
import {
  COLLECTOR_SERVICE,
  COLLECTOR_TIMER,
  ownedUnits,
  unitOwnedByRoot,
  unitWorkingDirectory,
} from '../../src/lib/installation/systemd';
import {
  launcherContent,
  launcherIsOurs,
  bridgeMatchesRecorded,
} from '../../src/lib/installation/manager';
import {
  buildEnv,
  captureCodex,
  httpUrl,
  serviceEnv,
} from '../../src/lib/installation/manager-support';
import { writeFileAtomic, writeSymlinkAtomic } from '../../src/lib/installation/atomic';

const repoRoot = join(import.meta.dirname, '..', '..');
const cleanups: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aud-install-unit-'));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

describe('semver release selection', () => {
  it('parses only stable vX.Y.Z tags', () => {
    expect(parseStableTag('v1.2.3')).toEqual({ tag: 'v1.2.3', major: 1, minor: 2, patch: 3 });
    for (const bad of [
      '1.2.3',
      'v1.2',
      'v1.2.3-rc.1',
      'v01.2.3',
      'release-v1.2.3',
      'v1.2.3+build',
    ]) {
      expect(parseStableTag(bad), bad).toBeNull();
    }
  });

  it('compares numerically, not lexically', () => {
    expect(pickHighestStableTag(['v0.9.0', 'v0.10.0', 'v0.2.9'])).toBe('v0.10.0');
    expect(pickHighestStableTag(['v1.0.0-rc.1', 'garbage'])).toBeNull();
    const high = parseStableTag('v2.0.0');
    const low = parseStableTag('v1.99.99');
    expect(compareTagStrings('v2.0.0', 'v1.99.99')).toBeGreaterThan(0);
    expect(high && low && high.major > low.major).toBe(true);
  });
});

describe('runtime manifest', () => {
  it('parses the shipped manifest and validates it against the repository', () => {
    const text = readFileSync(join(repoRoot, 'scripts/install-runtime.env'), 'utf8');
    const manifest = parseRuntimeManifest(text);
    expect(manifest.nodeVersion).toMatch(/^24\./);
    expect(manifest.nodeSha256LinuxX64).toMatch(/^[0-9a-f]{64}$/);
    const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(() =>
      validateManifestForEngine(manifest, { nvmrc, enginesNode: pkg.engines.node }),
    ).not.toThrow();
  });

  it('rejects malformed, duplicated, and unknown keys', () => {
    expect(() => parseRuntimeManifest('NODE_VERSION=24.19.0')).toThrow(ManifestError);
    expect(() =>
      parseRuntimeManifest(
        `NODE_VERSION=24.19.0\nNODE_VERSION=24.19.1\nNODE_SHA256_LINUX_X64=${'a'.repeat(64)}`,
      ),
    ).toThrow(/repeated/);
    expect(() => parseRuntimeManifest('EVIL=$(rm -rf /)')).toThrow(/unknown manifest key/);
    expect(() =>
      parseRuntimeManifest(`NODE_VERSION=24.19\nNODE_SHA256_LINUX_X64=${'a'.repeat(64)}`),
    ).toThrow(/X\.Y\.Z/);
    expect(() => parseRuntimeManifest(`NODE_VERSION=24.19.0\nNODE_SHA256_LINUX_X64=nope`)).toThrow(
      /64 lowercase hex/,
    );
  });

  it('fails rather than assuming Corepack beyond Node 24', () => {
    const manifest = { nodeVersion: '25.0.0', nodeSha256LinuxX64: 'a'.repeat(64) };
    expect(() =>
      validateManifestForEngine(manifest, { nvmrc: '25', enginesNode: '^25.0.0' }),
    ).toThrow(/Node 24/);
    const tooOld = { nodeVersion: '24.10.0', nodeSha256LinuxX64: 'a'.repeat(64) };
    expect(() =>
      validateManifestForEngine(tooOld, { nvmrc: '24', enginesNode: '^24.15.0' }),
    ).toThrow(/does not satisfy/);
  });
});

describe('state, journal, and ownership validation', () => {
  const runtime = {
    nodeVersion: '24.19.0',
    path: '/opt/root/runtime/node-v24.19.0',
    sha256: 'b'.repeat(64),
  };
  const config = {
    dataDir: '/home/u/.local/share/ai-usage-dashboard',
    databasePath: '/home/u/.local/share/ai-usage-dashboard/usage.db',
    envFile: '/home/u/.config/ai-usage-dashboard/collector.env',
    host: '127.0.0.1',
    port: 3838,
    intervalMinutes: 5,
    codexHome: '/home/u/.codex',
    codexDir: null,
  };
  const state: InstallationState = {
    schemaVersion: 1,
    installationId: 'installation-1',
    installRoot: '/home/u/.local/share/ai-usage-dashboard-install',
    launcherPath: '/home/u/.local/bin/ai-usage-dashboard',
    tag: 'v0.1.1',
    sha: 'c'.repeat(40),
    previous: { tag: 'v0.1.0', sha: 'd'.repeat(40), runtime },
    runtime,
    config,
    bridge: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('round-trips valid state atomically', () => {
    const dir = sandbox();
    writeState(dir, state);
    expect(readState(dir)).toEqual(state);
    const mode = statSync(join(dir, 'state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects unknown keys, wrong types, and bad phases', () => {
    expect(() => validateState({ ...state, extra: true })).toThrow(/unknown key/);
    expect(() =>
      validateState({ ...state, port: 99999, config: { ...config, port: 99999 } }),
    ).toThrow();
    expect(() => validateState({ ...state, sha: 'nope' })).toThrow(/40-character/);
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: 'op-1',
      kind: 'update',
      phase: 'db-changing',
      pid: 123,
      root: state.installRoot,
      candidate: { tag: 'v0.1.2', sha: 'e'.repeat(40), runtime },
      previous: { tag: state.tag, sha: state.sha, runtime },
      backupPath: null,
      snapshot: null,
      dbOwnershipRecorded: false,
      failed: null,
      notes: [],
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
    expect(validateJournal(journal)).toBeTruthy();
    expect(() => validateJournal({ ...journal, phase: 'nonsense' })).toThrow(/not a phase/);
    expect(() => validateJournal({ ...journal, kind: 'install' })).toThrow(/not a phase/);
  });

  it('round-trips the ownership record and tolerates an absent file', () => {
    const dir = sandbox();
    expect(readOwnership(dir).entries).toEqual([]);
    const record: OwnershipRecord = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      entries: [
        {
          dataDir: config.dataDir,
          databasePath: config.databasePath,
          installationId: 'installation-1',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    writeOwnership(dir, record);
    expect(readOwnership(dir)).toEqual(record);
    expect(() => validateOwnership({ ...record, entries: [{ databasePath: 1 }] })).toThrow();
  });

  it('reads a corrupt file as an error rather than replacing it', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'state.json'), '{ not json');
    expect(() => readState(dir)).toThrow(/not valid JSON/);
  });

  it('writes journals and symlinks atomically', () => {
    const dir = sandbox();
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: 'op-2',
      kind: 'install',
      phase: 'staged',
      pid: 1,
      root: dir,
      candidate: null,
      previous: null,
      backupPath: null,
      snapshot: null,
      dbOwnershipRecorded: false,
      failed: null,
      notes: ['note'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJournal(dir, journal);
    expect(readJournal(dir)).toEqual(journal);
    writeSymlinkAtomic(join(dir, 'current'), '/tmp/target');
    expect(readlinkSync(join(dir, 'current'))).toBe('/tmp/target');
  });
});

describe('install paths', () => {
  it('resolves the default root from an absolute XDG base only', () => {
    expect(defaultInstallRoot({ XDG_DATA_HOME: '/xdg' })).toBe('/xdg/ai-usage-dashboard-install');
    expect(defaultInstallRoot({ XDG_DATA_HOME: 'relative' })).toMatch(
      /\.local\/share\/ai-usage-dashboard-install$/,
    );
  });

  it('refuses paths that a systemd unit cannot carry', () => {
    for (const bad of ['/tmp/a b', '/tmp/a"b', "/tmp/a'b", '/tmp/a\\b', '/tmp/a\nb', '']) {
      expect(() => assertSafePathValue('X', bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => assertSafePathValue('X', '/tmp/a&b|c%d')).not.toThrow();
    expect(() => normaliseAbsolute('X', 'relative')).toThrow(/absolute/);
    expect(normaliseAbsolute('X', '/tmp/a/../b')).toBe('/tmp/b');
  });

  it('detects nesting with a component boundary', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('detects nesting through symlinks for the physical boundary', () => {
    const dir = sandbox();
    const root = join(dir, 'root');
    const inside = join(root, 'releases', 'a'.repeat(40), 'data');
    const outside = join(dir, 'outside');
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // Named outside the root, physically inside it.
    const inward = join(dir, 'data-link');
    symlinkSync(inside, inward);
    expect(isInside(inward, root)).toBe(false);
    expect(isPhysicallyInside(inward, root)).toBe(true);

    // A symlink that points outside stays outside.
    const outward = join(dir, 'outward');
    symlinkSync(outside, outward);
    expect(isPhysicallyInside(outward, root)).toBe(false);

    // A missing tail resolves through the longest existing ancestor.
    expect(physicalPath(join(inward, 'usage.db'))).toBe(join(inside, 'usage.db'));
    expect(isPhysicallyInside(join(inward, 'usage.db'), root)).toBe(true);
  });

  it('classifies empty, managed, partial, and occupied roots', () => {
    const dir = sandbox();
    expect(classifyRoot(join(dir, 'missing'))).toBe('absent');
    expect(classifyRoot(dir)).toBe('empty-managed');
    writeFileSync(join(dir, 'lifecycle.lock'), '');
    writeFileSync(join(dir, 'data-ownership.json'), '{}');
    expect(classifyRoot(dir)).toBe('empty-managed');
    mkdirSync(join(dir, 'releases'));
    expect(classifyRoot(dir)).toBe('partial');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    expect(classifyRoot(dir)).toBe('occupied');
  });
});

describe('retention', () => {
  it('keeps active, previous, and referenced releases only', () => {
    const root = sandbox();
    const runtimePath = join(root, 'runtime', 'node-v24.19.0');
    const runtime = (version: string) => ({
      nodeVersion: version,
      path: version === '24.19.0' ? runtimePath : join(root, 'runtime', `node-v${version}`),
      sha256: 'a'.repeat(64),
    });
    for (const sha of ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)]) {
      mkdirSync(join(root, 'releases', sha), { recursive: true });
    }
    for (const version of ['24.19.0', '24.20.0', '24.21.0']) {
      mkdirSync(join(root, 'runtime', `node-v${version}`), { recursive: true });
    }
    const plan = planRetention({
      root,
      active: { tag: 'v0.2.0', sha: 'b'.repeat(40), runtime: runtime('24.19.0') },
      previous: { tag: 'v0.1.0', sha: 'a'.repeat(40), runtime: runtime('24.20.0') },
      unitContents: [`WorkingDirectory=${root}/releases/${'c'.repeat(40)}`],
      bridgeCommand: null,
    });
    expect(plan.pruneReleases).toEqual([join(root, 'releases', 'd'.repeat(40))]);
    expect(plan.pruneRuntimes).toEqual([join(root, 'runtime', 'node-v24.21.0')]);
    expect(plan.keepReleases).toHaveLength(3);
  });
});

describe('systemd unit ownership', () => {
  const root = '/home/u/.local/share/ai-usage-dashboard-install';

  it('derives timer ownership from the owned collector service', () => {
    const dir = sandbox();
    const configHome = join(dir, 'config');
    const unitDir = join(configHome, 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    const env = { ...process.env, XDG_CONFIG_HOME: configHome };
    writeFileSync(
      join(unitDir, COLLECTOR_SERVICE),
      `[Service]\nWorkingDirectory=${root}/releases/${'a'.repeat(40)}\n`,
    );
    writeFileSync(join(unitDir, COLLECTOR_TIMER), `[Timer]\nUnit=${COLLECTOR_SERVICE}\n`);
    expect(ownedUnits(root, env)).toEqual([COLLECTOR_SERVICE, COLLECTOR_TIMER]);
    // A manual collector service makes the identically named timer foreign too.
    writeFileSync(
      join(unitDir, COLLECTOR_SERVICE),
      '[Service]\nWorkingDirectory=/home/u/Workspace/ai-usage-dashboard-prod\n',
    );
    expect(ownedUnits(root, env)).toEqual([]);
  });

  it('recognises the managed WorkingDirectory and not a foreign checkout', () => {
    const owned = `[Service]\nWorkingDirectory=${root}/releases/${'a'.repeat(40)}\n`;
    const foreign = '[Service]\nWorkingDirectory=/home/u/Workspace/ai-usage-dashboard-prod\n';
    expect(unitWorkingDirectory(owned)).toBe(`${root}/releases/${'a'.repeat(40)}`);
    expect(unitOwnedByRoot(owned, root)).toBe(true);
    expect(unitOwnedByRoot(foreign, root)).toBe(false);
    expect(unitOwnedByRoot('[Service]\nExecStart=/bin/true\n', root)).toBe(false);
  });
});

describe('launcher and bridge helpers', () => {
  it('generates a launcher that is recognisably ours and root-bound', () => {
    const root = '/home/u/.local/share/ai-usage-dashboard-install';
    const content = launcherContent(root, 'https://example.com/repo.git');
    expect(launcherIsOurs(content, root)).toBe(true);
    expect(launcherIsOurs(content, '/other/root')).toBe(false);
    expect(content).toContain(`${root}/runtime/current/bin/node`);
    expect(content).toContain(`${root}/current/scripts/manage-installation.ts`);
  });

  it('validates bridge ownership against the recorded release and runtime, not the marker', () => {
    const dir = sandbox();
    const settings = join(dir, 'settings.json');
    const releasePath = join(dir, 'releases', 'a'.repeat(40));
    const runtimePath = join(dir, 'runtime', 'node-v24.19.0');
    const bridge = {
      settingsPath: settings,
      command: `'${join(runtimePath, 'bin/node')}' '${releasePath}/scripts/claude-statusline-bridge.mjs'`,
      releasePath,
      runtimePath,
    };
    writeFileSync(settings, JSON.stringify({ statusLine: { command: bridge.command } }));
    expect(bridgeMatchesRecorded(bridge)).toBe(true);
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { command: "'/usr/bin/node' '/other/bridge.mjs'" } }),
    );
    expect(bridgeMatchesRecorded(bridge)).toBe(false);
    rmSync(settings);
    expect(bridgeMatchesRecorded(bridge)).toBe(false);
  });
});

describe('service environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'aud-build-env-'));
  cleanups.push(root);
  const runtime = {
    nodeVersion: '24.19.0',
    path: '/root/runtime/node-v24.19.0',
    sha256: 'a'.repeat(64),
  };
  const config = {
    dataDir: '/data',
    databasePath: '/data/usage.db',
    envFile: '/config/collector.env',
    host: '::1',
    port: 3838,
    intervalMinutes: 7,
    codexHome: '/home/u/.codex',
    codexDir: '/home/u/.nvm/bin',
  };

  it('keeps the captured Codex directory on the service PATH', () => {
    const env = serviceEnv(config, runtime);
    expect(env['PATH']).toBe(
      '/root/runtime/node-v24.19.0/bin:/home/u/.nvm/bin:/usr/local/bin:/usr/bin:/bin',
    );
    expect(env['CODEX_HOME']).toBe('/home/u/.codex');
    expect(env['AUD_COLLECT_INTERVAL_MINUTES']).toBe('7');
  });

  it('isolates the build from the real database and environment file', () => {
    const env = buildEnv(root, config, runtime);
    expect(env['AUD_DATA_DIR']).toBe(join(root, 'cache', 'build-data'));
    expect(env['AUD_ENV_FILE']).toBe(join(root, 'cache', 'build-env-file-absent'));
  });

  it('brackets IPv6 hosts in the health URL', () => {
    expect(httpUrl('::1', 3838)).toBe('http://[::1]:3838/');
    expect(httpUrl('127.0.0.1', 3838)).toBe('http://127.0.0.1:3838/');
  });
});

describe('renderer compatibility', () => {
  it('accepts literal % and & in managed paths exactly as the unit renderer does', () => {
    expect(systemdValue('DATADIR', '/data/100%/a&b')).toBe('/data/100%%/a&b');
    expect(
      renderUnit('[Service]\nWorkingDirectory=__WORKDIR__\n', {
        WORKDIR: '/root',
        PATH: '/bin',
        CODEXHOME: '/home/u/.codex',
        NODE: '/root/runtime/node-v24.19.0/bin/node',
        TSX: '/root/releases/x/node_modules/tsx/dist/cli.mjs',
        DATADIR: '/data/100%/a&b',
        ENVFILE: '/config/collector.env',
        INTERVAL: '5',
        HOST: '127.0.0.1',
        PORT: '3838',
      }),
    ).toContain('WorkingDirectory=/root');
  });
});

describe('codex capture', () => {
  it('captures an absolute codex home and an optional directory', () => {
    const dir = sandbox();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const capture = captureCodex({ PATH: bin, HOME: dir });
    expect(capture.codexDir).toBe(bin);
    expect(capture.codexHome).toBe(join(dir, '.codex'));
    expect(() => captureCodex({ PATH: bin, HOME: dir, CODEX_HOME: 'relative' })).toThrow(
      /absolute/,
    );
  });
});

describe('atomic writes', () => {
  it('replaces file contents without exposing partial data', () => {
    const dir = sandbox();
    const path = join(dir, 'file.json');
    writeFileAtomic(path, '{"a":1}');
    writeFileAtomic(path, '{"a":2}');
    expect(readFileSync(path, 'utf8')).toBe('{"a":2}');
  });
});
