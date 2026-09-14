import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WRAPPER = join(process.cwd(), 'scripts', 'next.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RECORDER = pathToFileURL(join(process.cwd(), 'tests', 'helpers', 'spawn-recorder.mjs')).href;

// Fake credentials; the recorder reports only whether each is unset, empty, or set.
const DEEPSEEK = 'sk-fake-deepseek-next-wrapper';
const OPENROUTER = 'sk-or-fake-next-wrapper';

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | null>;
  readonly credentials: Record<string, 'unset' | 'empty' | 'set'>;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aud-next-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeEnvFile(contents: string): string {
  const path = join(home, 'collector.env');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/**
 * Run the wrapper in a throwaway home. The recorder preload captures what the
 * wrapper would spawn and exits, so no test here ever starts a Next.js server;
 * `spawned` is null when the wrapper exited before spawning anything.
 */
function launch(mode: string, extra: Record<string, string> = {}, flags: string[] = []) {
  const record = join(home, 'spawn.json');
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !key.startsWith('AUD_') &&
      key !== 'DEEPSEEK_API_KEY' &&
      key !== 'OPENROUTER_MANAGEMENT_KEY'
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: home,
    XDG_DATA_HOME: join(home, 'share'),
    XDG_CONFIG_HOME: join(home, 'config'),
    AUD_ENV_FILE: join(home, 'none.env'),
    AUD_TEST_SPAWN_RECORD: record,
    ...extra,
  });
  const r = spawnSync(process.execPath, [TSX, '--import', RECORDER, WRAPPER, mode, ...flags], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    // A regression could start a server; the timeout turns that into a failure.
    timeout: 30_000,
  });
  const spawned = existsSync(record)
    ? (JSON.parse(readFileSync(record, 'utf8')) as SpawnRecord)
    : null;
  return { ...r, spawned };
}

const BIND_FLAGS = [
  ['--port', '3999'],
  ['--port=3999'],
  ['-p', '3999'],
  ['-p3999'],
  ['--hostname', '127.0.0.2'],
  ['--hostname=127.0.0.2'],
  ['-H', '127.0.0.2'],
];

describe('the Next.js wrapper keeps the validated bind address', () => {
  it.each(BIND_FLAGS)('start refuses a passed-through %s before starting a server', (...flag) => {
    const r = launch('start', {}, flag);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('set AUD_HOST / AUD_PORT instead');
    expect(r.spawned).toBeNull();
  });

  it.each(BIND_FLAGS)('dev refuses a passed-through %s and names AUD_DEV_PORT', (...flag) => {
    const r = launch('dev', {}, flag);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('set AUD_HOST / AUD_DEV_PORT instead');
    expect(r.spawned).toBeNull();
  });
});

describe('npm run start keeps its production contract', () => {
  it('binds AUD_HOST/AUD_PORT and passes the environment through untouched', () => {
    const r = launch('start', { AUD_PORT: '4400', DEEPSEEK_API_KEY: DEEPSEEK }, [
      '--keepAliveTimeout',
      '5',
    ]);
    expect(r.status).toBe(0);
    expect(r.spawned?.args.slice(1)).toEqual([
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4400',
      '--keepAliveTimeout',
      '5',
    ]);
    expect(r.spawned?.env).toEqual({
      AUD_HOST: null,
      AUD_PORT: '4400',
      AUD_DATA_DIR: null,
      AUD_REFRESH_ENABLED: null,
    });
    expect(r.spawned?.credentials['DEEPSEEK_API_KEY']).toBe('set');
  });

  it('ignores development settings, including malformed or colliding ones', () => {
    const settings: Record<string, string>[] = [
      { AUD_DEV_PORT: 'abc', AUD_DEV_DATA_DIR: 'relative', AUD_DEV_LIVE_REFRESH: 'yes' },
      { AUD_DEV_PORT: '3838' },
    ];
    for (const extra of settings) {
      const r = launch('start', extra);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.spawned?.args.slice(1)).toEqual([
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        '3838',
      ]);
      expect(r.spawned?.env['AUD_REFRESH_ENABLED']).toBeNull();
    }
  });
});

