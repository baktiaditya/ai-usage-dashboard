import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, retiredCredentialEnvVars } from '@/lib/config';
import { collectorEnvFilePath, loadCollectorEnvFile } from '@/lib/env-file';

describe('collector environment file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aud-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves to the same default path the systemd installer uses', () => {
    expect(collectorEnvFilePath({ XDG_CONFIG_HOME: '/cfg' })).toBe(
      '/cfg/ai-usage-dashboard/collector.env',
    );
    expect(collectorEnvFilePath({ XDG_CONFIG_HOME: '/cfg', AUD_ENV_FILE: '/x/keys.env' })).toBe(
      '/x/keys.env',
    );
  });

  it('requires an absolute AUD_ENV_FILE and ignores a relative XDG_CONFIG_HOME', () => {
    expect(() => collectorEnvFilePath({ AUD_ENV_FILE: 'keys.env' })).toThrow(/absolute/);
    expect(collectorEnvFilePath({ AUD_ENV_FILE: '~/keys.env' })).toBe(join(homedir(), 'keys.env'));
    expect(collectorEnvFilePath({ XDG_CONFIG_HOME: 'relative' })).toBe(
      join(homedir(), '.config', 'ai-usage-dashboard', 'collector.env'),
    );
  });

  it('makes AUD_* settings visible to the config, as the systemd unit would', () => {
    mkdirSync(join(dir, 'ai-usage-dashboard'));
    writeFileSync(
      join(dir, 'ai-usage-dashboard', 'collector.env'),
      '# settings\nAUD_LOG_LEVEL=debug\nAUD_RETENTION_DAYS="30"\n',
    );
    const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: dir };

    expect(loadCollectorEnvFile(env)).toBe(join(dir, 'ai-usage-dashboard', 'collector.env'));
    const config = loadConfig(env);
    expect(config.logLevel).toBe('debug');
    expect(config.retentionDays).toBe(30);
  });

  it('leaves provider keys in the file unused, and only names them', () => {
    const file = join(dir, 'collector.env');
    // Fake keys only.
    writeFileSync(
      file,
      'DEEPSEEK_API_KEY=sk-fake-file-deepseek-0000\nOPENROUTER_MANAGEMENT_KEY="sk-or-fake-file-0000"\n',
    );
    const env: Record<string, string | undefined> = { AUD_ENV_FILE: file };

    loadCollectorEnvFile(env);
    const config = loadConfig(env);
    expect(config).not.toHaveProperty('credentials');
    expect(JSON.stringify(config)).not.toMatch(/sk-(or-)?fake-file/);
    expect(retiredCredentialEnvVars(env)).toEqual([
      'DEEPSEEK_API_KEY',
      'OPENROUTER_MANAGEMENT_KEY',
    ]);
  });

  it('never overrides a variable that is already set', () => {
    const file = join(dir, 'settings.env');
    writeFileSync(file, 'AUD_TIMEZONE=UTC\nAUD_LOG_LEVEL=debug\n');
    const env: Record<string, string | undefined> = {
      AUD_ENV_FILE: file,
      AUD_TIMEZONE: 'Asia/Jakarta',
    };

    loadCollectorEnvFile(env);
    expect(env['AUD_TIMEZONE']).toBe('Asia/Jakarta');
    expect(env['AUD_LOG_LEVEL']).toBe('debug');
  });

  it('treats an absent file as the normal state', () => {
    const env: Record<string, string | undefined> = { AUD_ENV_FILE: join(dir, 'missing.env') };
    expect(loadCollectorEnvFile(env)).toBeNull();
    expect(loadConfig(env).logLevel).toBe('info');
  });
});
