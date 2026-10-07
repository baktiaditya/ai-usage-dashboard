#!/usr/bin/env tsx
/**
 * Render the collector's systemd units into a directory.
 *
 *   tsx scripts/render-systemd-units.ts <output-dir>
 *
 * `scripts/install-systemd.sh` calls this with the interpreter paths it
 * resolved (`AUD_UNIT_WORKDIR`, `AUD_UNIT_PATH`, `AUD_UNIT_CODEXHOME`,
 * `AUD_UNIT_NODE`, `AUD_UNIT_TSX`). The data directory, interval, environment
 * file, host and port are resolved here through `getConfig()` — shell exports,
 * then `collector.env`, then defaults — so the sandbox's writable path, the
 * timer, and the web server's bind address agree with what the installer reports
 * and the collector will actually use. Values are substituted
 * literally and escaped for systemd (`src/lib/systemd-unit.ts`).
 *
 * On success it prints, one per line, the environment file, the data directory,
 * the interval, the host and the port, for the installer to report and check.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeErrorMessage } from '../src/lib/redact';
import { renderUnit } from '../src/lib/systemd-unit';
import { resolveUnitValues } from '../src/lib/unit-values';

const UNITS = [
  'ai-usage-dashboard-collector.service',
  'ai-usage-dashboard-collector.timer',
  'ai-usage-dashboard-web.service',
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run scripts/install-systemd.sh instead`);
  return value;
}

try {
  const outDir = process.argv[2];
  if (!outDir) throw new Error('usage: tsx scripts/render-systemd-units.ts <output-dir>');

  const { envFile, config, values } = resolveUnitValues({
    env: process.env,
    workdir: required('AUD_UNIT_WORKDIR'),
    path: required('AUD_UNIT_PATH'),
    codexHome: required('AUD_UNIT_CODEXHOME'),
    node: required('AUD_UNIT_NODE'),
    tsx: required('AUD_UNIT_TSX'),
  });

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

  process.stdout.write(
    `${envFile}\n${config.dataDir}\n${config.collectIntervalMinutes}\n${config.host}\n${config.port}\n`,
  );
} catch (err) {
  process.stderr.write(`could not render the systemd units: ${safeErrorMessage(err)}\n`);
  process.exitCode = 2;
}
