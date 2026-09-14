#!/usr/bin/env node
/**
 * Claude Code status-line bridge.
 *
 * Claude Code runs this on every status-line refresh with the session JSON on
 * stdin. Its job is narrow on purpose:
 *
 *   1. select ONLY the rate-limit fields and an observation timestamp;
 *   2. write them to a spool file atomically, mode 0600;
 *   3. print a status line so the user's terminal still shows something useful;
 *   4. never fail in a way that breaks the status line.
 *
 * The status-line payload also carries `session_id`, `transcript_path`, `cwd`,
 * `cost`, and the workspace/repo identity. None of that is needed to answer
 * "how much quota is left", so none of it is written. Selecting the allowlist
 * here — in the process that sees the raw input — means the rest never reaches
 * the collector, the database, or the browser.
 *
 * Deliberately dependency-free ESM: Claude invokes it from an arbitrary working
 * directory, so it must not rely on node_modules or a TypeScript loader.
 *
 * Environment:
 *   AUD_SPOOL_PATH    destination spool file (required to record anything)
 *   AUD_WRAPPED_CMD   pre-existing status-line command to delegate rendering to
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SPOOL_SCHEMA_VERSION = 1;

/** Windows this bridge is allowed to forward, in display order. */
const ALLOWED_WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];

/** Extract only the allowlisted rate-limit fields. */
function selectRateLimits(input) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;

  const out = {};
  for (const key of ALLOWED_WINDOWS) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const used = w.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resets =
      typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null;
    out[key] = { usedPercentage: used, resetsAt: resets };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Stable event id over the observation itself.
 *
 * Re-ingesting an unchanged spool file is then a no-op at the database level,
 * which is what makes a manual refresh racing the scheduled collector safe.
 */
function eventId(observedAt, rateLimits) {
  return createHash('sha256')
    .update(JSON.stringify({ observedAt, rateLimits }))
    .digest('hex')
    .slice(0, 32);
}

function writeSpoolAtomically(spoolPath, event) {
  const dir = dirname(spoolPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Same-directory temp file so the rename stays within one filesystem and is
  // therefore atomic: a reader sees either the old file or the new one, never a
  // half-written one. `wx` makes the temp name collision-proof.
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, spoolPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Render the pre-existing status line, if the installer wrapped one. */
function renderWrapped(rawInput) {
  const wrapped = process.env.AUD_WRAPPED_CMD;
  if (!wrapped) return null;
  try {
    return execFileSync('/bin/sh', ['-c', wrapped], {
      input: rawInput,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    // A command that ignores stdin (a bare `echo`, say) can exit before we
    // finish writing the payload, and the resulting EPIPE surfaces here even
    // though the command itself succeeded and produced output. Salvage that
    // output rather than discarding a status line the user deliberately kept.
    if (typeof err?.stdout === 'string' && err.stdout.trim() !== '') return err.stdout;
    // Anything genuinely broken degrades to this bridge's own rendering rather
    // than blanking the status line.
    return null;
  }
}

function renderOwn(rateLimits, model) {
  const parts = [];
  if (model) parts.push(`[${model}]`);
  if (rateLimits?.five_hour) parts.push(`5h ${Math.round(rateLimits.five_hour.usedPercentage)}%`);
  if (rateLimits?.seven_day) parts.push(`7d ${Math.round(rateLimits.seven_day.usedPercentage)}%`);
  return parts.join(' | ');
}

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }

  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }

  const rateLimits = selectRateLimits(input);
  const observedAt = new Date().toISOString();
  const spoolPath = process.env.AUD_SPOOL_PATH;

  if (spoolPath) {
    try {
      writeSpoolAtomically(spoolPath, {
        spoolSchemaVersion: SPOOL_SCHEMA_VERSION,
        eventId: eventId(observedAt, rateLimits),
        observedAt,
        cliVersion: typeof input?.version === 'string' ? input.version : null,
        // `false` distinguishes "the bridge is installed and running but this
        // account/session exposes no rate_limits" from "the bridge never ran".
        hasRateLimits: rateLimits !== null,
        rateLimits,
      });
    } catch {
      // A spool failure must never break the user's status line.
    }
  }

  const wrapped = renderWrapped(raw);
  if (wrapped !== null && wrapped.trim() !== '') {
    process.stdout.write(wrapped.endsWith('\n') ? wrapped : `${wrapped}\n`);
    return;
  }

  const model = input?.model && typeof input.model === 'object' ? input.model.display_name : null;
  process.stdout.write(`${renderOwn(rateLimits, model) || 'ai-usage-dashboard'}\n`);
}

main();
