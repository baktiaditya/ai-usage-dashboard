import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws outside a React Server bundle.
vi.mock('server-only', () => ({}));
// Wrapped, not replaced: each keeps its real behavior and records whether it ran.
vi.mock('@/lib/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/db')>();
  return { ...actual, db: vi.fn(actual.db) };
});
vi.mock('@/lib/collector/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/collector/index')>();
  return { ...actual, collectOnce: vi.fn(actual.collectOnce) };
});
vi.mock('@/lib/adapters/deepseek', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters/deepseek')>();
  return { ...actual, createDeepseekAdapter: vi.fn(actual.createDeepseekAdapter) };
});
vi.mock('@/lib/adapters/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters/openrouter')>();
  return { ...actual, createOpenrouterAdapter: vi.fn(actual.createOpenrouterAdapter) };
});
// Codex needs no credential, so a real adapter could spawn `codex app-server`.
vi.mock('@/lib/adapters/codex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters/codex')>();
  return {
    ...actual,
    createCodexAdapter: vi.fn(() => ({
      provider: 'codex' as const,
      schemaVersion: 1,
      timeoutMs: 100,
      async collect(): Promise<never> {
        throw new Error('codex must not run in this suite');
      },
    })),
  };
});

import { POST } from '@/app/api/providers/[provider]/refresh/route';
import { createCodexAdapter } from '@/lib/adapters/codex';
import { createDeepseekAdapter } from '@/lib/adapters/deepseek';
import { createOpenrouterAdapter } from '@/lib/adapters/openrouter';
import { collectOnce } from '@/lib/collector/index';
import { resetConfigCache } from '@/lib/config';
import { closeSharedDb, openDb } from '@/lib/db/client';
import { collectorAttempts, collectorRuns } from '@/lib/db/schema';
import { db } from '@/lib/server/db';
import { refreshLimiter } from '@/lib/server/security';

const DEV_ORIGIN = 'http://127.0.0.1:3839';
const ENV_KEYS = [
  'AUD_DATA_DIR',
  'AUD_PORT',
  'AUD_HOST',
  'AUD_REFRESH_ENABLED',
  'AUD_LOG_LEVEL',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let dir: string;
let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-refresh-'));
  vi.clearAllMocks();
  refreshLimiter.reset();
  upstream = vi.fn(async () => {
    throw new Error('no network in this suite');
  });
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  closeSharedDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

/** The environment a development child receives: port 3839 and a scratch data directory. */
function configure(refreshEnabled: '0' | '1' | undefined): void {
  process.env['AUD_DATA_DIR'] = dir;
  process.env['AUD_PORT'] = '3839';
  process.env['AUD_LOG_LEVEL'] = 'warn';
  delete process.env['AUD_HOST'];
  if (refreshEnabled === undefined) delete process.env['AUD_REFRESH_ENABLED'];
  else process.env['AUD_REFRESH_ENABLED'] = refreshEnabled;
  resetConfigCache();
  closeSharedDb();
}

function refresh(provider: string, origin = DEV_ORIGIN) {
  const request = new NextRequest(`${DEV_ORIGIN}/api/providers/${provider}/refresh`, {
    method: 'POST',
    headers: { origin },
  });
  return POST(request, { params: Promise.resolve({ provider }) });
}

function persisted(path: string): { runs: number; attempts: number } {
  const database = openDb({ path });
  try {
    return {
      runs: database.select().from(collectorRuns).all().length,
      attempts: database.select().from(collectorAttempts).all().length,
    };
  } finally {
    database.$client.close();
  }
}

describe('refresh disabled (the default development server)', () => {
  it('returns 409 refresh_disabled before the limiter, database, adapters, or upstream', async () => {
    configure('0');
    const check = vi.spyOn(refreshLimiter, 'check');

    // More requests than the limiter allows: a spent slot would surface as a 429.
    for (let i = 0; i < 8; i += 1) {
      const res = await refresh('deepseek');
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: { code: 'refresh_disabled', message: expect.stringContaining('disabled') },
      });
    }

    expect(check).not.toHaveBeenCalled();
    expect(vi.mocked(db)).not.toHaveBeenCalled();
    expect(vi.mocked(collectOnce)).not.toHaveBeenCalled();
    expect(vi.mocked(createCodexAdapter)).not.toHaveBeenCalled();
    expect(vi.mocked(createDeepseekAdapter)).not.toHaveBeenCalled();
    expect(vi.mocked(createOpenrouterAdapter)).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    // Opening the database would have created it.
    expect(existsSync(join(dir, 'usage.db'))).toBe(false);

    // Every slot is still available.
    check.mockRestore();
    for (let i = 0; i < 6; i += 1) expect(refreshLimiter.check('deepseek')).toBeNull();
  });

  it('writes no run or attempt to an existing development database', async () => {
    const path = join(dir, 'usage.db');
    openDb({ path }).$client.close();
    configure('0');

    for (const provider of ['codex', 'claude', 'deepseek', 'openrouter']) {
      expect((await refresh(provider)).status).toBe(409);
    }
    expect(persisted(path)).toEqual({ runs: 0, attempts: 0 });
  });

  it('still checks the origin and the provider first', async () => {
    configure('0');
    // The production origin is cross-origin to a development server.
    expect((await refresh('deepseek', 'http://127.0.0.1:3838')).status).toBe(403);
    expect((await refresh('not-a-provider')).status).toBe(400);
    expect(existsSync(join(dir, 'usage.db'))).toBe(false);
  });
});

describe('refresh enabled (production, or AUD_DEV_LIVE_REFRESH=1)', () => {
  it.each([['1'], [undefined]] as const)(
    'runs the existing refresh path with AUD_REFRESH_ENABLED=%s',
    async (flag) => {
      configure(flag);
      const check = vi.spyOn(refreshLimiter, 'check');

      const res = await refresh('deepseek');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider: string; summary: { attempts: unknown[] } };
      expect(body.provider).toBe('deepseek');
      expect(body.summary.attempts).toHaveLength(1);

      expect(check).toHaveBeenCalledTimes(1);
      expect(vi.mocked(collectOnce)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createDeepseekAdapter)).toHaveBeenCalled();
      // No DeepSeek key in this suite, so the adapter never reaches the network.
      expect(upstream).not.toHaveBeenCalled();

      closeSharedDb();
      expect(persisted(join(dir, 'usage.db'))).toEqual({ runs: 1, attempts: 1 });
    },
  );
});
