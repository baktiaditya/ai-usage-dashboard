import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RENDER = join(process.cwd(), 'scripts', 'render-launchd-agents.ts');
const RENDER_SYSTEMD = join(process.cwd(), 'scripts', 'render-systemd-units.ts');

const DEFAULT_PREFIX = 'io.github.baktiaditya.ai-usage-dashboard';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-launchd-render-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Parse a plist with Python's plistlib, the same XML parser used on every platform. */
function parsePlist(path: string): Record<string, unknown> {
  const script =
    'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb")), default=str))';
  const r = spawnSync('python3', ['-c', script, path], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/**
 * Render the agents as scripts/install-launchd.sh does: a throwaway home, an
 * explicit data directory and environment file, and the interpreter paths.
 */
function render(args: readonly string[], extra: Record<string, string> = {}) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2, 8)}`);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AUD_')) env[key] = value;
  }
  Object.assign(env, {
    HOME: dir,
    XDG_DATA_HOME: join(dir, 'share'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    AUD_ENV_FILE: join(dir, 'none.env'),
    AUD_DATA_DIR: join(dir, 'data'),
    AUD_UNIT_WORKDIR: process.cwd(),
    AUD_UNIT_PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    AUD_UNIT_CODEXHOME: join(dir, '.codex'),
    AUD_UNIT_NODE: process.execPath,
    AUD_UNIT_TSX: TSX,
    ...extra,
  });
  const r = spawnSync(process.execPath, [TSX, RENDER, out, ...args], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  return {
    ...r,
    out,
    reported: r.stdout.trim().split('\n'),
    plist: (name: string) => parsePlist(join(out, name)),
    raw: (name: string) => readFileSync(join(out, name), 'utf8'),
  };
}

describe('render-launchd-agents', () => {
  it('renders both agents with the production labels and the shared environment', () => {
    const r = render([], { AUD_HOST: 'localhost', AUD_PORT: '4555' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.reported.slice(0, 5)).toEqual([
      join(dir, 'none.env'),
      join(dir, 'data'),
      '5',
      'localhost',
      '4555',
    ]);
    expect(r.reported[5]).toBe(`${DEFAULT_PREFIX}.collector`);
    expect(r.reported[6]).toBe(`${DEFAULT_PREFIX}.collector.plist`);
    expect(r.reported[7]).toBe(`${DEFAULT_PREFIX}.web`);
    expect(r.reported[8]).toBe(`${DEFAULT_PREFIX}.web.plist`);

    const collector = r.plist(`${DEFAULT_PREFIX}.collector.plist`);
    expect(collector['Label']).toBe(`${DEFAULT_PREFIX}.collector`);
    expect(collector['ProgramArguments']).toEqual([
      process.execPath,
      TSX,
      join(process.cwd(), 'scripts', 'collect.ts'),
    ]);
    expect(collector['WorkingDirectory']).toBe(process.cwd());
    expect(collector['StartInterval']).toBe(300);
    expect(collector['RunAtLoad']).toBe(true);
    expect(collector['ProcessType']).toBe('Background');
    expect(collector['LowPriorityIO']).toBe(true);
    expect(collector['Umask']).toBe(63);
    expect(collector['StandardOutPath']).toBe(
      join(dir, 'Library', 'Logs', 'ai-usage-dashboard', `${DEFAULT_PREFIX}.collector.out.log`),
    );
    expect(collector['StandardErrorPath']).toBe(
      join(dir, 'Library', 'Logs', 'ai-usage-dashboard', `${DEFAULT_PREFIX}.collector.err.log`),
    );
    expect(collector['AbandonProcessGroup']).toBeUndefined();

    const web = r.plist(`${DEFAULT_PREFIX}.web.plist`);
    expect(web['Label']).toBe(`${DEFAULT_PREFIX}.web`);
    expect(web['ProgramArguments']).toEqual([
      process.execPath,
      TSX,
      join(process.cwd(), 'scripts', 'next.ts'),
      'start',
    ]);
    expect(web['KeepAlive']).toEqual({ SuccessfulExit: false });
    expect(web['RunAtLoad']).toBe(true);
    expect(web['Umask']).toBe(63);

    // The environment contract matches the systemd renderer for the same inputs.
    const units = join(dir, 'units');
    mkdirSync(units, { recursive: true });
    const systemdEnv: Record<string, string | undefined> = {
      HOME: dir,
      XDG_DATA_HOME: join(dir, 'share'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      AUD_ENV_FILE: join(dir, 'none.env'),
      AUD_DATA_DIR: join(dir, 'data'),
      AUD_UNIT_WORKDIR: process.cwd(),
      AUD_UNIT_PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      AUD_UNIT_CODEXHOME: join(dir, '.codex'),
      AUD_UNIT_NODE: process.execPath,
      AUD_UNIT_TSX: TSX,
      AUD_HOST: 'localhost',
      AUD_PORT: '4555',
    };
    const systemd = spawnSync(process.execPath, [TSX, RENDER_SYSTEMD, units], {
      encoding: 'utf8',
      env: systemdEnv as NodeJS.ProcessEnv,
    });
    expect(systemd.status, systemd.stderr).toBe(0);
    expect(r.reported.slice(0, 5)).toEqual(systemd.stdout.trim().split('\n'));

    const collectorEnv = collector['EnvironmentVariables'] as Record<string, string>;
    const webEnv = web['EnvironmentVariables'] as Record<string, string>;
    for (const env of [collectorEnv, webEnv]) {
      expect(env).toMatchObject({
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        CODEX_HOME: join(dir, '.codex'),
        AUD_ENV_FILE: join(dir, 'none.env'),
        AUD_DATA_DIR: join(dir, 'data'),
        AUD_COLLECT_INTERVAL_MINUTES: '5',
      });
    }
    expect(webEnv).toMatchObject({
      AUD_HOST: 'localhost',
      AUD_PORT: '4555',
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    });
    for (const path of [collector['StandardOutPath'], web['StandardErrorPath']] as string[]) {
      expect(path.startsWith('/')).toBe(true);
      expect(path).not.toContain('~');
    }

    if (process.platform === 'darwin') {
      for (const name of ['collector', 'web']) {
        const lint = spawnSync(
          'plutil',
          ['-lint', join(r.out, `${DEFAULT_PREFIX}.${name}.plist`)],
          {
            encoding: 'utf8',
          },
        );
        expect(lint.status, lint.stderr).toBe(0);
      }
    }
  });

  it('derives labels and file names from a custom prefix', () => {
    const prefix = 'dev.example.dashboard.test.1699999999-42';
    const r = render(['--label-prefix', prefix, '--log-dir', join(dir, 'custom-logs')]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(r.out, `${prefix}.collector.plist`))).toBe(true);
    expect(existsSync(join(r.out, `${prefix}.web.plist`))).toBe(true);
    expect(r.plist(`${prefix}.collector.plist`)['Label']).toBe(`${prefix}.collector`);
    expect(r.plist(`${prefix}.web.plist`)['Label']).toBe(`${prefix}.web`);
    expect(existsSync(join(r.out, `${DEFAULT_PREFIX}.collector.plist`))).toBe(false);
    expect(r.raw(`${prefix}.collector.plist`)).toContain(join(dir, 'custom-logs'));
  });

  it('renders a path containing &, < and % literally through a plist parser', () => {
    const special = join(dir, 'a&b<c>d\'e"f%g');
    const r = render([], { AUD_DATA_DIR: special });
    expect(r.status, r.stderr).toBe(0);
    const collector = r.plist(`${DEFAULT_PREFIX}.collector.plist`);
    expect(collector['EnvironmentVariables']).toMatchObject({ AUD_DATA_DIR: special });
    expect(collector['Label']).toBe(`${DEFAULT_PREFIX}.collector`);
  });

  it('changes the log paths with --log-dir', () => {
    const logs = join(dir, 'elsewhere', 'logs');
    const r = render(['--log-dir', logs]);
    expect(r.status, r.stderr).toBe(0);
    const collector = r.plist(`${DEFAULT_PREFIX}.collector.plist`);
    expect(collector['StandardOutPath']).toBe(join(logs, `${DEFAULT_PREFIX}.collector.out.log`));
    expect(collector['StandardErrorPath']).toBe(join(logs, `${DEFAULT_PREFIX}.collector.err.log`));
    expect(existsSync(logs)).toBe(false); // rendering does not create it; the installer does
  });
});

describe('render-launchd-agents refusals', () => {
  function makeProtected(): void {
    for (const p of [
      join(dir, 'Documents'),
      join(dir, 'Downloads'),
      join(dir, 'Desktop'),
      join(dir, 'Library', 'Mobile Documents'),
      join(dir, 'Workspace'),
    ]) {
      mkdirSync(p, { recursive: true });
    }
  }

  it.each([
    ['the checkout', ['AUD_UNIT_WORKDIR', join('Documents', 'checkout')]],
    ['the data directory', ['AUD_DATA_DIR', join('Downloads', 'data')]],
    [
      'the environment file',
      ['AUD_ENV_FILE', join('Library', 'Mobile Documents', 'collector.env')],
    ],
    ['CODEX_HOME', ['AUD_UNIT_CODEXHOME', join('Desktop', '.codex')]],
  ] as const)('refuses %s under a protected folder and writes nothing', (_, [key, rel]) => {
    makeProtected();
    const r = render([], { [key]: join(dir, rel) });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/privacy protection/);
    expect(existsSync(r.out)).toBe(false);
  });

  it('refuses a log directory under a protected folder and writes nothing', () => {
    makeProtected();
    const r = render(['--log-dir', join(dir, 'Documents', 'logs')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/privacy protection/);
    expect(existsSync(r.out)).toBe(false);
  });

  it('refuses a symlink that resolves into a protected folder', () => {
    makeProtected();
    symlinkSync(join(dir, 'Documents'), join(dir, 'Workspace', 'inward'));
    const r = render([], { AUD_DATA_DIR: join(dir, 'Workspace', 'inward', 'data') });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/privacy protection/);
    expect(existsSync(r.out)).toBe(false);
  });

  it.each([
    ['an invalid prefix', ['--label-prefix', 'bad/prefix']],
    ['an empty prefix', ['--label-prefix', '']],
    ['a missing prefix value', ['--label-prefix']],
    ['a relative log directory', ['--log-dir', 'logs']],
    ['a missing log directory value', ['--log-dir']],
  ])('refuses %s without filesystem side effects', (_, args) => {
    const r = render(args);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(existsSync(r.out)).toBe(false);
  });

  it('refuses a data directory with a control character, writing nothing', () => {
    const r = render([], { AUD_DATA_DIR: join(dir, 'bad\u0007dir') });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/control character/);
    expect(existsSync(r.out)).toBe(false);
  });
});
