#!/usr/bin/env tsx
/**
 * One-shot collector.
 *
 * This is the *only* orchestration path: the systemd timer runs it, and the
 * manual refresh endpoint calls the same `collectOnce` function in-process.
 * Having one path means a scheduled run and a manual one cannot drift apart in
 * behaviour, dedup semantics, or retention.
 *
 * Exit codes:
 *   0  every selected provider is success or unavailable
 *   1  at least one provider errored (the run still persisted what it could)
 *   2  the run could not start at all (configuration or database failure)
 */
import { collectOnce } from '../src/lib/collector/index';
import { getConfig } from '../src/lib/config';
import { openDb } from '../src/lib/db/client';
import { createLogger } from '../src/lib/logger';
import { PROVIDERS, isProvider } from '../src/lib/domain';
import type { Provider } from '../src/lib/domain';
import { safeErrorMessage } from '../src/lib/redact';

function parseProviders(argv: readonly string[]): Provider[] | undefined {
  const flag = argv.find((a) => a.startsWith('--provider='));
  if (!flag) return undefined;
  const raw = flag.slice('--provider='.length);
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = names.filter((n) => !isProvider(n));
  if (invalid.length > 0) {
    throw new Error(
      `unknown provider(s): ${invalid.join(', ')}. Valid values: ${PROVIDERS.join(', ')}`,
    );
  }
  return names.filter(isProvider);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const trigger = argv.includes('--manual') ? 'manual' : 'scheduled';

  let config;
  try {
    config = getConfig();
  } catch (err) {
    process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
    return 2;
  }

  const logger = createLogger(config.logLevel, { component: 'collector' });

  let providers: Provider[] | undefined;
  try {
    providers = parseProviders(argv);
  } catch (err) {
    process.stderr.write(`${safeErrorMessage(err)}\n`);
    return 2;
  }

  let db;
  try {
    db = openDb({ path: config.databasePath });
  } catch (err) {
    logger.error('failed to open database', { error: safeErrorMessage(err) });
    return 2;
  }

  try {
    const summary = await collectOnce({
      db,
      config,
      trigger,
      logger,
      ...(providers ? { providers } : {}),
    });
    // A provider being unavailable is a normal steady state (no credential yet)
    // and must not make the systemd unit look broken.
    return summary.error > 0 ? 1 : 0;
  } catch (err) {
    logger.error('collector run failed', { error: safeErrorMessage(err) });
    return 2;
  } finally {
    db.$client.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`unhandled: ${safeErrorMessage(err)}\n`);
    process.exitCode = 2;
  });
