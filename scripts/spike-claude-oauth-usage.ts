#!/usr/bin/env tsx
/**
 * Spike — gate-probe the undocumented Claude subscription usage endpoint.
 *
 *   pnpm run spike:claude-usage
 *
 * Why this exists
 * ---------------
 * The status-line bridge is push-shaped: Claude Code emits `rate_limits` only
 * while a session is live and only after that session's first API response, so
 * the dashboard reports `no_event_yet` whenever no session has run recently.
 * `GET /api/oauth/usage` is the pull-shaped source Claude Code itself reads for
 * `/usage`, and it answers with no session running.
 *
 * This script settles one question: does that endpoint answer for this account,
 * and is its shape something an adapter could depend on? It collects nothing,
 * writes no file, and never touches the database. Promote it to a real adapter
 * only once the gate passes.
 *
 * What it deliberately does not do
 * --------------------------------
 * - Print, log or persist the token, or any observed percentage. Shape is the
 *   evidence; a real quota number must never land in the repository.
 * - Retry. The endpoint answers 429 on a punitive ladder (30/60/120/240/300s)
 *   that can stick until the window rolls over, so a refusal is reported once
 *   and never retried. Re-run by hand, and not more than once every ~5 minutes.
 * - Refresh the token. Writing `~/.claude/.credentials.json` races Claude Code's
 *   own refresh-token rotation. When the token is expired this exits `skipped`
 *   and tells you to mint a standalone one with `claude setup-token`.
 *
 * The endpoint is undocumented and unsupported: anthropics/claude-code#31637 is
 * labelled `invalid`. Treat a shape change as expected, not exceptional.
 *
 * Exit codes:
 *   0  passed  — endpoint answered and the contract below holds
 *   1  failed  — endpoint refused, or the shape drifted
 *   2  usage or configuration error
 *   3  skipped — no usable token on this machine
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { displayPath } from '../src/lib/paths';
import { redactText, safeErrorMessage } from '../src/lib/redact';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Claude Code identifies itself this way and the endpoint is known to accept
 * it. 2.1.269 is this project's minimum supported CLI, so the probe claims no
 * newer contract than the dashboard already relies on.
 */
const USER_AGENT = 'claude-cli/2.1.269 (external, cli)';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Structured members the payload is known to carry beyond the window list. They
 * are not modelled by the dashboard, but they are understood, so reporting them
 * as drift would bury the signal that matters.
 */
const KNOWN_STRUCTURES = [
  'extra_usage',
  'limits',
  'spend',
  'seven_day_breakdown',
  'member_dashboard_available',
] as const;

/** Windows the payload is expected to carry. Absent ones are reported, not failed. */
const KNOWN_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_oauth_apps',
] as const;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

type Options = {
  credentialsPath: string;
  tokenEnvName: string;
  timeoutMs: number;
};

type TokenSource = {
  token: string;
  origin: string;
  /** Epoch milliseconds, when the origin states one. */
  expiresAt: number | null;
  scopes: string[] | null;
};

