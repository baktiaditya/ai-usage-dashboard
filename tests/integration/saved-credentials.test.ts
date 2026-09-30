import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const CLAUDE_TOKEN = 'sk-ant-oat01-fake-live-claude-token-0000abcd';

const OPENCODE_GO_KEY = 'sk-fake-live-opencode-go-0000efgh';
const NO_KEYS = {
  deepseekApiKey: null,
  openrouterManagementKey: null,
  claudeUsageToken: null,
  opencodeGoApiKey: null,
};

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

  // Root ignores directory permissions, so the denial cannot be staged.
  it.skipIf(process.getuid?.() === 0)(
    'throws when the database path cannot be reached instead of reporting no keys',
    () => {
      const parent = join(dir, 'locked');
      const t = createTestDb();
      try {
        mkdirSync(parent);
        copyFileSync(t.path, join(parent, 'usage.db'));
      } finally {
        t.cleanup();
      }
      chmodSync(parent, 0o000);
      try {
        expect(() => readSavedCredentials(join(parent, 'usage.db'))).toThrow(
          expect.objectContaining({ code: 'EACCES' }),
        );
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );

  it('throws when the database cannot be read instead of reporting no keys', () => {
    const path = join(dir, 'usage.db');
    writeFileSync(path, 'not a sqlite database '.repeat(300));

    expect(() => readSavedCredentials(path)).toThrow('file is not a database');
  });

  it('reads every saved key, the Claude token and OpenCode Go key included', () => {
    const t = createTestDb();
    try {
      saveProviderCredential(t.db, 'deepseek', DEEPSEEK_KEY);
      saveProviderCredential(t.db, 'openrouter', OPENROUTER_KEY);
      saveProviderCredential(t.db, 'claude', CLAUDE_TOKEN);
      saveProviderCredential(t.db, 'opencode_go', OPENCODE_GO_KEY);

      expect(readSavedCredentials(t.path)).toEqual({
        deepseekApiKey: DEEPSEEK_KEY,
        openrouterManagementKey: OPENROUTER_KEY,
        claudeUsageToken: CLAUDE_TOKEN,
        opencodeGoApiKey: OPENCODE_GO_KEY,
      });
    } finally {
      t.cleanup();
    }
  });
});
