/**
 * Validated configuration with safe defaults.
 *
 * The application must start and stay useful with an entirely empty
 * environment. Anything that *is* set is validated here so a typo surfaces at
 * startup rather than as a mystery at collection time.
 *
 * Only `AUD_*` settings come from the environment, including `collector.env`.
 * Provider keys are saved in dashboard Settings and read from the database
 * (`src/lib/db/credentials.ts`); an unsaved key is an `unavailable` card.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadCollectorEnvFile } from './env-file';
import { compareMoney, toMoneyOrNull } from './money';
import { PathError, userPath, xdgBaseDir } from './paths';

/** Threshold pair for quota gauges, expressed as *remaining* percent. */
const quotaThresholdSchema = z
  .object({
    watchAtOrBelowPercent: z.number().min(0).max(100),
    switchAtOrBelowPercent: z.number().min(0).max(100),
  })
  .refine((t) => t.switchAtOrBelowPercent <= t.watchAtOrBelowPercent, {
    message: 'switchAtOrBelowPercent must not exceed watchAtOrBelowPercent',
  });

const decimalString = z
  .string()
  .refine((v) => toMoneyOrNull(v) !== null, { message: 'must be a decimal string' });

/** Threshold pair for money, as canonical decimal strings, per currency. */
const balanceThresholdSchema = z
  .object({
    watchAtOrBelow: decimalString,
    switchAtOrBelow: decimalString,
  })
  .refine(
    (t) => {
      const watch = toMoneyOrNull(t.watchAtOrBelow);
      const stop = toMoneyOrNull(t.switchAtOrBelow);
      // A non-decimal amount is already reported by its own field; nothing to order.
      return watch === null || stop === null || compareMoney(stop, watch) <= 0;
    },
    {
      message: 'switchAtOrBelow must not exceed watchAtOrBelow',
    },
  );

const PROVIDER_PATTERN = '(?:codex|claude|deepseek|openrouter)';

/**
 * `AUD_THRESHOLDS`: a JSON object merged over the defaults, key by key.
 *
 * Quota keys run from general to specific — `default`, `provider`,
 * `provider:window`, `provider:bucket:window` — so one window can be tuned
 * without restating the rest. Balance keys stay `provider:CURRENCY`.
 */
const thresholdOverridesSchema = z.strictObject({
  quota: z
    .record(
      z.string().regex(new RegExp(`^(?:default|${PROVIDER_PATTERN}(?::[A-Za-z0-9_.-]+){0,2})$`)),
      quotaThresholdSchema,
    )
    .optional(),
  balance: z
    .record(
      z.string().regex(new RegExp(`^${PROVIDER_PATTERN}:[A-Z0-9]{2,16}$`)),
      balanceThresholdSchema,
    )
    .optional(),
});

