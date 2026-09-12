import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMigrations, renderModule } from '../../scripts/build-migrations';
import { MIGRATIONS } from '@/lib/db/migrations.generated';

/**
 * The `.sql` files are the source of truth; the generated module is what the
 * bundled server actually executes. If those two ever disagree, the production
 * schema silently stops matching the file a reviewer reads.
 */
describe('embedded migrations stay in sync with drizzle/*.sql', () => {
  it('matches the generated module byte for byte', () => {
    const expected = renderModule(readMigrations(join(process.cwd(), 'drizzle')));
    const actual = readFileSync(
      join(process.cwd(), 'src', 'lib', 'db', 'migrations.generated.ts'),
      'utf8',
    );
    expect(actual).toBe(expected);
  });

  it('exposes each migration exactly once, in version order', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('declares every table STRICT so SQLite enforces the column types', () => {
    for (const m of MIGRATIONS) {
      const creates = m.sql.match(/CREATE TABLE\s+\w+/gi) ?? [];
      const stricts = m.sql.match(/\)\s*STRICT;/gi) ?? [];
      expect(stricts.length, `${m.name} has ${creates.length} tables`).toBe(creates.length);
    }
  });

  it('never stores money in a REAL column', () => {
    const moneyColumns = [
      'total_balance',
      'granted_balance',
      'topped_up_balance',
      'total_credits',
      'total_usage',
      'remaining_credit',
    ];
    for (const m of MIGRATIONS) {
      for (const col of moneyColumns) {
        const declaration = new RegExp(`${col}\\s+(\\w+)`, 'i').exec(m.sql);
        if (declaration) {
          expect(declaration[1]?.toUpperCase(), `${col} in ${m.name}`).toBe('TEXT');
        }
      }
    }
  });
});
