#!/usr/bin/env tsx
/**
 * Render the collector's systemd units into a directory.
 *
 *   tsx scripts/render-systemd-units.ts <output-dir>
 *
 * `scripts/install-systemd.sh` calls this with the interpreter paths it
 * resolved (`AUD_UNIT_WORKDIR`, `AUD_UNIT_PATH`, `AUD_UNIT_CODEXHOME`,
 * `AUD_UNIT_NODE`, `AUD_UNIT_TSX`). The data directory, interval and
 * environment file are resolved here through `getConfig()` — shell exports, then
 * `collector.env`, then defaults — so the sandbox's writable path and the timer
 * agree with what the collector will actually use. Values are substituted
 * literally and escaped for systemd (`src/lib/systemd-unit.ts`).
 *
 * On success it prints, one per line, the environment file, the data directory
 * and the interval, for the installer to report.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../src/lib/config';
import { collectorEnvFilePath } from '../src/lib/env-file';
import { safeErrorMessage } from '../src/lib/redact';
import { renderUnit } from '../src/lib/systemd-unit';
import type { UnitValues } from '../src/lib/systemd-unit';

const UNITS = ['ai-usage-dashboard-collector.service', 'ai-usage-dashboard-collector.timer'];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run scripts/install-systemd.sh instead`);
  return value;
}

try {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: tsx scripts/render-systemd-units.ts <output-dir>');

  const envFile = collectorEnvFilePath(process.env);
  const config = getConfig();
  const values: UnitValues = {
    WORKDIR: required('AUD_UNIT_WORKDIR'),
    PATH: required('AUD_UNIT_PATH'),
    CODEXHOME: required('AUD_UNIT_CODEXHOME'),
    NODE: required('AUD_UNIT_NODE'),
    TSX: required('AUD_UNIT_TSX'),
    DATADIR: config.dataDir,
    ENVFILE: envFile,
    INTERVAL: String(config.collectIntervalMinutes),
  };

  // Render both before writing either, so a refused value never leaves a
  // service and timer that disagree.
  const rendered = UNITS.map((unit) => ({
    dest: join(outDir, unit),
    text: renderUnit(
      readFileSync(join(values.WORKDIR, 'systemd', `${unit}.template`), 'utf8'),
      values,
    ),
  }));
  for (const { dest, text } of rendered) {
    writeFileSync(dest, text, { mode: 0o600 });
    chmodSync(dest, 0o600);
  }

  process.stdout.write(`${envFile}\n${config.dataDir}\n${config.collectIntervalMinutes}\n`);
} catch (err) {
  process.stderr.write(`could not render the systemd units: ${safeErrorMessage(err)}\n`);
  process.exitCode = 2;
}
