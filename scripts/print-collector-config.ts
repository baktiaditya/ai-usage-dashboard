#!/usr/bin/env tsx
/**
 * Print the collector settings a systemd unit must agree with, one per line:
 *
 *   <environment file path>
 *   <data directory>
 *   <collection interval in minutes>
 *
 * `scripts/install-systemd.sh` bakes these into the unit. Resolving them here,
 * through `getConfig()`, applies exactly the precedence the collector does —
 * exported variables, then `collector.env`, then defaults — and validates them,
 * so the sandbox's writable path and the timer cannot drift from what the
 * collector will actually use.
 */
import { getConfig } from '../src/lib/config';
import { collectorEnvFilePath } from '../src/lib/env-file';
import { safeErrorMessage } from '../src/lib/redact';

try {
  const envFile = collectorEnvFilePath(process.env);
  const config = getConfig();
  process.stdout.write(`${envFile}\n${config.dataDir}\n${config.collectIntervalMinutes}\n`);
} catch (err) {
  process.stderr.write(`configuration error: ${safeErrorMessage(err)}\n`);
  process.exitCode = 2;
}
