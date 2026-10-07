import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const INSTALLER = join(ROOT, 'scripts', 'install-launchd.sh');
const STUB = join(ROOT, 'tests', 'fixtures', 'launchctl-stub.sh');
const GEN_DIR = join(ROOT, 'launchd', 'generated');
const BUILD_ID = join(ROOT, '.next', 'BUILD_ID');
const UID = String(process.getuid?.() ?? 0);
const DOMAIN = `gui/${UID}`;

const DEFAULT_PREFIX = 'io.github.baktiaditya.ai-usage-dashboard';
const CUSTOM_PREFIX = 'dev.example.dashboard.test';
const PRODUCTION_PLISTS = [`${DEFAULT_PREFIX}.collector.plist`, `${DEFAULT_PREFIX}.web.plist`];

let fixture: string;
let home: string;
let agentDir: string;
let stubDir: string;
let stubBin: string;
let generatedBefore: Set<string>;
let createdBuildId = false;

beforeAll(() => {
  // The installer refuses --with-web without a production build. Create the
  // marker for the web lifecycle tests when the checkout has none, and remove
  // only a marker this suite created.
  mkdirSync(dirname(BUILD_ID), { recursive: true });
  if (!existsSync(BUILD_ID)) {
    writeFileSync(BUILD_ID, 'aud-install-launchd-test\n');
    createdBuildId = true;
  }
});

afterAll(() => {
  if (createdBuildId) rmSync(BUILD_ID, { force: true });
});

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'aud-launchd-installer-'));
  home = join(fixture, 'home');
  agentDir = join(home, 'Library', 'LaunchAgents');
  stubDir = join(fixture, 'stub');
  stubBin = join(fixture, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  symlinkSync(STUB, join(stubBin, 'launchctl'));
  // A resolved codex keeps the installer's baked PATH deterministic and the
  // render-only stderr empty on runners that have no Codex CLI installed.
  writeFileSync(join(stubBin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  generatedBefore = new Set(existsSync(GEN_DIR) ? readdirSync(GEN_DIR) : []);
});

afterEach(() => {
  if (existsSync(GEN_DIR)) {
    for (const name of readdirSync(GEN_DIR)) {
      if (!generatedBefore.has(name)) rmSync(join(GEN_DIR, name), { force: true });
    }
  }
  rmSync(fixture, { recursive: true, force: true });
});

function installerEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AUD_')) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_DATA_HOME: join(fixture, 'share'),
    XDG_CONFIG_HOME: join(fixture, 'config'),
    AUD_LAUNCHCTL_STUB_DIR: stubDir,
    AUD_DATA_DIR: join(fixture, 'data'),
    AUD_ENV_FILE: join(fixture, 'collector.env'),
    AUD_PORT: '4556',
    PATH: `${stubBin}:${dirname(process.execPath)}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    ...extra,
  });
  return env as NodeJS.ProcessEnv;
}

function run(args: readonly string[], extra: Record<string, string | undefined> = {}) {
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: installerEnv(extra),
    timeout: 60_000,
  });
}

function calls(): string[] {
  const file = join(stubDir, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function markLoaded(label: string): void {
  writeFileSync(join(stubDir, `loaded.${label}`), '');
}

function isLoaded(label: string): boolean {
  return existsSync(join(stubDir, `loaded.${label}`));
}

function isDisabled(label: string): boolean {
  return existsSync(join(stubDir, `disabled.${label}`));
}

function generatedFiles(): string[] {
  return existsSync(GEN_DIR) ? readdirSync(GEN_DIR).sort() : [];
}

function plistLabel(path: string): string {
  const match = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(path, 'utf8'));
  if (!match?.[1]) throw new Error(`no Label key in ${path}`);
  return match[1];
}

/** No call, generated file or installed plist may mention a production label. */
function expectNoProductionSurfaces(): void {
  const productionLabels = [`${DEFAULT_PREFIX}.collector`, `${DEFAULT_PREFIX}.web`];
  for (const call of calls()) {
    for (const label of productionLabels) expect(call, call).not.toContain(label);
  }
  for (const name of generatedFiles()) {
    expect(PRODUCTION_PLISTS, name).not.toContain(name);
  }
  if (existsSync(agentDir)) {
    for (const name of readdirSync(agentDir)) {
      expect(PRODUCTION_PLISTS, name).not.toContain(name);
    }
  }
}

function customArgs(...extra: string[]): string[] {
  return ['--label-prefix', CUSTOM_PREFIX, '--log-dir', join(fixture, 'logs'), ...extra];
}

describe('install-launchd.sh render-only default', () => {
  it('renders the production agents and never invokes launchctl', () => {
    const r = run([]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${DEFAULT_PREFIX}.collector`);
    expect(r.stdout).toContain(`${DEFAULT_PREFIX}.web`);
    expect(generatedFiles()).toContain(`${DEFAULT_PREFIX}.collector.plist`);
    expect(generatedFiles()).toContain(`${DEFAULT_PREFIX}.web.plist`);
    expect(calls()).toEqual([]);
    expect(existsSync(agentDir)).toBe(false);
  });

  it('renders prefix-derived file names for a custom prefix, touching no production surface', () => {
    const r = run(customArgs());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const collector = join(GEN_DIR, `${CUSTOM_PREFIX}.collector.plist`);
    expect(existsSync(collector)).toBe(true);
    expect(plistLabel(collector)).toBe(`${CUSTOM_PREFIX}.collector`);
    expect(plistLabel(join(GEN_DIR, `${CUSTOM_PREFIX}.web.plist`))).toBe(`${CUSTOM_PREFIX}.web`);
    expect(calls()).toEqual([]);
    expectNoProductionSurfaces();
  });
});

