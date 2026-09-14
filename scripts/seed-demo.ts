#!/usr/bin/env tsx
/**
 * Seed a database with every card state, for browser smoke tests and for
 * eyeballing the UI without waiting on real providers.
 *
 * Deliberately produces one provider in each of the four states, two currencies
 * on DeepSeek, two windows on Codex, and enough history for a 7-day chart plus
 * a pre-period baseline — the combination the browser tests assert on.
 *
 * It starts by deleting every collector run in the database it opens, so it
 * never chooses a target by default:
 *
 *   npm run seed:dev                              # the development server's directory
 *   AUD_DATA_DIR=/tmp/aud-demo npm run seed:demo  # an explicit scratch directory
 *
 * `--dev` resolves the directory exactly as `npm run dev` does, which is never
 * the production one. Without it the script refuses to run unless
 * `AUD_DATA_DIR` is exported explicitly: otherwise `getConfig()` falls back to
 * the real data directory (or one named in `collector.env`), and seeding would
 * wipe a real collection.
 */
import { collectOnce } from '../src/lib/collector/index';
import { getConfig } from '../src/lib/config';
import { resolveDevEnvironment } from '../src/lib/dev-environment';
import { openDb } from '../src/lib/db/client';
import { recordAttempt, startRun } from '../src/lib/db/repository';
import type { Db } from '../src/lib/db/client';
import type { CreditSnapshot, Provider, ProviderAdapter, QuotaSnapshot } from '../src/lib/domain';
import type { MoneyString } from '../src/lib/money';
import { CollectionError } from '../src/lib/errors';
import { safeErrorMessage } from '../src/lib/redact';

const args = process.argv.slice(2);
const dev = args.length === 1 && args[0] === '--dev';
if (args.length > 0 && !dev) {
  process.stderr.write('usage: tsx scripts/seed-demo.ts [--dev]\n');
  process.exit(2);
}

// The target is fixed before `getConfig()` merges collector.env, which may
// itself name the production data directory. An exported AUD_DATA_DIR wins
// over the file, so the development directory set here cannot be replaced.
if (dev) {
  try {
    process.env['AUD_DATA_DIR'] = resolveDevEnvironment(process.env).dataDir;
  } catch (err) {
    process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
    process.exit(2);
  }
} else if (!process.env['AUD_DATA_DIR']?.trim()) {
  process.stderr.write(
    'refusing to seed: export AUD_DATA_DIR to a scratch directory first. Seeding deletes every collector run in the database it opens, and the default is your real collection.\n',
  );
  process.exit(2);
}

const config = getConfig();

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function inHours(n: number): string {
  return new Date(Date.now() + n * 3_600_000).toISOString();
}

function codexSnapshot(observedAt: string, used: [number, number]): QuotaSnapshot {
  return {
    kind: 'quota',
    provider: 'codex',
    observedAt,
    collectedAt: observedAt,
    sourceVersion: 'codex-cli/0.154.0',
    schemaVersion: 1,
    usageAllowed: true,
    limitReachedCode: null,
    sourceEventId: null,
    windows: [
      {
        bucketId: 'codex',
        windowKind: 'primary',
        usedPercent: used[0],
        windowDurationMinutes: 300,
        resetsAt: inHours(3),
      },
      {
        bucketId: 'codex',
        windowKind: 'secondary',
        usedPercent: used[1],
        windowDurationMinutes: 10080,
        resetsAt: inHours(90),
      },
    ],
  };
}

function deepseekSnapshot(observedAt: string, cny: string, usd: string): CreditSnapshot {
  return {
    kind: 'credit',
    provider: 'deepseek',
    observedAt,
    collectedAt: observedAt,
    sourceVersion: 'deepseek-api/user-balance',
    schemaVersion: 1,
    sourceEventId: null,
    balances: [
      {
        currency: 'CNY',
        totalBalance: cny as MoneyString,
        grantedBalance: '10' as MoneyString,
        toppedUpBalance: '100' as MoneyString,
        totalCredits: null,
        totalUsage: null,
        remainingCredit: null,
        isAvailable: true,
      },
      {
        currency: 'USD',
        totalBalance: usd as MoneyString,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits: null,
        totalUsage: null,
        remainingCredit: null,
        isAvailable: true,
      },
    ],
  };
}

function write(db: Db, provider: Provider, snapshot: QuotaSnapshot | CreditSnapshot): void {
  recordAttempt(db, {
    runId: startRun(db, 'scheduled', snapshot.collectedAt),
    provider,
    startedAt: snapshot.collectedAt,
    finishedAt: snapshot.collectedAt,
    retryCount: 0,
    result: { outcome: 'success', snapshot },
  });
}

function stub(provider: Provider, code: string): ProviderAdapter {
  return {
    provider,
    schemaVersion: 1,
    timeoutMs: 100,
    async collect() {
      throw new CollectionError(code as never, `seeded ${code}`);
    },
  };
}

async function main(): Promise<void> {
  const db = openDb({ path: config.databasePath });

  // Clear any previous seed so repeated runs are idempotent.
  db.$client.exec('DELETE FROM collector_runs');

  // --- Codex: healthy, with 8 days of history for the charts ---------------
  for (let d = 8; d >= 1; d -= 1) {
    write(db, 'codex', codexSnapshot(daysAgo(d), [20 + d * 4, 30 + d * 2]));
  }
  write(db, 'codex', codexSnapshot(minutesAgo(2), [37, 52]));

  // --- DeepSeek: stale, and low enough on CNY to trigger `watch` -----------
  // The baseline sits before the 7-day window so a balance change is computable.
  write(db, 'deepseek', deepseekSnapshot(daysAgo(9), '110.00', '15.42'));
  write(db, 'deepseek', deepseekSnapshot(daysAgo(2), '52.00', '15.42'));
  write(db, 'deepseek', deepseekSnapshot(minutesAgo(120), '30.00', '15.42'));

  // --- OpenRouter: a real error after a successful collection --------------
  const orSnapshot: CreditSnapshot = {
    kind: 'credit',
    provider: 'openrouter',
    observedAt: minutesAgo(30),
    collectedAt: minutesAgo(30),
    sourceVersion: 'openrouter-api/v1-credits',
    schemaVersion: 1,
    sourceEventId: null,
    balances: [
      {
        currency: 'USD',
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        totalCredits: '100.5' as MoneyString,
        totalUsage: '25.75' as MoneyString,
        remainingCredit: '74.75' as MoneyString,
        isAvailable: null,
      },
    ],
  };
  write(db, 'openrouter', orSnapshot);

  // --- Failures last, so they are each provider's latest attempt -----------
  await collectOnce({
    db,
    config,
    trigger: 'scheduled',
    applyRetentionPolicy: false,
    adapters: [
      stub('openrouter', 'upstream_error'),
      // Claude has never emitted an event: the honest "unavailable" case.
      stub('claude', 'no_event_yet'),
    ],
  });

  const counts = db.$client
    .prepare('SELECT provider, COUNT(*) c FROM provider_snapshots GROUP BY provider')
    .all();
  process.stdout.write(`seeded: ${JSON.stringify(counts)}\n`);
  db.$client.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`seed failed: ${safeErrorMessage(err)}\n`);
  process.exitCode = 1;
});
