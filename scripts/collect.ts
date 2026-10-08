#!/usr/bin/env tsx
/**
 * One-shot collector.
 *
 * This is the *only* orchestration path: the systemd timer or launchd agent
 * runs it, and the manual refresh endpoint calls the same `collectOnce`
 * function in-process. Having one path means a scheduled run and a manual one
 * cannot drift apart in behaviour, dedup semantics, or retention.
 *
 * The whole-run deadline and the exit codes live in `src/lib/collector/cli.ts`.
 */
import { runCollectorCli } from '../src/lib/collector/cli';

runCollectorCli()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