describe('install-launchd.sh --install without --enable', () => {
  it('installs the collector plist 0600, creates the log dir 0700, and disables the label', () => {
    const r = run(['--install']);
    expect(r.status, r.stderr).toBe(0);
    const installed = join(agentDir, `${DEFAULT_PREFIX}.collector.plist`);
    expect(existsSync(installed)).toBe(true);
    expect(statSync(installed).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'Library', 'Logs', 'ai-usage-dashboard')).mode & 0o777).toBe(0o700);
    expect(calls()).toEqual([`disable ${DOMAIN}/${DEFAULT_PREFIX}.collector`]);
    expect(isDisabled(`${DEFAULT_PREFIX}.collector`)).toBe(true);
    expect(isLoaded(`${DEFAULT_PREFIX}.collector`)).toBe(false);
  });

  it('with --with-web installs both and disables both, never mentioning production labels', () => {
    const logs = join(fixture, 'logs');
    const r = run(['--install', '--with-web', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    for (const label of [`${CUSTOM_PREFIX}.collector`, `${CUSTOM_PREFIX}.web`]) {
      const installed = join(agentDir, `${label}.plist`);
      expect(existsSync(installed), label).toBe(true);
      expect(statSync(installed).mode & 0o777).toBe(0o600);
      expect(plistLabel(installed)).toBe(label);
    }
    expect(calls()).toEqual([
      `disable ${DOMAIN}/${CUSTOM_PREFIX}.collector`,
      `disable ${DOMAIN}/${CUSTOM_PREFIX}.web`,
    ]);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expectNoProductionSurfaces();
  });
});

describe('install-launchd.sh --with-web without a production build', () => {
  it('refuses before installing anything or invoking launchctl', () => {
    const moved = join(dirname(BUILD_ID), 'BUILD_ID.aud-test-moved');
    const hadBuild = existsSync(BUILD_ID);
    if (hadBuild) renameSync(BUILD_ID, moved);
    try {
      const r = run(['--install', '--with-web', ...customArgs()]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/production build/);
      expect(calls()).toEqual([]);
      expect(existsSync(agentDir)).toBe(false);
      expect(generatedFiles().every((name) => !name.startsWith(CUSTOM_PREFIX))).toBe(true);
    } finally {
      if (hadBuild) renameSync(moved, BUILD_ID);
    }
  });
});

