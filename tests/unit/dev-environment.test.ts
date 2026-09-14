import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@/lib/config';
import type { EnvLike } from '@/lib/config';
import { resolveDevEnvironment } from '@/lib/dev-environment';

// Fake credentials. Assertions compare only unset/empty/set state, so a failure
// message never carries a credential.
const DEEPSEEK = 'sk-fake-deepseek-dev-environment';
const OPENROUTER = 'sk-or-fake-dev-environment';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-dev-env-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An environment whose every default and credential file lands in the temp directory. */
function base(extra: EnvLike = {}): EnvLike {
  return {
    XDG_DATA_HOME: join(dir, 'share'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    AUD_ENV_FILE: join(dir, 'none.env'),
    ...extra,
  };
}

function writeEnvFile(contents: string): string {
  const path = join(dir, 'collector.env');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

const state = (value: string | undefined) =>
  value === undefined ? 'unset' : value === '' ? 'empty' : 'set';

function configError(resolve: () => unknown): string {
  try {
    resolve();
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('development defaults', () => {
  it('binds loopback port 3839 with its own data directory and refresh disabled', () => {
    const dev = resolveDevEnvironment(base());
    const dataDir = join(dir, 'share', 'ai-usage-dashboard-dev');
    expect(dev).toMatchObject({
      host: '127.0.0.1',
      port: 3839,
      productionPort: 3838,
      dataDir,
      liveRefresh: false,
    });
    expect(dev.env['AUD_PORT']).toBe('3839');
    expect(dev.env['AUD_DATA_DIR']).toBe(dataDir);
    expect(dev.env['AUD_REFRESH_ENABLED']).toBe('0');

    // The child's own configuration agrees with what the launcher decided.
    const child = loadConfig(dev.env);
    expect(child.port).toBe(3839);
    expect(child.databasePath).toBe(join(dataDir, 'usage.db'));
    expect(child.refreshEnabled).toBe(false);
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset or relative', () => {
    const fallback = join(homedir(), '.local', 'share', 'ai-usage-dashboard-dev');
    expect(resolveDevEnvironment(base({ XDG_DATA_HOME: undefined })).dataDir).toBe(fallback);
    expect(resolveDevEnvironment(base({ XDG_DATA_HOME: 'relative/share' })).dataDir).toBe(fallback);
  });

  it('never derives the development directory from the production AUD_DATA_DIR', () => {
    const expected = join(dir, 'share', 'ai-usage-dashboard-dev');
    const production = join(dir, 'production');

    const fromShell = resolveDevEnvironment(base({ AUD_DATA_DIR: production }));
    expect(fromShell.dataDir).toBe(expected);
    expect(fromShell.env['AUD_DATA_DIR']).toBe(expected);

    const fromFile = resolveDevEnvironment(
      base({ AUD_ENV_FILE: writeEnvFile(`AUD_DATA_DIR=${production}\n`) }),
    );
    expect(fromFile.dataDir).toBe(expected);
    expect(loadConfig(fromFile.env).dataDir).toBe(expected);
  });

  it('does not mutate the environment it is given', () => {
    const source = base({
      AUD_ENV_FILE: writeEnvFile(`AUD_PORT=4000\nDEEPSEEK_API_KEY=${DEEPSEEK}\n`),
      AUD_DEV_PORT: '4100',
    });
    const before = { ...source };
    resolveDevEnvironment(source);
    expect(source).toEqual(before);
    expect('DEEPSEEK_API_KEY' in source).toBe(false);
  });
});

describe('environment-file precedence', () => {
  it('reads the production port from collector.env and lets the parent win', () => {
    const file = writeEnvFile('AUD_PORT=4000\n');
    expect(resolveDevEnvironment(base({ AUD_ENV_FILE: file })).productionPort).toBe(4000);
    expect(
      resolveDevEnvironment(base({ AUD_ENV_FILE: file, AUD_PORT: '4001' })).productionPort,
    ).toBe(4001);
  });

  it('honours AUD_DEV_PORT from collector.env, with the parent still winning', () => {
    const file = writeEnvFile('AUD_DEV_PORT=4200\n');
    expect(resolveDevEnvironment(base({ AUD_ENV_FILE: file })).port).toBe(4200);
    expect(resolveDevEnvironment(base({ AUD_ENV_FILE: file, AUD_DEV_PORT: '4201' })).port).toBe(
      4201,
    );
  });
});

describe('credential isolation', () => {
  it('gives the default child empty credentials from the parent shell', () => {
    const dev = resolveDevEnvironment(
      base({ DEEPSEEK_API_KEY: DEEPSEEK, OPENROUTER_MANAGEMENT_KEY: OPENROUTER }),
    );
    expect(state(dev.env['DEEPSEEK_API_KEY'])).toBe('empty');
    expect(state(dev.env['OPENROUTER_MANAGEMENT_KEY'])).toBe('empty');
  });

  it('gives the default child empty credentials from collector.env', () => {
    const file = writeEnvFile(
      `DEEPSEEK_API_KEY=${DEEPSEEK}\nOPENROUTER_MANAGEMENT_KEY=${OPENROUTER}\n`,
    );
    const dev = resolveDevEnvironment(base({ AUD_ENV_FILE: file }));
    expect(state(dev.env['DEEPSEEK_API_KEY'])).toBe('empty');
    expect(state(dev.env['OPENROUTER_MANAGEMENT_KEY'])).toBe('empty');
    const child = loadConfig(dev.env);
    expect(child.credentials.deepseekApiKey === null).toBe(true);
    expect(child.credentials.openrouterManagementKey === null).toBe(true);
  });

  it('preserves resolved credentials when live refresh is opted into', () => {
    const file = writeEnvFile(`OPENROUTER_MANAGEMENT_KEY=${OPENROUTER}\nDEEPSEEK_API_KEY=other\n`);
    const dev = resolveDevEnvironment(
      base({ AUD_ENV_FILE: file, AUD_DEV_LIVE_REFRESH: '1', DEEPSEEK_API_KEY: DEEPSEEK }),
    );
    expect(dev.liveRefresh).toBe(true);
    expect(dev.env['AUD_REFRESH_ENABLED']).toBe('1');
    expect(state(dev.env['OPENROUTER_MANAGEMENT_KEY'])).toBe('set');
    // The parent's value wins over the file's, as everywhere else.
    expect(dev.env['DEEPSEEK_API_KEY'] === DEEPSEEK).toBe(true);
    expect(loadConfig(dev.env).refreshEnabled).toBe(true);
  });

  it('decides the refresh flag itself, whatever the parent exported', () => {
    expect(
      resolveDevEnvironment(base({ AUD_REFRESH_ENABLED: '1' })).env['AUD_REFRESH_ENABLED'],
    ).toBe('0');
    expect(
      resolveDevEnvironment(base({ AUD_REFRESH_ENABLED: '0', AUD_DEV_LIVE_REFRESH: '1' })).env[
        'AUD_REFRESH_ENABLED'
      ],
    ).toBe('1');
  });
});

describe('validation', () => {
  it('accepts an AUD_DEV_PORT override and treats a blank one as unset', () => {
    expect(resolveDevEnvironment(base({ AUD_DEV_PORT: '4100' })).port).toBe(4100);
    expect(resolveDevEnvironment(base({ AUD_DEV_PORT: '' })).port).toBe(3839);
  });

  it.each(['abc', '0', '65536', '3.5', '-1', '0x10', '3839abc'])(
    'rejects AUD_DEV_PORT=%s',
    (value) => {
      expect(configError(() => resolveDevEnvironment(base({ AUD_DEV_PORT: value })))).toMatch(
        /^AUD_DEV_PORT must be an integer/,
      );
    },
  );

  it('refuses a development port equal to the resolved production port', () => {
    expect(configError(() => resolveDevEnvironment(base({ AUD_DEV_PORT: '3838' })))).toMatch(
      /AUD_DEV_PORT 3838 is also the production AUD_PORT/,
    );
    expect(
      configError(() => resolveDevEnvironment(base({ AUD_PORT: '4000', AUD_DEV_PORT: '4000' }))),
    ).toMatch(/AUD_DEV_PORT 4000/);
    // A production port moved onto the development default collides too.
    const file = writeEnvFile('AUD_PORT=3839\n');
    expect(configError(() => resolveDevEnvironment(base({ AUD_ENV_FILE: file })))).toMatch(
      /AUD_DEV_PORT 3839/,
    );
  });

  it('requires AUD_DEV_DATA_DIR to be absolute or start with ~/', () => {
    expect(resolveDevEnvironment(base({ AUD_DEV_DATA_DIR: '/srv/aud-dev' })).dataDir).toBe(
      '/srv/aud-dev',
    );
    expect(resolveDevEnvironment(base({ AUD_DEV_DATA_DIR: '~/aud-dev' })).dataDir).toBe(
      join(homedir(), 'aud-dev'),
    );
    expect(configError(() => resolveDevEnvironment(base({ AUD_DEV_DATA_DIR: 'aud-dev' })))).toMatch(
      /AUD_DEV_DATA_DIR must be an absolute path/,
    );
  });

  it('refuses a development data directory that is the production one', () => {
    const production = join(dir, 'production');
    const refused = /AUD_DEV_DATA_DIR ".*" is also the production data directory/;

    // Named in the shell, in collector.env, or with a trailing slash.
    expect(
      configError(() =>
        resolveDevEnvironment(base({ AUD_DATA_DIR: production, AUD_DEV_DATA_DIR: production })),
      ),
    ).toMatch(refused);
    const file = writeEnvFile(`AUD_DATA_DIR=${production}\n`);
    expect(
      configError(() =>
        resolveDevEnvironment(base({ AUD_ENV_FILE: file, AUD_DEV_DATA_DIR: `${production}/` })),
      ),
    ).toMatch(refused);

    // A symlink to the production directory is the same directory.
    mkdirSync(production);
    const alias = join(dir, 'alias');
    symlinkSync(production, alias);
    expect(
      configError(() =>
        resolveDevEnvironment(base({ AUD_DATA_DIR: production, AUD_DEV_DATA_DIR: alias })),
      ),
    ).toMatch(refused);

    // A production directory moved onto the development default collides too.
    expect(
      configError(() =>
        resolveDevEnvironment(base({ AUD_DATA_DIR: join(dir, 'share', 'ai-usage-dashboard-dev') })),
      ),
    ).toMatch(refused);
  });

  it('accepts only 0 or 1 for AUD_DEV_LIVE_REFRESH, and rejects a blank value', () => {
    expect(resolveDevEnvironment(base({ AUD_DEV_LIVE_REFRESH: '0' })).liveRefresh).toBe(false);
    expect(resolveDevEnvironment(base({ AUD_DEV_LIVE_REFRESH: '1' })).liveRefresh).toBe(true);
    expect(resolveDevEnvironment(base()).liveRefresh).toBe(false);
    for (const value of ['', 'yes', 'true', '2', ' 1', 'on']) {
      expect(
        configError(() => resolveDevEnvironment(base({ AUD_DEV_LIVE_REFRESH: value }))),
        value,
      ).toBe('AUD_DEV_LIVE_REFRESH must be 0 or 1');
    }
  });

  it('still validates the production configuration it derives from', () => {
    expect(configError(() => resolveDevEnvironment(base({ AUD_HOST: '0.0.0.0' })))).toMatch(
      /AUD_HOST must stay on loopback/,
    );
  });

  it('never puts a credential in a configuration error', () => {
    const file = writeEnvFile(`OPENROUTER_MANAGEMENT_KEY=${OPENROUTER}\n`);
    for (const invalid of [
      { AUD_DEV_PORT: 'abc' },
      { AUD_DEV_PORT: '3838' },
      { AUD_DEV_DATA_DIR: 'relative' },
      { AUD_DATA_DIR: join(dir, 'production'), AUD_DEV_DATA_DIR: join(dir, 'production') },
      { AUD_DEV_LIVE_REFRESH: 'yes' },
      { AUD_THRESHOLDS: '{' },
    ]) {
      const message = configError(() =>
        resolveDevEnvironment(base({ AUD_ENV_FILE: file, DEEPSEEK_API_KEY: DEEPSEEK, ...invalid })),
      );
      expect(message.includes(DEEPSEEK) || message.includes(OPENROUTER)).toBe(false);
    }
  });
});
