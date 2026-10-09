/**
 * Request guards for the local API.
 *
 * The server binds to loopback, so the threat model here is not a remote
 * attacker — it is *the browser*. Any page the user visits can issue a
 * cross-origin `POST http://127.0.0.1:3838/...`, and without a check that
 * request would trigger a real collection. Hence a same-origin requirement on
 * every mutating route.
 *
 * `Host` and `X-Forwarded-For` are deliberately not trusted as the control:
 * both are attacker-controlled request headers. `Origin` is set by the browser
 * itself and cannot be forged from page JavaScript, which is what makes it the
 * right signal.
 *
 * Fronted by a trusted local daemon such as `tailscale serve` (plan §5), the
 * browser's origin is that daemon's HTTPS origin rather than a loopback one.
 * Those exact origins are added through `AUD_ALLOWED_ORIGINS` and accepted here
 * like the loopback ones; the server still binds only to loopback.
 */
import type { NextRequest } from 'next/server';
import type { AppConfig } from '../config';

export interface GuardFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type GuardResult = { readonly ok: true } | GuardFailure;

/**
 * Origins the dashboard may legitimately be loaded from: the three loopback
 * origins on the configured port, then any `AUD_ALLOWED_ORIGINS` entries. The
 * comparison stays an exact string match, so the configured origins are extra
 * allowlist entries, never a relaxation of the loopback rule.
 */
export function allowedOrigins(config: AppConfig): string[] {
  return [
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    `http://[::1]:${config.port}`,
    ...config.extraOrigins,
  ];
}

/**
 * Enforce same-origin on a state-changing request.
 *
 * A missing `Origin` is rejected rather than waved through: browsers attach it
 * to every cross-site POST, so its absence means the request did not come from
 * the dashboard page.
 */
export function requireSameOrigin(request: NextRequest, config: AppConfig): GuardResult {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(config);

  if (!origin) {
    // `Sec-Fetch-Site: same-origin` is an acceptable substitute for non-browser
    // callers that Chrome/Firefox still label correctly (curl sends neither and
    // is therefore rejected, which is intended).
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite === 'same-origin') return { ok: true };
    return {
      ok: false,
      status: 403,
      code: 'origin_required',
      message: 'This endpoint requires a same-origin request from the dashboard.',
    };
  }

  if (!allowed.includes(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'cross_origin_denied',
      message: 'Cross-origin requests are not permitted.',
    };
  }

  return { ok: true };
}

/**
 * Fixed-window in-memory rate limiter.
 *
 * Scoped per key (provider) and deliberately process-local: this exists to stop
 * a held-down refresh button from hammering an upstream provider, not to defend
 * a multi-tenant service.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns `null` when allowed, or the seconds to wait when throttled. */
  check(key: string, now: number = Date.now()): number | null {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }

    recent.push(now);
    this.hits.set(key, recent);
    return null;
  }

  reset(): void {
    this.hits.clear();
  }
}

/** At most 6 manual refreshes per provider per minute. */
export const refreshLimiter = new RateLimiter(6, 60_000);

export function jsonError(failure: GuardFailure): Response {
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    { status: failure.status },
  );
}
