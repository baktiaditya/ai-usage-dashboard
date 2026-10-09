import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws outside a React Server bundle.
vi.mock('server-only', () => ({}));
// Wrapped, not replaced: it keeps its real behavior and records whether it ran.
vi.mock('@/lib/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/db')>();
  return { ...actual, db: vi.fn(actual.db) };
});

import { GET } from '@/app/api/settings/credentials/route';
import { DELETE, PUT } from '@/app/api/settings/credentials/[provider]/route';
import { resetConfigCache } from '@/lib/config';
import { closeSharedDb, openDb } from '@/lib/db/client';
import { db } from '@/lib/server/db';

const ORIGIN = 'http://127.0.0.1:3838';
// Fake keys only. The characters are varied so any leaked run of five is detectable.
const SECRET = 'sk-Qz7Wm2Xv9Lp4Rt8Kd5hJ3n1234';
const INVALID_SECRET_MESSAGE = 'Enter the key exactly as issued: printable characters, no spaces.';

const ENV_KEYS = [
  'AUD_DATA_DIR',
  'AUD_PORT',
  'AUD_HOST',
  'AUD_REFRESH_ENABLED',
  'AUD_LOG_LEVEL',
  'AUD_ALLOWED_ORIGINS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-settings-'));
  vi.clearAllMocks();
  configure({ port: '3838' });
});

