import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLER = join(process.cwd(), 'scripts', 'install-claude-statusline.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;
let claudeDir: string;
let settings: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aud-installer-'));
  claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  settings = join(claudeDir, 'settings.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX, INSTALLER, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeDir,
        AUD_DATA_DIR: join(home, 'data'),
      },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settings, 'utf8'));
}

describe('the installer never destroys existing configuration', () => {
  it('does nothing without --apply', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY RUN');
    expect(existsSync(settings)).toBe(false);
  });

  it('fails closed when a foreign status line is already configured', () => {
    writeFileSync(
      settings,
      JSON.stringify(
        { statusLine: { type: 'command', command: 'my-own-script.sh' }, model: 'opus' },
        null,
        2,
      ),
    );

    const r = run(['--apply']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('will not overwrite');
    expect(r.stderr).toContain('--wrap-existing');

    // The existing configuration is byte-for-byte untouched.
    expect(readSettings()['statusLine']).toEqual({ type: 'command', command: 'my-own-script.sh' });
  });

  it('composes with the existing command when explicitly told to', () => {
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: 'command', command: 'my-own-script.sh' } }),
    );

    const r = run(['--apply', '--wrap-existing']);
    expect(r.status).toBe(0);

    const installed = readSettings()['statusLine'] as { command: string };
    expect(installed.command).toContain('claude-statusline-bridge.mjs');
    // The previous command is preserved, delegated to at render time.
    expect(installed.command).toContain('AUD_WRAPPED_CMD=');
    expect(installed.command).toContain('my-own-script.sh');
  });

  it('preserves every unrelated setting', () => {
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash'] },
        hooks: { PreToolUse: [] },
      }),
    );

    run(['--apply']);
    const after = readSettings();
    expect(after['model']).toBe('opus');
    expect(after['permissions']).toEqual({ allow: ['Bash'] });
    expect(after['hooks']).toEqual({ PreToolUse: [] });
    expect(after['statusLine']).toBeDefined();
  });

  it('backs up the previous settings before writing', () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }));
    run(['--apply']);
    const backups = readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.backup-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(claudeDir, backups[0]!), 'utf8'))).toEqual({
      model: 'opus',
    });
  });

  it('writes settings with restrictive permissions', () => {
    run(['--apply']);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
  });

  it('refuses to touch a settings file it cannot parse', () => {
    writeFileSync(settings, '{ this is not json');
    const r = run(['--apply']);
    expect(r.status).toBe(2);
    expect(readFileSync(settings, 'utf8')).toBe('{ this is not json');
  });

  it('installs into an empty configuration with absolute paths', () => {
    const r = run(['--apply']);
    expect(r.status).toBe(0);
    const installed = readSettings()['statusLine'] as { type: string; command: string };
    expect(installed.type).toBe('command');
    // Claude runs the status line from the session cwd, so nothing may be relative.
    expect(installed.command).toContain(process.cwd());
    expect(installed.command).toContain('AUD_SPOOL_PATH=');
  });

  it('refreshes its own installation without demanding --wrap-existing', () => {
    run(['--apply']);
    const second = run(['--apply']);
    expect(second.status).toBe(0);
  });

  it('prints a snippet without writing anything', () => {
    const r = run(['--print']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty('statusLine.command');
    expect(existsSync(settings)).toBe(false);
  });

  it('refuses to uninstall a status line it did not install', () => {
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: 'command', command: 'someone-elses.sh' } }),
    );
    const r = run(['--uninstall', '--apply']);
    expect(r.status).toBe(1);
    expect(readSettings()['statusLine']).toEqual({ type: 'command', command: 'someone-elses.sh' });
  });

  it('removes only its own installation on uninstall', () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }));
    run(['--apply']);
    const r = run(['--uninstall', '--apply']);
    expect(r.status).toBe(0);
    const after = readSettings();
    expect(after['statusLine']).toBeUndefined();
    expect(after['model']).toBe('opus');
  });
});
