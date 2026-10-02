import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RETIRED_CREDENTIAL_ENV_VARS } from '@/lib/config';
import { openDb } from '@/lib/db/client';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const COLLECT = join(process.cwd(), 'scripts', 'collect.ts');

// Fake keys only. With no key saved, neither provider is ever contacted.
const SHELL_KEY = 'sk-fake-shell-collect-script-0000';
const FILE_KEY = 'sk-or-fake-file-collect-script-0000';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aud-collect-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * `pnpm run collect` in a throwaway home and data directory, restricted to the
 * two credential providers so no local CLI runs.
 */
function collect(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const retired = (RETIRED_CREDENTIAL_ENV_VARS as readonly string[]).includes(key);
    if (!key.startsWith('AUD_') && !retired) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_DATA_HOME: join(home, 'share'),
    XDG_CONFIG_HOME: join(home, 'config'),
    AUD_DATA_DIR: join(home, 'data'),
    AUD_ENV_FILE: join(home, 'none.env'),
    AUD_LOG_LEVEL: 'info',
    ...extra,
  });
  return spawnSync(process.execPath, [TSX, COLLECT, '--provider=deepseek,openrouter'], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

function logLines(output: string): { level: string; msg: string; variables?: unknown }[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { level: string; msg: string; variables?: unknown });
}

function attempts(): unknown[] {
  const database = openDb({ path: join(home, 'data', 'usage.db') });
  try {
    return database.$client
      .prepare('SELECT provider, outcome, error_code FROM collector_attempts ORDER BY provider')
      .all();
  } finally {
    database.$client.close();
  }
}

describe('pnpm run collect and the retired provider key variables', () => {
  it('warns once by name, prints no value, and still reads keys only from the database', () => {
    const file = join(home, 'collector.env');
    writeFileSync(file, `${RETIRED_CREDENTIAL_ENV_VARS[1]}=${FILE_KEY}\n`, { mode: 0o600 });
    const r = collect({ AUD_ENV_FILE: file, [RETIRED_CREDENTIAL_ENV_VARS[0]]: SHELL_KEY });

    expect(r.status).toBe(0);
    const warnings = logLines(r.stderr).filter((line) => line.level === 'warn');
    expect(warnings).toEqual([
      expect.objectContaining({
        msg: 'provider key environment variables are ignored; save keys in dashboard Settings',
        variables: [...RETIRED_CREDENTIAL_ENV_VARS],
      }),
    ]);

    const output = `${r.stdout}\n${r.stderr}`;
    for (const key of [SHELL_KEY, FILE_KEY]) {
      expect(output.includes(key.slice(0, -4))).toBe(false);
    }
    expect(attempts()).toEqual([
      { provider: 'deepseek', outcome: 'unavailable', error_code: 'not_configured' },
      { provider: 'openrouter', outcome: 'unavailable', error_code: 'not_configured' },
    ]);
  });

  it('logs no warning when neither variable is set, or one is blank', () => {
    const variants: Record<string, string>[] = [{}, { [RETIRED_CREDENTIAL_ENV_VARS[0]]: '  ' }];
    for (const extra of variants) {
      const r = collect(extra);
      expect(r.status).toBe(0);
      expect(logLines(r.stderr).filter((line) => line.level === 'warn')).toEqual([]);
    }
  });
});
