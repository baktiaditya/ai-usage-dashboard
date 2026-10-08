/**
 * The collector command line, kept importable so tests can inject adapters and
 * a shortened deadline. `scripts/collect.ts` is the thin executable wrapper.
 *
 * Exit codes:
 *   0  every selected provider is success or unavailable
 *   1  at least one provider errored (the run still persisted what it could)
 *   2  the run could not start, or the whole run hit its deadline
 *
 * The deadline exists because launchd never starts an interval job while the
 * previous run is still alive: without it, one hung run would silently stop
 * every later collection. Under systemd it is redundant with the unit's
 * `TimeoutStartSec=120` and harmless.
 */
import type { AppConfig } from '../config';
import { getConfig, retiredCredentialEnvVars } from '../config';
import { openDb } from '../db/client';
import { PROVIDERS, isProvider } from '../domain';
import type { Provider, ProviderAdapter } from '../domain';
import { createLogger } from '../logger';
import { safeErrorMessage } from '../redact';
import { collectOnce } from './index';

/** The whole-run deadline, matching the systemd unit's `TimeoutStartSec=120`. */
export const COLLECTOR_DEADLINE_MS = 120_000;

export class CollectorDeadlineError extends Error {
  override readonly name = 'CollectorDeadlineError';
}

export interface CollectorCliOptions {
  readonly argv?: readonly string[];
  /** Test injection only; production resolves adapters from configuration. */
  readonly adapters?: readonly ProviderAdapter[];
  /** Test injection only; production always uses `COLLECTOR_DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** Test injection only; production terminates the process. */
  readonly exit?: (code: number) => void;
  readonly writeStderr?: (text: string) => void;
}

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

interface RunOnceOptions {
  readonly argv: readonly string[];
  readonly trigger: 'scheduled' | 'manual';
  readonly adapters?: readonly ProviderAdapter[];
  readonly writeStderr: (text: string) => void;
}

async function runOnce(options: RunOnceOptions): Promise<number> {
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (err) {
    options.writeStderr(`configuration error: ${safeErrorMessage(err)}\n`);
    return 2;
  }

  const logger = createLogger(config.logLevel, { component: 'collector' });

  // Keys now come only from the database. A leftover variable, in the shell or
  // in collector.env, would otherwise look like it still does something. Names
  // only: a value never reaches the log.
  const retired = retiredCredentialEnvVars(process.env);
  if (retired.length > 0) {
    logger.warn('provider key environment variables are ignored; save keys in dashboard Settings', {
      variables: retired,
    });
  }

  let providers: Provider[] | undefined;
  try {
    providers = parseProviders(options.argv);
  } catch (err) {
    options.writeStderr(`${safeErrorMessage(err)}\n`);
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
      trigger: options.trigger,
      logger,
      ...(providers ? { providers } : {}),
      ...(options.adapters ? { adapters: options.adapters } : {}),
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

/**
 * Run one collector pass under a hard whole-run deadline.
 *
 * On expiry the run reports and exits non-zero through `exit`, which by default
 * terminates the process: an abandoned adapter may still hold the event loop
 * open, so returning would not be enough to guarantee launchd sees the job end.
 * The timer is ref'd, so even a run hung on a promise with no other handles
 * reaches the deadline instead of exiting 0.
 */
export async function runCollectorCli(options: CollectorCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const deadlineMs = options.deadlineMs ?? COLLECTOR_DEADLINE_MS;
  const exit = options.exit ?? ((code: number): void => void process.exit(code));
  const writeStderr =
    options.writeStderr ?? ((text: string): void => void process.stderr.write(text));
  const trigger = argv.includes('--manual') ? 'manual' : 'scheduled';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new CollectorDeadlineError(`collector run exceeded its ${deadlineMs}ms deadline`)),
      deadlineMs,
    );
  });

  try {
    return await Promise.race([
      runOnce({ argv, trigger, adapters: options.adapters, writeStderr }),
      deadline,
    ]);
  } catch (err) {
    if (err instanceof CollectorDeadlineError) {
      writeStderr(`${safeErrorMessage(err)}; exiting\n`);
      exit(2);
      return 2;
    }
    writeStderr(`unhandled: ${safeErrorMessage(err)}\n`);
    return 2;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
