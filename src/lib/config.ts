/**
 * Validated configuration with safe defaults.
 *
 * The application must start and stay useful with an entirely empty
 * environment: absent credentials become `unavailable` cards, never a boot
 * failure. Anything that *is* set is validated here so a typo surfaces at
 * startup rather than as a mystery at collection time.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const DEFAULT_DATA_DIR = join(
  process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'),
  'ai-usage-dashboard',
);

/** Threshold pair for quota gauges, expressed as *remaining* percent. */
const quotaThresholdSchema = z.object({
  watchAtOrBelowPercent: z.number().min(0).max(100),
  switchAtOrBelowPercent: z.number().min(0).max(100),
});

/** Threshold pair for money, as canonical decimal strings, per currency. */
const balanceThresholdSchema = z.object({
  watchAtOrBelow: z.string(),
  switchAtOrBelow: z.string(),
});

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
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENROUTER_MANAGEMENT_KEY: z.string().optional(),
});

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
  readonly credentials: {
    readonly deepseekApiKey: string | null;
    readonly openrouterManagementKey: string | null;
  };
}

/**
 * Defaults chosen in M0 and documented in docs/SETUP.md.
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

  const dataDir = e.AUD_DATA_DIR ?? DEFAULT_DATA_DIR;

  // An empty string is treated as absent so a blank line in an env file does
  // not turn into an auth_rejected error later.
  const nonEmpty = (v: string | undefined): string | null => {
    const t = v?.trim();
    return t ? t : null;
  };

  // Validate the shipped defaults with the same schemas that would validate
  // user-supplied overrides, so a bad default cannot ship silently.
  const quotaThresholds = Object.fromEntries(
    Object.entries(DEFAULT_QUOTA_THRESHOLDS).map(([k, v]) => [k, quotaThresholdSchema.parse(v)]),
  );
  const balanceThresholds = Object.fromEntries(
    Object.entries(DEFAULT_BALANCE_THRESHOLDS).map(([k, v]) => [
      k,
      balanceThresholdSchema.parse(v),
    ]),
  );

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
    freshness: {
      pullMissedIntervals: 3,
      claudeEventMaxAgeMinutes: 12 * 60,
    },
    thresholds: {
      quota: quotaThresholds,
      balance: balanceThresholds,
    },
    credentials: {
      deepseekApiKey: nonEmpty(e.DEEPSEEK_API_KEY),
      openrouterManagementKey: nonEmpty(e.OPENROUTER_MANAGEMENT_KEY),
    },
  };
}

let cached: AppConfig | null = null;

/** Process-wide config. Cached so every module sees one consistent view. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test-only: drop the cache so a fresh environment can be loaded. */
export function resetConfigCache(): void {
  cached = null;
}