function parseThresholdOverrides(
  raw: string | undefined,
): z.infer<typeof thresholdOverridesSchema> {
  if (raw === undefined || raw.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError('AUD_THRESHOLDS is not valid JSON');
  }
  const parsed = thresholdOverridesSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${['AUD_THRESHOLDS', ...i.path.map(String)].join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid threshold override: ${issues}`);
  }
  return parsed.data;
}

const numericEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  AUD_DATA_DIR: z.string().optional(),
  AUD_TIMEZONE: z.string().optional(),
  AUD_HOST: z.string().optional(),
  AUD_PORT: numericEnv(3838, 1, 65535),
  AUD_RETENTION_DAYS: numericEnv(90, 1, 3650),
  AUD_COLLECT_INTERVAL_MINUTES: numericEnv(5, 1, 1440),
  AUD_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  AUD_THRESHOLDS: z.string().optional(),
  // Internal: set only by the development launcher (src/lib/dev-environment.ts).
  AUD_REFRESH_ENABLED: z.enum(['0', '1']).optional(),
});

/**
 * Provider key variables that are no longer read from any environment
 * (plan §3.5). They are listed only so `npm run collect` can warn that a stale
 * value is being ignored.
 */
export const RETIRED_CREDENTIAL_ENV_VARS = [
  'DEEPSEEK_API_KEY',
  'OPENROUTER_MANAGEMENT_KEY',
] as const;

export interface AppConfig {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly spoolPath: string;
  readonly timezone: string;
  readonly host: string;
  readonly port: number;
  readonly retentionDays: number;
  readonly collectIntervalMinutes: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Whether manual refresh may collect. Always on in production; a development
   * server turns it off unless `AUD_DEV_LIVE_REFRESH=1`, so refresh there
   * reaches no provider and writes nothing.
   */
  readonly refreshEnabled: boolean;
  readonly freshness: {
    /**
     * Polled sources go stale after this many missed intervals. Three is the
     * plan's default: it tolerates one transient failure plus one retry before
     * the card stops claiming to be current.
     */
    readonly pullMissedIntervals: number;
    /**
     * Claude only emits while a session is live, so its event can legitimately
     * be much older than a poll without being wrong. It still goes stale once
     * the observed window has reset.
     */
    readonly claudeEventMaxAgeMinutes: number;
  };
  readonly thresholds: {
    readonly quota: Record<string, z.infer<typeof quotaThresholdSchema>>;
    /** Keyed `provider:CURRENCY` so USD and CNY never share a threshold. */
    readonly balance: Record<string, z.infer<typeof balanceThresholdSchema>>;
  };
}

/**
 * Defaults chosen in M0 and documented in docs/operations/setup.md.
 *
 * Balance thresholds are per provider *and* per currency because a CNY balance
 * of 20 and a USD balance of 20 are not comparable amounts of runway.
 */
const DEFAULT_QUOTA_THRESHOLDS = {
  default: { watchAtOrBelowPercent: 20, switchAtOrBelowPercent: 10 },
} as const;

const DEFAULT_BALANCE_THRESHOLDS = {
  'deepseek:USD': { watchAtOrBelow: '5', switchAtOrBelow: '1' },
  'deepseek:CNY': { watchAtOrBelow: '35', switchAtOrBelow: '7' },
  'openrouter:USD': { watchAtOrBelow: '5', switchAtOrBelow: '1' },
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function validateTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new ConfigError(`AUD_TIMEZONE is not a valid IANA timezone: ${tz}`);
  }
}

/**
 * Loopback-only by policy. A non-loopback host is rejected outright rather than
 * warned about: the plan requires authentication and TLS before this dashboard
 * is ever reachable off-machine, and neither exists yet.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** A plain string map rather than `NodeJS.ProcessEnv`, so tests can pass a
 * minimal environment without having to satisfy the ambient Next.js
 * augmentations of that type. */
export type EnvLike = Record<string, string | undefined>;

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  const host = e.AUD_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `AUD_HOST must stay on loopback (got "${host}"). Exposing this dashboard requires authentication and TLS first.`,
    );
  }

  // A blank AUD_DATA_DIR (an empty line in collector.env) is absent, never the
  // current directory.
  let dataDir: string;
  try {
    dataDir = e.AUD_DATA_DIR?.trim()
      ? userPath('AUD_DATA_DIR', e.AUD_DATA_DIR)
      : join(
          xdgBaseDir(env['XDG_DATA_HOME'], join(homedir(), '.local', 'share')),
          'ai-usage-dashboard',
        );
  } catch (err) {
    if (err instanceof PathError) throw new ConfigError(err.message);
    throw err;
  }

  // Validate the shipped defaults with the same schemas that validate
  // user-supplied overrides, so a bad default cannot ship silently.
  const overrides = parseThresholdOverrides(e.AUD_THRESHOLDS);
  const quotaThresholds = {
    ...Object.fromEntries(
      Object.entries(DEFAULT_QUOTA_THRESHOLDS).map(([k, v]) => [k, quotaThresholdSchema.parse(v)]),
    ),
    ...overrides.quota,
  };
  const balanceThresholds = {
    ...Object.fromEntries(
      Object.entries(DEFAULT_BALANCE_THRESHOLDS).map(([k, v]) => [
        k,
        balanceThresholdSchema.parse(v),
      ]),
    ),
    ...overrides.balance,
  };

  return {
    dataDir,
    databasePath: join(dataDir, 'usage.db'),
    spoolPath: join(dataDir, 'spool', 'claude-statusline.json'),
    timezone: validateTimezone(e.AUD_TIMEZONE ?? 'Asia/Jakarta'),
    host,
    port: e.AUD_PORT,
    retentionDays: e.AUD_RETENTION_DAYS,
    collectIntervalMinutes: e.AUD_COLLECT_INTERVAL_MINUTES,
    logLevel: e.AUD_LOG_LEVEL ?? 'info',
    refreshEnabled: e.AUD_REFRESH_ENABLED !== '0',
    freshness: {
      pullMissedIntervals: 3,
      claudeEventMaxAgeMinutes: 12 * 60,
    },
    thresholds: {
      quota: quotaThresholds,
      balance: balanceThresholds,
    },
  };
}

/**
 * The names of the retired provider key variables that are set and non-blank.
 * Never returns a value.
 */
export function retiredCredentialEnvVars(env: EnvLike): string[] {
  return RETIRED_CREDENTIAL_ENV_VARS.filter((name) => Boolean(env[name]?.trim()));
}

let cached: AppConfig | null = null;

/**
 * Process-wide config. Cached so every module sees one consistent view.
 *
 * The collector environment file is merged into `process.env` first, so the
 * CLI, the web server's manual refresh, and the systemd unit all resolve the
 * same `AUD_*` settings. `loadConfig` itself stays pure for tests.
 */
export function getConfig(): AppConfig {
  if (cached === null) {
    loadCollectorEnvFile(process.env);
    cached = loadConfig(process.env);
  }
  return cached;
}

/** Test-only: drop the cache so a fresh environment can be loaded. */
export function resetConfigCache(): void {
  cached = null;
}
