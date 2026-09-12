import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@/lib/db/client';
import type { Db } from '@/lib/db/client';
import { loadConfig } from '@/lib/config';
import type { AppConfig } from '@/lib/config';

export interface TestDb {
  readonly db: Db;
  readonly dir: string;
  readonly path: string;
  cleanup(): void;
}

/**
 * A real on-disk SQLite database in a temp directory.
 *
 * Not `:memory:` — WAL, busy_timeout and multi-connection behaviour are part of
 * what these tests exist to verify, and none of them are observable in an
 * in-memory database.
 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'aud-test-'));
  const path = join(dir, 'usage.db');
  const db = openDb({ path });
  return {
    db,
    dir,
    path,
    cleanup() {
      try {
        db.$client.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    AUD_TIMEZONE: 'Asia/Jakarta',
    AUD_PORT: '3838',
    AUD_COLLECT_INTERVAL_MINUTES: '5',
    AUD_RETENTION_DAYS: '90',
    ...overrides,
  });
}
