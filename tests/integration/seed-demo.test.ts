import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SEED = join(process.cwd(), 'scripts', 'seed-demo.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aud-seed-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Every default the script could fall back to points inside a throwaway home,
 * so a regression deletes a fake collection rather than the real one.
 */
function seed(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, 'share'),
    XDG_CONFIG_HOME: join(home, 'config'),
    AUD_ENV_FILE: join(home, 'none.env'),
  };
  delete env['AUD_DATA_DIR'];
  Object.assign(env, extra);
  return spawnSync(process.execPath, [TSX, SEED], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe('demo seeding never reaches a real collection', () => {
  it('refuses to run without an exported AUD_DATA_DIR, before opening any database', () => {
    const r = seed();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('export AUD_DATA_DIR');
    // The default database it would otherwise have opened, and wiped, was never created.
    expect(existsSync(join(home, 'share', 'ai-usage-dashboard', 'usage.db'))).toBe(false);
  });

  it('seeds the directory it is explicitly given', () => {
    const dir = join(home, 'scratch');
    const r = seed({ AUD_DATA_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('seeded:');
    expect(existsSync(join(dir, 'usage.db'))).toBe(true);
  });
});
