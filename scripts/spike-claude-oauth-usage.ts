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
 *   and tells you to run a Claude Code session, which refreshes it.
 *
 * A `claude setup-token` token cannot pass this gate: it is inference-only, and
 * the endpoint answers `403` without the `user:profile` scope. The dashboard's
 * optional Claude source is therefore the rate-limit header probe in
 * src/lib/adapters/claude-usage.ts, not this endpoint (M0 discovery,
 * 2026-09-17).
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
import { pathToFileURL } from 'node:url';
import { displayPath } from '../src/lib/paths';
import { safeErrorMessage } from '../src/lib/redact';

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

const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Is this an instant that actually exists?
 *
 * `Date.parse` is not enough on its own: it silently rolls an impossible
 * calendar date forward, so `2026-02-31T00:00:00Z` becomes 3 March and passes.
 * A reset time that moves three days when it is read is worse than one that is
 * rejected. Validate the written calendar components before parsing, without
 * comparing its local date to UTC — a legitimate offset may cross midnight.
 */
export function isRealInstant(value: string): boolean {
  const match = ISO_8601.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] ? Number(match[9]) : 0;
  const offsetMinute = match[8] ? Number(match[10]) : 0;

  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;

  return !Number.isNaN(Date.parse(value));
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

type Options = {
  credentialsPath: string;
  tokenEnvName: string;
  timeoutMs: number;
  /**
   * Print the `kind` and `group` values of `limits[]`, which the shape block
   * elides like every other leaf.
   *
   * This is the single, deliberate exception to "every leaf elided", and it is
   * opt-in because the probe cannot know in advance that these two fields are
   * safe. They name the window a limit applies to, so they should read like
   * `five_hour`; an adapter needs them to label a gauge, and there is no other
   * way to learn them. Read the output before copying anything into the
   * repository: a value that reads as a codename rather than a window name is
   * one this repository does not publish.
   */
  showLimitKinds: boolean;
};

type TokenSource = {
  token: string;
  origin: string;
  /** Epoch milliseconds, when the origin states one. */
  expiresAt: number | null;
};

function parseArgs(argv: string[]): Options | number {
  const options: Options = {
    credentialsPath: join(homedir(), '.claude', '.credentials.json'),
    tokenEnvName: 'CLAUDE_OAUTH_TOKEN',
    timeoutMs: 20_000,
    showLimitKinds: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return usage(0);
    if (arg === '--show-limit-kinds') {
      options.showLimitKinds = true;
      continue;
    }

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
      '  --show-limit-kinds    also print limits[].kind and .group, which the shape',
      '                        block elides. Needed to label a polled window; read',
      '                        the output before copying any value into the repo.',
      '',
      'Needs a full-login token, which carries the user:profile scope. A token',
      'from `claude setup-token` is inference-only and answers 403 here. Sends',
      'exactly one request; never retries a 429.',
      '',
    ].join('\n'),
  );
  return code;
}

/**
 * Prefer an explicit environment token. Fall back to the credentials file,
 * which is read-only here — this script never writes it.
 */
export function resolveToken(options: Options): TokenSource | null {
  const fromEnv = process.env[options.tokenEnvName]?.trim();
  if (fromEnv) {
    return { token: fromEnv, origin: `$${options.tokenEnvName}`, expiresAt: null };
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

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
  const rawToken = oauth?.['accessToken'];
  if (typeof rawToken !== 'string') return null;
  const token = rawToken.trim();
  if (token.length === 0) return null;

  const expiresAt = oauth?.['expiresAt'];

  return {
    token,
    origin: displayPath(options.credentialsPath),
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
  };
}

/**
 * Render a value's structure with every leaf elided. This is the artefact worth
 * pasting into the discovery record: it proves the field set without ever
 * disclosing a percentage, a credit balance, or an account identifier.
 */
function describeShape(
  value: unknown,
  known: ReadonlySet<string>,
  counter: { n: number },
  indent = '  ',
): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value === 'string') return ISO_8601.test(value) ? '<iso8601>' : '<string>';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[ ${value.length} x ${describeShape(value[0], known, counter, `${indent}  `)} ]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => [known.has(key) ? key : `<withheld ${(counter.n += 1)}>`, child] as const,
    );
    if (entries.length === 0) return '{}';
    const width = Math.max(...entries.map(([key]) => key.length));
    const lines = entries.map(
      ([key, child]) =>
        `${indent}${key.padEnd(width)}  ${describeShape(child, known, counter, `${indent}  `)}`,
    );
    return `{\n${lines.join('\n')}\n${indent.slice(2)}}`;
  }

  return '<unknown>';
}

