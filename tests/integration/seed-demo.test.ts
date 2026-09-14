import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@/lib/db/client';
import { startRun } from '@/lib/db/repository';
import { collectorRuns } from '@/lib/db/schema';

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
function seed(args: string[] = [], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, 'share'),
    XDG_CONFIG_HOME: join(home, 'config'),
    AUD_ENV_FILE: join(home, 'none.env'),
  };
  for (const key of ['AUD_DATA_DIR', 'AUD_PORT', 'AUD_DEV_PORT', 'AUD_DEV_DATA_DIR']) {
    delete env[key];
  }
  Object.assign(env, extra);
  return spawnSync(process.execPath, [TSX, SEED, ...args], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

const DEV_DB = () => join(home, 'share', 'ai-usage-dashboard-dev', 'usage.db');

/** A production database with one collected run, standing in for real history. */
function productionSentinel(): { dir: string; snapshot: () => Map<string, Buffer> } {
  const dir = join(home, 'production');
  const database = openDb({ path: join(dir, 'usage.db') });
  startRun(database, 'scheduled');
  database.$client.close();
  const snapshot = () =>
    new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]));
  return { dir, snapshot };
}

function expectUnchanged(before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [name, bytes] of before) {
    // Compared, not printed: a mismatch reports the file name only.
    expect(Buffer.compare(bytes, after.get(name) as Buffer), name).toBe(0);
  }
}

function runCount(path: string): number {
  const database = openDb({ path });
  try {
    return database.select().from(collectorRuns).all().length;
  } finally {
    database.$client.close();
  }
}

describe('demo seeding never reaches a real collection', () => {
  it('refuses to run without an exported AUD_DATA_DIR, before opening any database', () => {
    const r = seed();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('export AUD_DATA_DIR');
    // The default database it would otherwise have opened, and wiped, was never created.
    expect(existsSync(join(home, 'share', 'ai-usage-dashboard', 'usage.db'))).toBe(false);
  });

  it('refuses without --dev even when collector.env names the production directory', () => {
    const production = productionSentinel();
    const before = production.snapshot();
    const envFile = join(home, 'collector.env');
    writeFileSync(envFile, `AUD_DATA_DIR=${production.dir}\n`, { mode: 0o600 });

    const r = seed([], { AUD_ENV_FILE: envFile });
    expect(r.status).toBe(2);
    expectUnchanged(before, production.snapshot());
  });

  it('seeds the directory it is explicitly given', () => {
    const dir = join(home, 'scratch');
    const r = seed([], { AUD_DATA_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('seeded:');
    expect(existsSync(join(dir, 'usage.db'))).toBe(true);
  });

  it.each([['--prod'], ['dev'], ['--dev', '--dev'], ['--dev=1']])(
    'rejects the argument list %s before opening any database',
    (...args) => {
      const r = seed(args, { AUD_DATA_DIR: join(home, 'scratch') });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('usage: tsx scripts/seed-demo.ts [--dev]');
      expect(existsSync(join(home, 'scratch'))).toBe(false);
      expect(existsSync(DEV_DB())).toBe(false);
    },
  );
});

describe('seed:dev targets only the development database', () => {
  it('is wired to the --dev flag', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['seed:dev']).toBe('tsx scripts/seed-demo.ts --dev');
  });

  it.each(['collector.env', 'the parent shell'])(
    'leaves a production database named in %s byte-for-byte unchanged',
    (source) => {
      const production = productionSentinel();
      const before = production.snapshot();
      const envFile = join(home, 'collector.env');
      writeFileSync(envFile, `AUD_DATA_DIR=${production.dir}\n`, { mode: 0o600 });
      const extra: Record<string, string> =
        source === 'collector.env' ? { AUD_ENV_FILE: envFile } : { AUD_DATA_DIR: production.dir };

      const r = seed(['--dev'], extra);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(runCount(DEV_DB())).toBeGreaterThan(1);
      expectUnchanged(before, production.snapshot());
    },
  );

  it('honours AUD_DEV_DATA_DIR', () => {
    const dir = join(home, 'dev-data');
    const r = seed(['--dev'], { AUD_DEV_DATA_DIR: dir });
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, 'usage.db'))).toBe(true);
    expect(existsSync(DEV_DB())).toBe(false);
  });

  it('exits 2 on an invalid development setting before opening any database', () => {
    const r = seed(['--dev'], { AUD_DEV_PORT: '3838' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('configuration error: ConfigError: AUD_DEV_PORT 3838');
    expect(existsSync(DEV_DB())).toBe(false);
  });
});