describe('npm run dev is isolated from production', () => {
  it('defaults to port 3839, its own data directory, and no credentials', () => {
    const production = join(home, 'production');
    const file = writeEnvFile(
      `AUD_DATA_DIR=${production}\nDEEPSEEK_API_KEY=${DEEPSEEK}\nOPENROUTER_MANAGEMENT_KEY=${OPENROUTER}\n`,
    );
    const r = launch('dev', { AUD_ENV_FILE: file, DEEPSEEK_API_KEY: DEEPSEEK });
    expect(r.status).toBe(0);
    expect(r.spawned?.args.slice(1)).toEqual(['dev', '--hostname', '127.0.0.1', '--port', '3839']);
    expect(r.spawned?.env).toEqual({
      AUD_HOST: null,
      AUD_PORT: '3839',
      AUD_DATA_DIR: join(home, 'share', 'ai-usage-dashboard-dev'),
      AUD_REFRESH_ENABLED: '0',
    });
    expect(r.spawned?.credentials).toEqual({
      DEEPSEEK_API_KEY: 'empty',
      OPENROUTER_MANAGEMENT_KEY: 'empty',
    });
    expect(r.stdout.includes(DEEPSEEK) || r.stderr.includes(DEEPSEEK)).toBe(false);
  });

  it('applies AUD_DEV_PORT, AUD_DEV_DATA_DIR, and the live-refresh opt-in', () => {
    const file = writeEnvFile(`OPENROUTER_MANAGEMENT_KEY=${OPENROUTER}\n`);
    const r = launch(
      'dev',
      {
        AUD_ENV_FILE: file,
        AUD_DEV_PORT: '4500',
        AUD_DEV_DATA_DIR: join(home, 'dev-data'),
        AUD_DEV_LIVE_REFRESH: '1',
        DEEPSEEK_API_KEY: DEEPSEEK,
      },
      ['--turbopack'],
    );
    expect(r.status).toBe(0);
    expect(r.spawned?.args.slice(1)).toEqual([
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4500',
      '--turbopack',
    ]);
    expect(r.spawned?.env).toMatchObject({
      AUD_PORT: '4500',
      AUD_DATA_DIR: join(home, 'dev-data'),
      AUD_REFRESH_ENABLED: '1',
    });
    expect(r.spawned?.credentials).toEqual({
      DEEPSEEK_API_KEY: 'set',
      OPENROUTER_MANAGEMENT_KEY: 'set',
    });
  });

  it('refuses a development port equal to the production port before spawning', () => {
    const fromShell = launch('dev', { AUD_DEV_PORT: '3838' });
    expect(fromShell.status).toBe(2);
    expect(fromShell.stderr).toContain(
      'configuration error: ConfigError: AUD_DEV_PORT 3838 is also the production AUD_PORT',
    );
    expect(fromShell.spawned).toBeNull();

    const fromFile = launch('dev', {
      AUD_ENV_FILE: writeEnvFile('AUD_PORT=4000\n'),
      AUD_DEV_PORT: '4000',
    });
    expect(fromFile.status).toBe(2);
    expect(fromFile.spawned).toBeNull();
  });

  it.each([
    ['AUD_DEV_PORT', 'abc'],
    ['AUD_DEV_DATA_DIR', 'relative/dir'],
    ['AUD_DEV_LIVE_REFRESH', 'yes'],
  ])('exits 2 on an invalid %s without spawning or leaking a credential', (name, value) => {
    const r = launch('dev', { [name]: value, DEEPSEEK_API_KEY: DEEPSEEK });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`^configuration error: ConfigError: ${name}`));
    expect(r.stderr.includes(DEEPSEEK)).toBe(false);
    expect(r.spawned).toBeNull();
  });
});
