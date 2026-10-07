import { describe, expect, it } from 'vitest';
import { unitInputsFromEnv } from '@/lib/unit-values';

const FULL = {
  AUD_UNIT_WORKDIR: '/srv/checkout',
  AUD_UNIT_PATH: '/usr/bin:/bin',
  AUD_UNIT_CODEXHOME: '/home/example/.codex',
  AUD_UNIT_NODE: '/usr/bin/node',
  AUD_UNIT_TSX: '/srv/checkout/node_modules/.bin/tsx',
};

describe('unitInputsFromEnv', () => {
  it('reads the five interpreter paths an installer exports', () => {
    const env = { ...FULL };
    expect(unitInputsFromEnv(env, 'scripts/install-systemd.sh')).toEqual({
      env,
      workdir: '/srv/checkout',
      path: '/usr/bin:/bin',
      codexHome: '/home/example/.codex',
      node: '/usr/bin/node',
      tsx: '/srv/checkout/node_modules/.bin/tsx',
    });
  });

  it('names the missing variable and the installer that sets it', () => {
    for (const name of Object.keys(FULL)) {
      const env = { ...FULL, [name]: '' };
      expect(() => unitInputsFromEnv(env, 'scripts/install-launchd.sh')).toThrow(
        `${name} is not set; run scripts/install-launchd.sh instead`,
      );
    }
  });
});