function parseArgs(argv: string[]): Options | number {
  const options: Options = {
    credentialsPath: join(homedir(), '.claude', '.credentials.json'),
    tokenEnvName: 'CLAUDE_OAUTH_TOKEN',
    timeoutMs: 20_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return usage(0);

    const value = argv[i + 1];
    if (arg === '--credentials') {
      if (!value) return usage(2, '--credentials needs a path');
      options.credentialsPath = value;
      i += 1;
    } else if (arg === '--token-env') {
      if (!value) return usage(2, '--token-env needs a variable name');
      options.tokenEnvName = value;
      i += 1;
    } else if (arg === '--timeout') {
      const ms = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(ms) || ms <= 0) return usage(2, '--timeout needs milliseconds');
      options.timeoutMs = ms;
      i += 1;
    } else {
      return usage(2, `unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(code: number, message?: string): number {
  const stream = code === 0 ? process.stdout : process.stderr;
  if (message) stream.write(`error: ${message}\n\n`);
  stream.write(
    [
      'usage: pnpm run spike:claude-usage [options]',
      '',
      '  --credentials <path>  credentials file to read (default ~/.claude/.credentials.json)',
      '  --token-env <NAME>    environment variable holding a token (default CLAUDE_OAUTH_TOKEN)',
      '  --timeout <ms>        request timeout (default 20000)',
      '',
      'A token from `claude setup-token` in the environment is preferred: it is',
      'long-lived and standalone, so the probe never races Claude Code for the',
      'credentials file. Sends exactly one request; never retries a 429.',
      '',
    ].join('\n'),
  );
  return code;
}

/**
 * Prefer an explicit environment token. Fall back to the credentials file,
 * which is read-only here — this script never writes it.
 */
function resolveToken(options: Options): TokenSource | null {
  const fromEnv = process.env[options.tokenEnvName]?.trim();
  if (fromEnv) {
    return { token: fromEnv, origin: `$${options.tokenEnvName}`, expiresAt: null, scopes: null };
  }

  let raw: string;
  try {
    raw = readFileSync(options.credentialsPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
  const token = oauth?.['accessToken'];
  if (typeof token !== 'string' || token.length === 0) return null;

  const expiresAt = oauth?.['expiresAt'];
  const scopes = oauth?.['scopes'];

  return {
    token,
    origin: displayPath(options.credentialsPath),
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : null,
  };
}

/**
 * Render a value's structure with every leaf elided. This is the artefact worth
 * pasting into the discovery record: it proves the field set without ever
 * disclosing a percentage, a credit balance, or an account identifier.
 */
function describeShape(value: unknown, indent = '  '): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value === 'string') return ISO_8601.test(value) ? '<iso8601>' : '<string>';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[ ${value.length} x ${describeShape(value[0], `${indent}  `)} ]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const width = Math.max(...entries.map(([key]) => key.length));
    const lines = entries.map(
      ([key, child]) => `${indent}${key.padEnd(width)}  ${describeShape(child, `${indent}  `)}`,
    );
    return `{\n${lines.join('\n')}\n${indent.slice(2)}}`;
  }

  return '<unknown>';
}

/**
 * Replace every top-level key this probe does not recognise with a positional
 * placeholder. Those keys read as canaries and this repository does not publish
 * them — but their structure is exactly what makes the shape block evidence, so
 * the value's shape survives and only the name is dropped. Without this the
 * block below printed the names in full while the summary claimed they were
 * withheld.
 */
function withheldKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let withheld = 0;
  for (const [key, value] of Object.entries(record)) {
    out[known.has(key) ? key : `<withheld ${(withheld += 1)}>`] = value;
  }
  return out;
}

/** Contract assertions. Each returns a problem string, or null when satisfied. */
function checkContract(payload: Record<string, unknown>): string[] {
  const problems: string[] = [];

  // The adapter is specified to read `limits[]` and to ignore the individual
  // window keys, so the absence of any one of them — `five_hour` included — is
  // not a failure. Gating on a shape nothing consumes would fail the probe for a
  // drift the dashboard is designed to survive. They are still validated when
  // present: a window that changed type is evidence the contract moved, and the
  // output reports which ones carried data.
  const present = KNOWN_WINDOWS.filter((name) => name in payload);

  for (const name of present) {
    const window = payload[name];
    if (window === null) continue; // A null window means "not applicable to this plan".
    if (typeof window !== 'object') {
      problems.push(`${name} is ${typeof window}, expected an object or null`);
      continue;
    }

    const { utilization, resets_at: resetsAt } = window as Record<string, unknown>;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
      problems.push(`${name}.utilization is not a finite number`);
    } else if (utilization < 0 || utilization > 100) {
      problems.push(`${name}.utilization is outside 0..100`);
    }
    if (resetsAt !== null && resetsAt !== undefined) {
      if (typeof resetsAt !== 'string' || !ISO_8601.test(resetsAt)) {
        problems.push(`${name}.resets_at is not an ISO-8601 string`);
      } else if (Number.isNaN(Date.parse(resetsAt))) {
        problems.push(`${name}.resets_at does not parse as a date`);
      }
    }
  }

  // `limits[]` is the projection the adapter is specified to read, so the probe
  // has to prove that contract too. Validating only the window keys would gate a
  // shape nothing actually consumes.
  const limits = payload['limits'];
  if (limits === undefined) {
    problems.push('`limits` is absent — the adapter is specified to read that projection');
  } else if (!Array.isArray(limits)) {
    problems.push('`limits` is not an array');
  } else {
    if (limits.length === 0) problems.push('`limits` is empty while windows carry data');
    limits.forEach((entry, index) => {
      const at = `limits[${index}]`;
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`${at} is not an object`);
        return;
      }
      const row = entry as Record<string, unknown>;
      const percent = row['percent'];
      if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        problems.push(`${at}.percent is not a finite number`);
      } else if (percent < 0 || percent > 100) {
        problems.push(`${at}.percent is outside 0..100`);
      }
      if (typeof row['is_active'] !== 'boolean') {
        problems.push(`${at}.is_active is not a boolean`);
      }
      for (const key of ['kind', 'group', 'severity']) {
        if (typeof row[key] !== 'string') problems.push(`${at}.${key} is not a string`);
      }
      const resetsAt = row['resets_at'];
      if (resetsAt !== null && resetsAt !== undefined) {
        // The pattern alone accepts `2026-99-99T99:99:99`. The adapter turns this
        // field into a reset time, so it has to be a date, not a date-shaped
        // string.
        if (typeof resetsAt !== 'string' || !ISO_8601.test(resetsAt)) {
          problems.push(`${at}.resets_at is neither null nor an ISO-8601 string`);
        } else if (Number.isNaN(Date.parse(resetsAt))) {
          problems.push(`${at}.resets_at does not parse as a date`);
        }
      }
    });
  }

  // The status-line spool names these fields differently. Catching the swap here
  // is the point: an adapter that assumed the spool contract would read zeroes.
  if ('used_percentage' in payload) {
    problems.push('payload uses `used_percentage`, not `utilization` — contract has shifted');
  }

  // Nothing account-identifying should need storing. Prove it rather than assume it.
  if (EMAIL.test(JSON.stringify(payload))) {
    problems.push('payload contains an email address — normalisation must drop it');
  }

  return problems;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'number') return parsed;
  const options = parsed;

  const out = process.stdout;
  out.write(`probe  ${USAGE_URL}\n`);

  const source = resolveToken(options);
  if (!source) {
    process.stderr.write(
      [
        'skipped: no token found.',
        `  looked at $${options.tokenEnvName}, then ${displayPath(options.credentialsPath)}`,
        '  mint a standalone one with: claude setup-token',
        `  then: ${options.tokenEnvName}=<token> pnpm run spike:claude-usage`,
        '',
      ].join('\n'),
    );
    return 3;
  }

  out.write(`token  ${source.origin}\n`);
  if (source.scopes) out.write(`scopes ${source.scopes.join(' ')}\n`);

  if (source.expiresAt !== null) {
    const minutes = Math.floor((source.expiresAt - Date.now()) / 60_000);
    if (minutes <= 0) {
      process.stderr.write(
        [
          '',
          'skipped: that token is expired.',
          "  Refreshing it here would race Claude Code's own rotation of the same",
          '  file, so this script will not do it. Either run a Claude Code session',
          '  (which refreshes it), or mint a standalone token:',
          '    claude setup-token',
          '',
        ].join('\n'),
      );
      return 3;
    }
    out.write(`expiry in ${minutes} min\n`);
  }

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${source.token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'anthropic-beta': OAUTH_BETA,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    process.stderr.write(`\nFAILED network error: ${safeErrorMessage(err)}\n`);
    return 1;
  }

  out.write(`status ${response.status} ${response.statusText}\n`);

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    process.stderr.write(
      [
        '',
        'FAILED rate limited.',
        `  Retry-After: ${retryAfter ?? '(absent — no anchor for backoff)'}`,
        '  This endpoint escalates 30/60/120/240/300s and can stay stuck at 300s.',
        '  Do not loop on it. Wait, then probe again at most once every ~5 minutes.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (!response.ok) {
    // An upstream error body is free text from outside this process, so it goes
    // through the same redaction boundary as every other diagnostic the project
    // emits. Printing it raw would have been the one place this script broke the
    // contract it exists to defend.
    const body = redactText((await response.text()).slice(0, 300));
    const hint =
      response.status === 401 || response.status === 403
        ? '\n  A plain ANTHROPIC_API_KEY does not work here; this needs a subscription OAuth token.'
        : '';
    process.stderr.write(`\nFAILED ${response.status}: ${body}${hint}\n`);
    return 1;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    process.stderr.write(`\nFAILED response is not JSON: ${safeErrorMessage(err)}\n`);
    return 1;
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    process.stderr.write('\nFAILED response is not a JSON object\n');
    return 1;
  }

  const record = payload as Record<string, unknown>;

  const known = new Set<string>([...KNOWN_WINDOWS, ...KNOWN_STRUCTURES]);

  out.write('\nshape (values elided, unrecognised names withheld — this block is the evidence)\n');
  out.write(`${describeShape(withheldKeys(record, known))}\n`);

  const unrecognised = Object.keys(record).filter((key) => !known.has(key));
  if (unrecognised.length > 0) {
    // The names are withheld on purpose: they read as canaries, and this
    // repository does not publish them. The counts still expose drift.
    const carrying = unrecognised.filter((key) => record[key] !== null).length;
    out.write(`\nkeys this probe does not recognise: ${unrecognised.length}`);
    out.write(` (${carrying} carrying a value, names withheld)\n`);
  }

  const structures = KNOWN_STRUCTURES.filter((key) => key in record);
  if (structures.length > 0) {
    out.write(`\nknown but deliberately unmodelled: ${structures.join(', ')}\n`);
  }

  const active = KNOWN_WINDOWS.filter((name) => name in record && record[name] !== null);
  out.write(`\nwindows carrying data: ${active.length > 0 ? active.join(', ') : '(none)'}\n`);

  const problems = checkContract(record);
  if (problems.length > 0) {
    process.stderr.write('\nFAILED contract problems:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }

  out.write('\nPASSED endpoint answers without a live session and the shape holds.\n');
  out.write('Record the shape block above in docs/discovery/, not the values.\n');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`unexpected error: ${safeErrorMessage(err)}\n`);
    process.exitCode = 2;
  });
