import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialHint,
  credentialSecretSchema,
  listCredentialStatus,
  readProviderCredentials,
  removeProviderCredential,
  saveProviderCredential,
} from '@/lib/db/credentials';
import { createTestDb } from '../helpers/db';
import type { TestDb } from '../helpers/db';

// Fake keys only.
const DEEPSEEK_KEY = 'sk-fake-deepseek-0000000abcd';
const OPENROUTER_KEY = 'sk-or-fake-openrouter-000wxyz';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
});
afterEach(() => {
  t.cleanup();
});

function rows(): unknown[] {
  return t.db.$client
    .prepare('SELECT provider, secret, updated_at FROM provider_credentials ORDER BY provider')
    .all();
}

describe('saving and reading', () => {
  it('starts with no key saved', () => {
    expect(readProviderCredentials(t.db)).toEqual({
      deepseekApiKey: null,
      openrouterManagementKey: null,
    });
    expect(listCredentialStatus(t.db)).toEqual([
      { provider: 'deepseek', configured: false, hint: null, updatedAt: null },
      { provider: 'openrouter', configured: false, hint: null, updatedAt: null },
    ]);
  });

  it('upserts a key and reads it back for collection', () => {
    expect(
      saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY, '2026-09-15T01:00:00.000Z'),
    ).toEqual({
      provider: 'deepseek',
      configured: true,
      hint: 'abcd',
      updatedAt: '2026-09-15T01:00:00.000Z',
    });
    saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);

    expect(readProviderCredentials(t.db)).toEqual({
      deepseekApiKey: DEEPSEEK_KEY,
      openrouterManagementKey: OPENROUTER_KEY,
    });
  });

  it('replaces the key and its updatedAt on a second save', () => {
    saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY, '2026-09-15T01:00:00.000Z');
    const next = saveProviderCredential(
      t.db,
      'deepseek',
      'sk-fake-deepseek-1111111efgh',
      '2026-09-15T02:00:00.000Z',
    );

    expect(next).toMatchObject({ hint: 'efgh', updatedAt: '2026-09-15T02:00:00.000Z' });
    expect(rows()).toEqual([
      {
        provider: 'deepseek',
        secret: 'sk-fake-deepseek-1111111efgh',
        updated_at: '2026-09-15T02:00:00.000Z',
      },
    ]);
  });

  it('stamps the current time when no updatedAt is given', () => {
    const before = Date.now();
    const { updatedAt } = saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);
    expect(Date.parse(updatedAt ?? '')).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(updatedAt ?? '')).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('removes a key, and removing it again still succeeds', () => {
    saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);
    const removed = removeProviderCredential(t.db, 'openrouter');

    expect(removed).toEqual({
      provider: 'openrouter',
      configured: false,
      hint: null,
      updatedAt: null,
    });
    expect(rows()).toEqual([]);
    expect(removeProviderCredential(t.db, 'openrouter')).toEqual(removed);
    expect(readProviderCredentials(t.db).openrouterManagementKey).toBeNull();
  });

  it('lists both providers in order, and no status carries a secret', () => {
    saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);
    saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY);
    const statuses = listCredentialStatus(t.db);

    expect(statuses.map((s) => s.provider)).toEqual(['deepseek', 'openrouter']);
    for (const status of statuses) {
      expect(Object.keys(status).sort()).toEqual(['configured', 'hint', 'provider', 'updatedAt']);
      expect(status).not.toHaveProperty('secret');
    }
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain(DEEPSEEK_KEY.slice(0, -4));
    expect(serialized).not.toContain(OPENROUTER_KEY.slice(0, -4));
  });
});

describe('hint', () => {
  it('shows the last four characters only from 16 characters on', () => {
    const fifteen = 'sk-short-15wxyz';
    const sixteen = 'sk-short-16-wxyz';
    expect(fifteen).toHaveLength(15);
    expect(sixteen).toHaveLength(16);

    expect(credentialHint(fifteen)).toBeNull();
    expect(credentialHint(sixteen)).toBe('wxyz');
    expect(saveProviderCredential(t.db, 'deepseek', fifteen).hint).toBeNull();
    expect(listCredentialStatus(t.db)[0]).toMatchObject({ configured: true, hint: null });
    expect(saveProviderCredential(t.db, 'deepseek', sixteen).hint).toBe('wxyz');
  });
});

describe('secret schema', () => {
  it('trims surrounding whitespace and stores the trimmed value', () => {
    expect(credentialSecretSchema.parse(' sk-abc\n')).toBe('sk-abc');
    saveProviderCredential(t.db, 'deepseek', `\t ${DEEPSEEK_KEY} \r\n`);
    expect(readProviderCredentials(t.db).deepseekApiKey).toBe(DEEPSEEK_KEY);
  });

  it('rejects whitespace-only input, inner whitespace, and non-printable characters', () => {
    for (const secret of [
      '',
      '   ',
      '\n\t',
      'sk-a bc',
      'sk-a\tbc',
      ' sk-a\nbc ',
      'sk-ké',
      'sk-\u0000x',
    ]) {
      expect(credentialSecretSchema.safeParse(secret).success, JSON.stringify(secret)).toBe(false);
    }
  });

  it('accepts 512 characters after trimming and rejects 513', () => {
    expect(credentialSecretSchema.safeParse(`  ${'k'.repeat(512)}\n`).success).toBe(true);
    expect(credentialSecretSchema.safeParse('k'.repeat(513)).success).toBe(false);
    expect(credentialSecretSchema.safeParse(` ${'k'.repeat(513)} `).success).toBe(false);
  });

  it('makes the repository throw on an invalid secret, without saving or echoing it', () => {
    const invalid = 'sk-fake inner-space-secret';
    let message = '';
    try {
      saveProviderCredential(t.db, 'deepseek', invalid);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('inner-space');
    expect(rows()).toEqual([]);
  });
});

describe('table constraints', () => {
  const insert = (provider: string, secret: string) =>
    t.db.$client
      .prepare('INSERT INTO provider_credentials (provider, secret, updated_at) VALUES (?, ?, ?)')
      .run(provider, secret, '2026-09-15T00:00:00.000Z');

  it('rejects a provider that has no key in Settings', () => {
    expect(() => insert('codex', 'x')).toThrow(/CHECK constraint failed/);
    expect(() => insert('claude', 'x')).toThrow(/CHECK constraint failed/);
  });

  it('rejects an empty secret', () => {
    expect(() => insert('deepseek', '')).toThrow(/CHECK constraint failed/);
  });
});
