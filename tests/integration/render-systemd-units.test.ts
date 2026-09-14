import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RENDER = join(process.cwd(), 'scripts', 'render-systemd-units.ts');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-units-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Render the units as scripts/install-systemd.sh does, with `extra` exported in its shell. */
function render(extra: Record<string, string>, envFile = join(dir, 'none.env')) {
  const out = join(dir, 'units');
  mkdirSync(out, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    XDG_DATA_HOME: join(dir, 'share'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    AUD_ENV_FILE: envFile,
    AUD_DATA_DIR: join(dir, 'data'),
    AUD_UNIT_WORKDIR: process.cwd(),
    AUD_UNIT_PATH: '/usr/bin:/bin',
    AUD_UNIT_CODEXHOME: join(dir, '.codex'),
    AUD_UNIT_NODE: process.execPath,
    AUD_UNIT_TSX: TSX,
  };
  // The suite itself may run with a host or port exported.
  delete env['AUD_HOST'];
  delete env['AUD_PORT'];
  const r = spawnSync(process.execPath, [TSX, RENDER, out], {
    encoding: 'utf8',
    env: { ...env, ...extra } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  const unit = (name: string) => readFileSync(join(out, name), 'utf8');
  return { ...r, unit, reported: r.stdout.trim().split('\n') };
}

describe('render-systemd-units', () => {
  it('bakes a host and port exported only in the shell into the web unit it reports', () => {
    // The review reproduction: the installer reported 4444, the service bound 3838.
    const r = render({ AUD_HOST: 'localhost', AUD_PORT: '4444' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.reported.slice(3)).toEqual(['localhost', '4444']);

    const web = r.unit('ai-usage-dashboard-web.service');
    expect(web).toContain('Environment=AUD_HOST=localhost');
    expect(web).toContain('Environment=AUD_PORT=4444');
    expect(r.unit('ai-usage-dashboard-collector.service')).not.toMatch(/AUD_(HOST|PORT)/);
  });

  it('takes them from collector.env when the shell sets neither, and lets the shell win', () => {
    const envFile = join(dir, 'collector.env');
    writeFileSync(envFile, 'AUD_PORT=4555\n', { mode: 0o600 });

    const fromFile = render({}, envFile);
    expect(fromFile.status).toBe(0);
    expect(fromFile.unit('ai-usage-dashboard-web.service')).toContain('Environment=AUD_PORT=4555');
    expect(fromFile.unit('ai-usage-dashboard-web.service')).toContain(
      'Environment=AUD_HOST=127.0.0.1',
    );

    const fromShell = render({ AUD_PORT: '4666' }, envFile);
    expect(fromShell.status).toBe(0);
    expect(fromShell.reported[4]).toBe('4666');
    expect(fromShell.unit('ai-usage-dashboard-web.service')).toContain('Environment=AUD_PORT=4666');
  });

  it('ignores development launcher settings, however malformed', () => {
    const r = render({
      AUD_DEV_PORT: 'abc',
      AUD_DEV_DATA_DIR: 'relative',
      AUD_DEV_LIVE_REFRESH: 'yes',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const web = r.unit('ai-usage-dashboard-web.service');
    expect(web).toContain('Environment=AUD_PORT=3838');
    for (const unit of [web, r.unit('ai-usage-dashboard-collector.service')]) {
      expect(unit).not.toMatch(/AUD_DEV_|AUD_REFRESH_ENABLED/);
    }
  });
});
