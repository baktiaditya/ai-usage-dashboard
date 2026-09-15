import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveProviderCredential } from '@/lib/db/credentials';
import { createTestDb } from '../helpers/db';
import { readSavedCredentials } from '../helpers/saved-credentials';

// Fake keys only.
const DEEPSEEK_KEY = 'sk-fake-live-deepseek-000abcd';
const OPENROUTER_KEY = 'sk-or-fake-live-openrouter-wxyz';

const NO_KEYS = { deepseekApiKey: null, openrouterManagementKey: null };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aud-live-keys-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('live gate credential reading', () => {
  it('treats a database that does not exist as no keys, without creating anything', () => {
    const missing = join(dir, 'data', 'usage.db');

    expect(readSavedCredentials(missing)).toEqual(NO_KEYS);
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  it('treats a database without the credentials table as no keys, without migrating it', () => {
    const path = join(dir, 'usage.db');
    const setup = new Database(path);
    setup.exec('CREATE TABLE other (x INTEGER)');
    setup.close();

    expect(readSavedCredentials(path)).toEqual(NO_KEYS);

    const check = new Database(path, { readonly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    check.close();
    expect(tables).toEqual([{ name: 'other' }]);
  });

  it('throws when the database cannot be read instead of reporting no keys', () => {
    const path = join(dir, 'usage.db');
    writeFileSync(path, 'not a sqlite database '.repeat(300));

    expect(() => readSavedCredentials(path)).toThrow('file is not a database');
  });

  it('reads both saved keys', () => {
    const t = createTestDb();
    try {
      saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY);
      saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);

      expect(readSavedCredentials(t.path)).toEqual({
        deepseekApiKey: DEEPSEEK_KEY,
        openrouterManagementKey: OPENROUTER_KEY,
      });
    } finally {
      t.cleanup();
    }
  });
});
