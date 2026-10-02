#!/usr/bin/env tsx
/**
 * Embed drizzle/*.sql into a TypeScript module.
 *
 * The `.sql` files stay the source of truth — they are what a human reviews and
 * what `sqlite3` can run directly — but the web server is bundled by Turbopack,
 * where reading a directory at runtime is neither traceable nor reliable. So
 * the SQL is compiled into `src/lib/db/migrations.generated.ts` and imported
 * statically.
 *
 * `tests/unit/migrations-sync.test.ts` regenerates this and fails if it drifts,
 * so the two can never disagree silently.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');
const OUTPUT = join(process.cwd(), 'src', 'lib', 'db', 'migrations.generated.ts');

export interface EmbeddedMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): EmbeddedMigration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const version = Number(name.slice(0, 4));
      if (!Number.isInteger(version)) {
        throw new Error(`migration filename must start with 4 digits: ${name}`);
      }
      return { version, name, sql: readFileSync(join(dir, name), 'utf8') };
    });
}

export function renderModule(migrations: readonly EmbeddedMigration[]): string {
  const entries = migrations
    .map(
      (m) =>
        `  {\n    version: ${m.version},\n    name: ${JSON.stringify(m.name)},\n    sql: ${JSON.stringify(m.sql)},\n  },`,
    )
    .join('\n');

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/build-migrations.ts from drizzle/*.sql, which remain the
 * source of truth. Regenerate with: pnpm run db:build-migrations
 */

export interface EmbeddedMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly EmbeddedMigration[] = [
${entries}
];
`;
}

// Only write when executed directly; the test imports the helpers above.
if (process.argv[1]?.endsWith('build-migrations.ts')) {
  const migrations = readMigrations();
  writeFileSync(OUTPUT, renderModule(migrations), 'utf8');
  process.stdout.write(
    `Embedded ${migrations.length} migration(s) into src/lib/db/migrations.generated.ts\n`,
  );
}
