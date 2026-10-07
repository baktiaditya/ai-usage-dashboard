import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COLLECTOR_DEADLINE_MS, runCollectorCli } from '@/lib/collector/cli';
import { resetConfigCache } from '@/lib/config';
import type { ProviderAdapter } from '@/lib/domain';

const AUD_KEYS = ['AUD_DATA_DIR', 'AUD_ENV_FILE', 'AUD_HOST', 'AUD_PORT', 'AUD_LOG_LEVEL'] as const;

let dir: string | undefined;
let saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of AUD_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved = {};
  resetConfigCache();
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function isolate(extra: Record<string, string>): void {
  dir = mkdtempSync(join(tmpdir(), 'aud-collect-deadline-'));
  for (const key of AUD_KEYS) saved[key] = process.env[key];
  process.env.AUD_DATA_DIR = join(dir, 'data');
  process.env.AUD_ENV_FILE = join(dir, 'none.env');
  process.env.AUD_LOG_LEVEL = 'error';
  delete process.env.AUD_HOST;
  delete process.env.AUD_PORT;
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  resetConfigCache();
}

describe('collector whole-run deadline', () => {
  it('keeps the production deadline at 120 seconds', () => {
    expect(COLLECTOR_DEADLINE_MS).toBe(120_000);
  });

  it('exits non-zero at its deadline when an injected adapter never settles', async () => {
    isolate({});
    const exits: number[] = [];
    let stderr = '';
    let adapterFinished = false;

    // Settles only long after the shortened deadline, like a hung provider.
    const hangingAdapter: ProviderAdapter = {
      provider: 'codex',
      schemaVersion: 1,
      timeoutMs: 60_000,
      collect: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            adapterFinished = true;
            reject(new Error('test adapter finished long after the deadline'));
          }, 1_500);
        }),
    };

    const started = Date.now();
    const code = await runCollectorCli({
      argv: ['--provider=codex'],
      adapters: [hangingAdapter],
      deadlineMs: 300,
      exit: (exitCode) => {
        exits.push(exitCode);
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });
    const elapsed = Date.now() - started;

    expect(code).toBe(2);
    expect(exits).toEqual([2]);
    expect(stderr).toMatch(/300ms deadline/);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);

    // Let the abandoned adapter finish so its database handle closes.
    while (!adapterFinished) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 10_000);
});