afterEach(() => {
  closeSharedDb();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

function configure({ port, refresh }: { port: string; refresh?: '0' | '1' }): void {
  process.env['AUD_DATA_DIR'] = dir;
  process.env['AUD_PORT'] = port;
  process.env['AUD_LOG_LEVEL'] = 'warn';
  delete process.env['AUD_HOST'];
  if (refresh === undefined) delete process.env['AUD_REFRESH_ENABLED'];
  else process.env['AUD_REFRESH_ENABLED'] = refresh;
  resetConfigCache();
  closeSharedDb();
}

type Headers = Record<string, string>;
const SAME_ORIGIN: Headers = { origin: ORIGIN };

function context(provider: string) {
  return { params: Promise.resolve({ provider }) };
}

function get(headers: Headers = SAME_ORIGIN) {
  return GET(new NextRequest(`${ORIGIN}/api/settings/credentials`, { headers }));
}

function put(provider: string, body: unknown, headers: Headers = SAME_ORIGIN) {
  return PUT(
    new NextRequest(`${ORIGIN}/api/settings/credentials/${provider}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    context(provider),
  );
}

function del(provider: string, headers: Headers = SAME_ORIGIN) {
  return DELETE(
    new NextRequest(`${ORIGIN}/api/settings/credentials/${provider}`, {
      method: 'DELETE',
      headers,
    }),
    context(provider),
  );
}

async function read(res: Response): Promise<{ status: number; text: string; body: unknown }> {
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

/** True when any five consecutive characters of the secret appear in `text`. */
function leaks(text: string, secret = SECRET): boolean {
  for (let i = 0; i + 5 <= secret.length; i += 1) {
    if (text.includes(secret.slice(i, i + 5))) return true;
  }
  return false;
}

/** Rows as a separate connection sees them, so nothing is read through the route. */
function stored(): unknown[] {
  closeSharedDb();
  const database = openDb({ path: join(dir, 'usage.db') });
  try {
    return database.$client
      .prepare('SELECT provider, secret, updated_at FROM provider_credentials ORDER BY provider')
      .all();
  } finally {
    database.$client.close();
  }
}

const UNSAVED = [
  { provider: 'deepseek', configured: false, hint: null, updatedAt: null },
  { provider: 'openrouter', configured: false, hint: null, updatedAt: null },
  { provider: 'opencode_go', configured: false, hint: null, updatedAt: null },
  { provider: 'claude', configured: false, hint: null, updatedAt: null },
];

describe('GET /api/settings/credentials', () => {
  it('reports every provider unsaved on a fresh database, uncached', async () => {
    const res = await get();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await read(res)).toMatchObject({ status: 200, body: { credentials: UNSAVED } });
  });

  it('reports a saved key by its last four characters only', async () => {
    expect((await put('deepseek', { secret: SECRET })).status).toBe(200);
    const { status, text, body } = await read(await get());

    expect(status).toBe(200);
    expect(body).toEqual({
      credentials: [
        { provider: 'deepseek', configured: true, hint: '1234', updatedAt: expect.any(String) },
        UNSAVED[1],
        UNSAVED[2],
        UNSAVED[3],
      ],
    });
    expect(leaks(text)).toBe(false);
  });
});

describe('PUT /api/settings/credentials/:provider', () => {
  it('saves the trimmed key and answers with its status only', async () => {
    const res = await put('openrouter', { secret: ` ${SECRET}\n` });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { status, text, body } = await read(res);

    expect(status).toBe(200);
    expect(body).toEqual({
      credential: {
        provider: 'openrouter',
        configured: true,
        hint: '1234',
        updatedAt: expect.any(String),
      },
    });
    expect(leaks(text)).toBe(false);
    expect(stored()).toEqual([
      { provider: 'openrouter', secret: SECRET, updated_at: expect.any(String) },
    ]);
  });

  it('shows no hint for a key shorter than 16 characters', async () => {
    const short = 'sk-Qz7Wm2Xv9Lp4';
    expect(short).toHaveLength(15);
    const { status, text, body } = await read(await put('deepseek', { secret: short }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ credential: { configured: true, hint: null } });
    expect(leaks(text, short)).toBe(false);
  });

  it('accepts 512 characters after trimming', async () => {
    expect((await put('deepseek', { secret: `  ${'k'.repeat(512)}\n` })).status).toBe(200);
    expect(stored()).toEqual([
      { provider: 'deepseek', secret: 'k'.repeat(512), updated_at: expect.any(String) },
    ]);
  });

  it('is allowed on a development server whose refresh is disabled', async () => {
    configure({ port: '3839', refresh: '0' });
    const dev = { origin: 'http://127.0.0.1:3839' };
    expect((await put('deepseek', { secret: SECRET }, dev)).status).toBe(200);
    expect((await del('deepseek', dev)).status).toBe(200);
  });

  it('never logs the request body', async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }

    await put('deepseek', { secret: SECRET });
    await put('deepseek', { secret: `${SECRET} inner` });
    vi.mocked(db).mockImplementationOnce(() => {
      throw new Error('simulated failure');
    });
    await put('openrouter', { secret: SECRET });

    expect(leaks(written.join('\n'))).toBe(false);
  });
});

describe('DELETE /api/settings/credentials/:provider', () => {
  it('removes a saved key, and removing it again still answers 200', async () => {
    await put('deepseek', { secret: SECRET });

    const first = await del('deepseek');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await read(first)).toMatchObject({ status: 200, body: { credential: UNSAVED[0] } });
    expect(stored()).toEqual([]);

    expect(await read(await del('deepseek'))).toMatchObject({
      status: 200,
      body: { credential: UNSAVED[0] },
    });
  });
});

describe('same-origin guard', () => {
  it.each([
    ['a foreign Origin', { origin: 'https://evil.example.com' }],
    ['the production origin on another port', { origin: 'http://127.0.0.1:3839' }],
    ['neither Origin nor Sec-Fetch-Site', {}],
    ['a cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site' }],
  ] as const)('answers 403 to %s on every handler and writes nothing', async (_name, headers) => {
    await put('deepseek', { secret: SECRET });
    const before = stored();
    vi.mocked(db).mockClear();

    const responses = [
      await get(headers),
      await put('deepseek', { secret: 'sk-replacement-0000000000000' }, headers),
      await put('openrouter', { secret: 'sk-replacement-0000000000000' }, headers),
      await del('deepseek', headers),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { text, body } = await read(res);
      expect(body).toMatchObject({ error: { code: expect.stringMatching(/origin/) } });
      expect(text).not.toContain('1234');
    }
    // Refused before the database was touched.
    expect(vi.mocked(db)).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
  });

  it('accepts a same-origin fetch that reports Sec-Fetch-Site instead of Origin', async () => {
    expect((await get({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('accepts a configured extra origin on every handler, proving it is not refresh-only', async () => {
    const extra = 'https://dev-box.tail1234.ts.net';
    process.env['AUD_ALLOWED_ORIGINS'] = extra;
    resetConfigCache();
    closeSharedDb();

    const headers = { origin: extra };
    expect((await put('deepseek', { secret: SECRET }, headers)).status).toBe(200);
    expect((await get(headers)).status).toBe(200);
    expect((await del('deepseek', headers)).status).toBe(200);

    // The http:// twin of the configured origin is still refused.
    expect((await get({ origin: 'http://dev-box.tail1234.ts.net' })).status).toBe(403);
  });
});

describe('validation', () => {
  beforeEach(async () => {
    await put('deepseek', { secret: SECRET });
  });

  it('accepts the optional Claude token on PUT and removes it on DELETE', async () => {
    const put1 = await read(await put('claude', { secret: ` ${SECRET}\n` }));
    expect(put1.status).toBe(200);
    expect(put1.body).toMatchObject({ credential: { provider: 'claude', configured: true } });
    expect(leaks(put1.text)).toBe(false);
    expect(stored()).toContainEqual({
      provider: 'claude',
      secret: SECRET,
      updated_at: expect.any(String),
    });

    const deleted = await read(await del('claude'));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ credential: { provider: 'claude', configured: false } });
    expect(stored().some((row) => (row as { provider: string }).provider === 'claude')).toBe(false);
  });

  it.each(['codex', 'Claude', 'not-a-provider'])(
    'refuses provider %s with 400 invalid_provider on PUT and DELETE',
    async (provider) => {
      const before = stored();
      for (const res of [await put(provider, { secret: SECRET }), await del(provider)]) {
        const { status, text, body } = await read(res);
        expect(status).toBe(400);
        expect(body).toMatchObject({ error: { code: 'invalid_provider' } });
        expect(leaks(text)).toBe(false);
      }
      expect(stored()).toEqual(before);
    },
  );

  it.each([
    ['a non-JSON body', 'not json'],
    ['an empty body', ''],
    ['no secret', '{}'],
    ['a numeric secret', '{"secret":5}'],
    ['null', 'null'],
    ['an array', '["sk-array-secret-000000"]'],
    ['a bare string', '"sk-bare-string-secret-00"'],
  ])('refuses %s with 400 invalid_body', async (_name, body) => {
    const before = stored();
    const res = await read(await put('openrouter', body));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_body' } });
    expect(res.text).not.toContain('secret-00');
    expect(stored()).toEqual(before);
  });

  it.each([
    ['blank', ''],
    ['whitespace-only', ' \n\t '],
    ['inner whitespace after trimming', ' sk-Ab3De6 Gh9Jk2Mn5 '],
    ['longer than 512 after trimming', ` ${'k'.repeat(513)} `],
  ])('refuses a %s secret with 400 invalid_secret', async (_name, secret) => {
    const before = stored();
    const res = await read(await put('openrouter', { secret }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'invalid_secret', message: INVALID_SECRET_MESSAGE },
    });
    if (secret.trim().length >= 5) expect(leaks(res.text, secret.trim())).toBe(false);
    expect(stored()).toEqual(before);
  });
});

describe('unexpected failure', () => {
  it('answers 500 settings_failed on each handler without echoing the key', async () => {
    const failing = () => {
      throw new Error(`disk failure while writing ${SECRET}`);
    };

    vi.mocked(db).mockImplementationOnce(failing);
    const saving = await read(await put('deepseek', { secret: SECRET }));
    vi.mocked(db).mockImplementationOnce(failing);
    const listing = await read(await get());
    vi.mocked(db).mockImplementationOnce(failing);
    const removing = await read(await del('deepseek'));

    for (const res of [saving, listing, removing]) {
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: { code: 'settings_failed' } });
      expect(leaks(res.text)).toBe(false);
    }
    expect(stored()).toEqual([]);
  });
});
