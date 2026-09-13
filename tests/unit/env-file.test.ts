import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
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

  it('makes provisioned keys visible to the config, as the systemd unit would', () => {
    mkdirSync(join(dir, 'ai-usage-dashboard'));
    writeFileSync(
      join(dir, 'ai-usage-dashboard', 'collector.env'),
      '# provider keys\nDEEPSEEK_API_KEY=sk-file-deepseek\nOPENROUTER_MANAGEMENT_KEY="sk-or-file"\n',
    );
    const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: dir };

    expect(loadCollectorEnvFile(env)).toBe(join(dir, 'ai-usage-dashboard', 'collector.env'));
    const config = loadConfig(env);
    expect(config.credentials.deepseekApiKey).toBe('sk-file-deepseek');
    expect(config.credentials.openrouterManagementKey).toBe('sk-or-file');
  });

  it('never overrides a variable that is already set', () => {
    const file = join(dir, 'keys.env');
    writeFileSync(file, 'DEEPSEEK_API_KEY=from-file\nAUD_LOG_LEVEL=debug\n');
    const env: Record<string, string | undefined> = {
      AUD_ENV_FILE: file,
      DEEPSEEK_API_KEY: 'from-shell',
    };

    loadCollectorEnvFile(env);
    expect(env['DEEPSEEK_API_KEY']).toBe('from-shell');
    expect(env['AUD_LOG_LEVEL']).toBe('debug');
  });

  it('treats an absent file as the normal pre-provisioning state', () => {
    const env: Record<string, string | undefined> = { AUD_ENV_FILE: join(dir, 'missing.env') };
    expect(loadCollectorEnvFile(env)).toBeNull();
    expect(loadConfig(env).credentials.deepseekApiKey).toBeNull();
  });
});
