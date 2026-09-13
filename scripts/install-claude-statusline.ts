#!/usr/bin/env tsx
/**
 * Install the Claude Code status-line bridge.
 *
 * The status line is the user's own terminal UI, and this project is a guest in
 * it. So the installer is deliberately conservative:
 *
 *   - it does nothing at all without `--apply`;
 *   - if a `statusLine` is already configured it **fails closed** and prints the
 *     exact command to compose with it, rather than overwriting silently;
 *   - `--wrap-existing` is the explicit opt-in that makes the bridge delegate
 *     rendering to the previous command via `AUD_WRAPPED_CMD`;
 *   - it writes a timestamped backup of settings.json before touching it.
 *
 * Usage:
 *   npm run claude:install-statusline                    # dry run (default)
 *   npm run claude:install-statusline -- --apply
 *   npm run claude:install-statusline -- --apply --wrap-existing
 *   npm run claude:install-statusline -- --print         # snippet to paste by hand
 *   npm run claude:install-statusline -- --uninstall --apply
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getConfig } from '../src/lib/config';
import { safeErrorMessage } from '../src/lib/redact';

interface StatusLineConfig {
  type?: string;
  command?: string;
  padding?: number;
  [k: string]: unknown;
}

const MARKER = 'claude-statusline-bridge.mjs';

function settingsPath(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings.json is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    // Refuse to rewrite a file we could not fully understand.
    throw new Error(`could not parse ${path}: ${safeErrorMessage(err)}`);
  }
}

function buildCommand(spoolPath: string, wrapped: string | null): string {
  const bridge = resolve(process.cwd(), 'scripts', MARKER);
  const env = [`AUD_SPOOL_PATH=${shellQuote(spoolPath)}`];
  if (wrapped) env.push(`AUD_WRAPPED_CMD=${shellQuote(wrapped)}`);
  // Absolute paths throughout: Claude runs the status line from the session's
  // working directory, which is almost never this repository.
  return `${env.join(' ')} ${shellQuote(process.execPath)} ${shellQuote(bridge)}`;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Inverse of `shellQuote` for the `AUD_WRAPPED_CMD=` assignment `buildCommand` writes. */
function wrappedCommandOf(command: string): string | null {
  const match = /AUD_WRAPPED_CMD='((?:[^']|'\\'')*)'/.exec(command);
  const quoted = match?.[1];
  return quoted === undefined ? null : quoted.replaceAll(`'\\''`, "'");
}

function main(): number {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const wrapExisting = argv.includes('--wrap-existing');
  const printOnly = argv.includes('--print');
  const uninstall = argv.includes('--uninstall');

  const config = getConfig();
  const path = settingsPath();

  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch (err) {
    process.stderr.write(`${safeErrorMessage(err)}\n`);
    return 2;
  }

  const existing = settings['statusLine'] as StatusLineConfig | undefined;
  const existingCommand = typeof existing?.command === 'string' ? existing.command : null;
  const alreadyOurs = existingCommand?.includes(MARKER) ?? false;

  if (uninstall) {
    if (!alreadyOurs) {
      process.stderr.write(
        'The configured status line was not installed by this project; refusing to remove it.\n',
      );
      return 1;
    }
    // `--wrap-existing` embedded the previous command in ours. Hand it back
    // rather than leaving the user with no status line at all.
    const restored = existingCommand ? wrappedCommandOf(existingCommand) : null;
    if (!apply) {
      process.stdout.write(
        restored
          ? `DRY RUN: would restore the wrapped status line in ${path}:\n  ${restored}\nRe-run with --apply.\n`
          : `DRY RUN: would remove statusLine from ${path}\nRe-run with --apply.\n`,
      );
      return 0;
    }
    backup(path);
    if (restored) settings['statusLine'] = { type: 'command', command: restored };
    else delete settings['statusLine'];
    writeSettings(path, settings);
    process.stdout.write(
      restored
        ? `Removed the bridge and restored the status line it wrapped in ${path}\n`
        : `Removed the bridge status line from ${path}\n`,
    );
    return 0;
  }

  const wrapped = wrapExisting && !alreadyOurs ? existingCommand : null;
  const command = buildCommand(config.spoolPath, wrapped);
  const desired: StatusLineConfig = { type: 'command', command, padding: 0 };

  if (printOnly) {
    process.stdout.write(`${JSON.stringify({ statusLine: desired }, null, 2)}\n`);
    return 0;
  }

  // Fail closed: an existing, foreign status line is never replaced implicitly.
  if (existingCommand && !alreadyOurs && !wrapExisting) {
    process.stderr.write(
      [
        `A status line is already configured in ${path}.`,
        '',
        'This installer will not overwrite it. Choose one:',
        '',
        '  1. Compose with it (the bridge runs your command and prints its output):',
        '       npm run claude:install-statusline -- --apply --wrap-existing',
        '',
        '  2. Configure it yourself:',
        '       npm run claude:install-statusline -- --print',
        '',
        'Existing command left untouched.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (!apply) {
    process.stdout.write(
      [
        `DRY RUN — nothing was written.`,
        ``,
        `settings file : ${path}`,
        `spool file    : ${config.spoolPath}`,
        `existing      : ${existingCommand ? (alreadyOurs ? 'this project (will refresh)' : 'foreign') : 'none'}`,
        `wrapping      : ${wrapped ? 'yes' : 'no'}`,
        ``,
        `would set statusLine.command to:`,
        `  ${command}`,
        ``,
        `Re-run with --apply to write it.`,
        ``,
      ].join('\n'),
    );
    return 0;
  }

  backup(path);
  settings['statusLine'] = desired;
  writeSettings(path, settings);

  process.stdout.write(
    [
      `Installed the status-line bridge into ${path}`,
      `Spool file: ${config.spoolPath}`,
      wrapped ? `Wrapping existing command: ${wrapped}` : '',
      ``,
      `Start (or restart) a Claude Code session and send one prompt. The bridge`,
      `records rate_limits only after the session's first API response.`,
      ``,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return 0;
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.backup-${stamp}`;
  copyFileSync(path, dest);
  process.stdout.write(`Backed up existing settings to ${dest}\n`);
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`install failed: ${safeErrorMessage(err)}\n`);
  process.exitCode = 2;
}