/** Count withheld names through every array element, even though the shape prints one exemplar. */
export function countWithheldKeys(value: unknown, known: ReadonlySet<string>): number {
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + countWithheldKeys(child, known), 0);
  }
  if (typeof value !== 'object' || value === null) return 0;

  return Object.entries(value as Record<string, unknown>).reduce(
    (total, [key, child]) => total + (known.has(key) ? 0 : 1) + countWithheldKeys(child, known),
    0,
  );
}

/**
 * Every field name this probe understands, at any depth.
 *
 * The payload's own vocabulary is the allowlist. Anything outside it is
 * withheld by name when the shape is printed, because the endpoint carries keys
 * with non-descriptive names that read as canaries and this repository does not
 * publish them. A flat set rather than a per-structure one is deliberate: a
 * known field name is safe to print wherever it appears, and a name nobody
 * recognises is worth withholding wherever it appears.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  // Window members.
  'utilization',
  'resets_at',
  'limit_dollars',
  'used_dollars',
  'remaining_dollars',
  'locked_reason',
  // `extra_usage`.
  'is_enabled',
  'monthly_limit',
  'used_credits',
  'currency',
  'decimal_places',
  'disabled_reason',
  'user_disabled',
  'spend_limit_reached',
  'credits_ever_enabled',
  'daily',
  'weekly',
  // `limits[]`.
  'kind',
  'group',
  'percent',
  'severity',
  'scope',
  'is_active',
  // `spend` and `spend.used`.
  'used',
  'limit',
  'enabled',
  'cap',
  'balance',
  'auto_reload',
  'disclaimer',
  'can_purchase_credits',
  'can_toggle',
  'amount_minor',
  'exponent',
  // `seven_day_breakdown` and its rows.
  'as_of',
  'window_started_at',
  'rows',
  'key',
  'display_name',
]);

/** Contract assertions. Each returns a problem string, or null when satisfied. */
export function checkContract(payload: Record<string, unknown>): string[] {
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
      if (typeof resetsAt !== 'string') {
        problems.push(`${name}.resets_at is not a string`);
      } else if (!isRealInstant(resetsAt)) {
        problems.push(`${name}.resets_at is not a real ISO-8601 instant`);
      }
    }
  }

  // `limits[]` is the projection the adapter is specified to read, so the probe
  // has to prove that contract too. Validating only the window keys would gate a
  // shape nothing actually consumes.
  const limits = payload['limits'];
  if (limits !== undefined && !Array.isArray(limits)) {
    problems.push('`limits` is not an array');
  } else if (Array.isArray(limits)) {
    limits.forEach((entry, index) => {
      const at = `limits[${index}]`;
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`${at} is not an object`);
        return;
      }
      const row = entry as Record<string, unknown>;
      if (typeof row['is_active'] !== 'boolean') {
        problems.push(`${at}.is_active is not a boolean`);
        return;
      }
      // Inactive rows do not become gauges, so their remaining projection is irrelevant.
      if (row['is_active'] === false) return;

      const percent = row['percent'];
      if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        problems.push(`${at}.percent is not a finite number`);
      } else if (percent < 0 || percent > 100) {
        problems.push(`${at}.percent is outside 0..100`);
      }
      // `kind` names the window and is the one field that must always be there.
      if (typeof row['kind'] !== 'string') problems.push(`${at}.kind is not a string`);
      if (typeof row['severity'] !== 'string') problems.push(`${at}.severity is not a string`);
      // `group` and `scope` are nullable — the adapter's bucket id is specified
      // to omit them when null, so demanding a string here would fail the probe
      // on a payload the dashboard handles correctly. They must stay scalar
      // though: an object would silently become "[object Object]" in a key.
      for (const key of ['group', 'scope']) {
        if (!Object.hasOwn(row, key)) {
          problems.push(`${at}.${key} is absent`);
          continue;
        }
        const value = row[key];
        if (value !== null && typeof value !== 'string') {
          problems.push(`${at}.${key} is neither null nor a string`);
        }
      }
      if (!Object.hasOwn(row, 'resets_at')) {
        problems.push(`${at}.resets_at is absent`);
        return;
      }
      const resetsAt = row['resets_at'];
      if (resetsAt !== null) {
        if (typeof resetsAt !== 'string') {
          problems.push(`${at}.resets_at is neither null nor a string`);
        } else if (!isRealInstant(resetsAt)) {
          problems.push(`${at}.resets_at is not a real ISO-8601 instant`);
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

/** The adapter maps these valid shapes to `not_entitled` rather than schema drift. */
export function isNotEntitledPayload(payload: Record<string, unknown>): boolean {
  const limits = payload['limits'];
  return (
    limits === undefined ||
    (Array.isArray(limits) &&
      (limits.length === 0 ||
        limits.every(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            (entry as Record<string, unknown>)['is_active'] === false,
        )))
  );
}

/** Format an HTTP failure without accepting, reading, or rendering its provider body. */
export function formatHttpFailure(status: number): string {
  const hint =
    status === 401 || status === 403
      ? '\n  A plain ANTHROPIC_API_KEY does not work here; this needs a subscription OAuth token.'
      : '';
  return `\nFAILED ${status}${hint}\n`;
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
        '  log in with `claude` (a setup-token token lacks the user:profile scope)',
        `  or: ${options.tokenEnvName}=<full-login token> pnpm run spike:claude-usage`,
        '',
      ].join('\n'),
    );
    return 3;
  }

  out.write(`token  ${source.origin}\n`);

  if (source.expiresAt !== null) {
    const minutes = Math.floor((source.expiresAt - Date.now()) / 60_000);
    if (minutes <= 0) {
      process.stderr.write(
        [
          '',
          'skipped: that token is expired.',
          "  Refreshing it here would race Claude Code's own rotation of the same",
          '  file, so this script will not do it. Run a Claude Code session, which',
          '  refreshes it. A `claude setup-token` token cannot read this endpoint.',
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

  out.write(`status ${response.status}\n`);

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    process.stderr.write(
      [
        '',
        'FAILED rate limited.',
        `  Retry-After: ${retryAfter === null ? '(absent — no anchor for backoff)' : '(present; value withheld)'}`,
        '  This endpoint escalates 30/60/120/240/300s and can stay stuck at 300s.',
        '  Do not loop on it. Wait, then probe again at most once every ~5 minutes.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (!response.ok) {
    // A failure body is an untrusted raw provider payload. Redacting identifiers
    // cannot prove that quota values or unknown sensitive fields are gone, so do
    // not read or print it at all.
    process.stderr.write(formatHttpFailure(response.status));
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

  const known = new Set<string>([...KNOWN_WINDOWS, ...KNOWN_STRUCTURES, ...KNOWN_FIELDS]);
  const withheld = { n: 0 };
  const withheldTotal = countWithheldKeys(record, known);

  out.write('\nshape (values elided, unrecognised names withheld — this block is the evidence)\n');
  out.write(`${describeShape(record, known, withheld)}\n`);

  const problems = checkContract(record);
  if (problems.length > 0) {
    process.stderr.write('\nFAILED contract problems:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }

  if (options.showLimitKinds) {
    const limits = Array.isArray(record['limits']) ? (record['limits'] as unknown[]) : [];
    const pairs = limits.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const kind = typeof row['kind'] === 'string' ? row['kind'] : '<not a string>';
      const group = typeof row['group'] === 'string' ? row['group'] : String(row['group']);
      return `  kind=${kind} group=${group}`;
    });
    out.write('\nlimits[] identities (the one leaf this probe will print on request)\n');
    out.write(`${pairs.join('\n')}\n`);
    out.write('Copy a value into WINDOW_LABELS only if it reads as a window name.\n');
  }

  // Two different numbers, because they answer two different questions. The
  // top-level count is the drift signal for a new window or structure; the
  // total traverses every array row, while the shape block prints one exemplar.
  const unrecognised = Object.keys(record).filter((key) => !known.has(key));
  if (withheldTotal > 0) {
    // The names themselves are withheld on purpose: they read as canaries, and
    // this repository does not publish them. The counts still expose drift.
    const carrying = unrecognised.filter((key) => record[key] !== null).length;
    out.write(`\nkeys this probe does not recognise: ${unrecognised.length} at the top level`);
    out.write(` (${carrying} carrying a value), ${withheldTotal} in total, names withheld\n`);
  }

  const structures = KNOWN_STRUCTURES.filter((key) => key in record);
  if (structures.length > 0) {
    out.write(`\nknown but deliberately unmodelled: ${structures.join(', ')}\n`);
  }

  const active = KNOWN_WINDOWS.filter((name) => name in record && record[name] !== null);
  out.write(`\nwindows carrying data: ${active.length > 0 ? active.join(', ') : '(none)'}\n`);

  const notEntitled = isNotEntitledPayload(record);
  out.write(
    notEntitled
      ? '\nPASSED endpoint answers without a live session; limits are not_entitled.\n'
      : '\nPASSED endpoint answers without a live session and the shape holds.\n',
  );
  out.write('Record the shape block above in docs/discovery/, not the values.\n');
  return 0;
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`unexpected error: ${safeErrorMessage(err)}\n`);
      process.exitCode = 2;
    });
}