describe('install-launchd.sh --enable', () => {
  it('enables before bootstrapping, bootstrap points at the installed plist, and the label loads', () => {
    const r = run(['--enable', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    const label = `${CUSTOM_PREFIX}.collector`;
    const list = calls();
    const enableAt = list.indexOf(`enable ${DOMAIN}/${label}`);
    const bootstrapAt = list.findIndex(
      (c) => c === `bootstrap ${DOMAIN} ${join(agentDir, `${label}.plist`)}`,
    );
    expect(enableAt).toBeGreaterThanOrEqual(0);
    expect(bootstrapAt).toBeGreaterThan(enableAt);
    expect(list.some((c) => c === `print ${DOMAIN}/${label}`)).toBe(true);
    expect(isLoaded(label)).toBe(true);
    expectNoProductionSurfaces();
  });

  it('boots an already-loaded label out and waits for it to disappear before bootstrapping', () => {
    const label = `${CUSTOM_PREFIX}.collector`;
    markLoaded(label);
    const r = run(['--enable', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    const list = calls();
    const bootoutAt = list.indexOf(`bootout ${DOMAIN}/${label}`);
    const bootstrapAt = list.findIndex((c) => c.startsWith(`bootstrap ${DOMAIN}`));
    expect(bootoutAt).toBeGreaterThanOrEqual(0);
    expect(bootstrapAt).toBeGreaterThan(bootoutAt);
    expect(isLoaded(label)).toBe(true);
  });

  it('survives being enabled twice in a row (the bootout race)', () => {
    const label = `${CUSTOM_PREFIX}.collector`;
    const first = run(['--enable', ...customArgs()]);
    expect(first.status, first.stderr).toBe(0);
    const second = run(['--enable', ...customArgs()]);
    expect(second.status, second.stderr).toBe(0);
    expect(isLoaded(label)).toBe(true);
    const list = calls();
    expect(list.filter((c) => c.startsWith(`bootstrap ${DOMAIN}`)).length).toBe(2);
  });

  it('loads the web agent, kickstarts it, and bakes the resolved host and port', () => {
    const r = run(['--enable', '--with-web', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    const web = `${CUSTOM_PREFIX}.web`;
    expect(isLoaded(web)).toBe(true);
    const list = calls();
    const webBootstrapAt = list.findIndex(
      (c) => c === `bootstrap ${DOMAIN} ${join(agentDir, `${web}.plist`)}`,
    );
    const kickstartAt = list.indexOf(`kickstart -k ${DOMAIN}/${web}`);
    expect(webBootstrapAt).toBeGreaterThanOrEqual(0);
    expect(kickstartAt).toBeGreaterThan(webBootstrapAt);
    const plist = readFileSync(join(agentDir, `${web}.plist`), 'utf8');
    expect(plist).toContain('<key>AUD_PORT</key>');
    expect(plist).toContain('<string>4556</string>');
  });

  it('retries a bounded number of times on bootstrap error 5 and then succeeds', () => {
    const r = run(['--enable', ...customArgs()], {
      AUD_LAUNCHCTL_STUB_BOOTSTRAP_FAILURES: '2',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(calls().filter((c) => c.startsWith(`bootstrap ${DOMAIN}`)).length).toBe(3);
    expect(isLoaded(`${CUSTOM_PREFIX}.collector`)).toBe(true);
  });

  it('fails non-zero and starts nothing unsupervised when bootstrap always fails', () => {
    const r = run(['--enable', ...customArgs()], {
      AUD_LAUNCHCTL_STUB_BOOTSTRAP_ALWAYS_FAILS: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Bootstrap failed: 5/);
    const list = calls();
    const attempts = list.filter((c) => c.startsWith(`bootstrap ${DOMAIN}`));
    expect(attempts.length).toBe(5);
    expect(list.every((c) => /^(enable|print|bootout|bootstrap) /.test(c))).toBe(true);
    expect(isLoaded(`${CUSTOM_PREFIX}.collector`)).toBe(false);
  });

  it('fails non-zero when bootstrap reports success but the label never loads', () => {
    const r = run(['--enable', ...customArgs()], {
      AUD_LAUNCHCTL_STUB_BOOTSTRAP_IGNORES: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not loaded after bootstrap/);
    expect(isLoaded(`${CUSTOM_PREFIX}.collector`)).toBe(false);
  });

  it('gives up, bounded, when a booted-out label never disappears', () => {
    const label = `${CUSTOM_PREFIX}.collector`;
    markLoaded(label);
    const r = run(['--enable', ...customArgs()], {
      AUD_LAUNCHCTL_STUB_BOOTOUT_STICKS: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/still loaded after bootout/);
    const list = calls();
    expect(list.some((c) => c.startsWith(`bootstrap ${DOMAIN}`))).toBe(false);
    expect(list.filter((c) => c === `print ${DOMAIN}/${label}`).length).toBeLessThanOrEqual(8);
  });
});

describe('install-launchd.sh --status', () => {
  it('reports load state, the disabled override, recent logs, and the Login Items hint', () => {
    const label = `${CUSTOM_PREFIX}.collector`;
    markLoaded(label);
    const logs = join(fixture, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `${label}.out.log`), 'collector says hello\n');
    const r = run(['--status', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(label);
    expect(r.stdout).toContain('state = running');
    expect(r.stdout).toContain('disabled override');
    expect(r.stdout).toContain('collector says hello');
    expect(r.stdout).toContain('Login Items');
    expect(calls().every((c) => /^(print|print-disabled) /.test(c))).toBe(true);
  });

  it('shows the web agent when its plist is installed', () => {
    expect(run(['--install', '--with-web', ...customArgs()]).status).toBe(0);
    const r = run(['--status', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${CUSTOM_PREFIX}.web`);
  });
});

describe('install-launchd.sh --disable', () => {
  it('boots both agents out, disables both, and leaves the plists in place', () => {
    expect(run(['--install', '--with-web', ...customArgs()]).status).toBe(0);
    const collector = `${CUSTOM_PREFIX}.collector`;
    const web = `${CUSTOM_PREFIX}.web`;
    markLoaded(collector);
    markLoaded(web);
    rmSync(join(stubDir, 'calls.log'));

    const r = run(['--disable', '--with-web', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([
      `bootout ${DOMAIN}/${collector}`,
      `disable ${DOMAIN}/${collector}`,
      `bootout ${DOMAIN}/${web}`,
      `disable ${DOMAIN}/${web}`,
    ]);
    expect(isLoaded(collector)).toBe(false);
    expect(isLoaded(web)).toBe(false);
    expect(isDisabled(collector)).toBe(true);
    expect(isDisabled(web)).toBe(true);
    expect(existsSync(join(agentDir, `${collector}.plist`))).toBe(true);
    expect(existsSync(join(agentDir, `${web}.plist`))).toBe(true);
    expectNoProductionSurfaces();
  });

  it('disables only the collector unless --with-web is given', () => {
    expect(run(['--install', '--with-web', ...customArgs()]).status).toBe(0);
    markLoaded(`${CUSTOM_PREFIX}.collector`);
    markLoaded(`${CUSTOM_PREFIX}.web`);
    rmSync(join(stubDir, 'calls.log'));

    const r = run(['--disable', ...customArgs()]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([
      `bootout ${DOMAIN}/${CUSTOM_PREFIX}.collector`,
      `disable ${DOMAIN}/${CUSTOM_PREFIX}.collector`,
    ]);
    expect(isLoaded(`${CUSTOM_PREFIX}.collector`)).toBe(false);
    expect(isLoaded(`${CUSTOM_PREFIX}.web`)).toBe(true);
  });
});

describe('install-launchd.sh invalid options', () => {
  it.each([
    ['a prefix with a path separator', ['--install', '--label-prefix', 'bad/prefix']],
    ['an empty prefix', ['--install', '--label-prefix', '']],
    ['a prefix with a space', ['--install', '--label-prefix', 'bad prefix']],
    ['a missing prefix value', ['--install', '--label-prefix']],
    ['a relative log directory', ['--install', '--log-dir', 'logs']],
    ['an empty log directory', ['--install', '--log-dir', '']],
    ['a missing log directory value', ['--log-dir']],
    ['an unknown argument', ['--install', '--nope']],
  ] as const)('refuses %s before any side effect', (_, args) => {
    const generated = generatedFiles();
    const r = run(args);
    expect(r.status, args.join(' ')).toBe(2);
    expect(calls()).toEqual([]);
    expect(existsSync(agentDir)).toBe(false);
    expect(generatedFiles()).toEqual(generated);
  });
});
