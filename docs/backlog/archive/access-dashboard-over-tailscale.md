---
type: Backlog Brief
title: Reach the dashboard from a phone over Tailscale
---

# Reach the dashboard from a phone over Tailscale

## Status

Archived

Delivered on 2026-10-10 on branch `feat/tailscale-allowed-origins`; the delivery and its
verification record are in the [log](../../log.md). The contract lives in
[Setup](../../operations/setup.md) §6 "From a phone (Tailscale)" and the plan §5 rule. The
human-only phone checks stay recorded as unperformed in the log. This brief is not updated
further.

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

A phone on the user's tailnet opens the dashboard at `https://<machine>.<tailnet>.ts.net:8443/`, and
manual refresh works there. The Next.js server still binds only to loopback, and nothing outside
the tailnet can reach it.

## Context

The dashboard runs as `ai-usage-dashboard-web.service` on `127.0.0.1:3838`
([Setup](../../operations/setup.md) §6). `loadConfig` in `src/lib/config.ts` rejects a
non-loopback `AUD_HOST`. The last security rule in the
[plan](../../plan/ai-usage-dashboard-implementation-plan.md) (§5) sets the bar for phone access:
add authentication, TLS, an origin policy, and a private network, while the Next.js server stays
bound to loopback behind a trusted local daemon.

`tailscale serve` meets that bar without opening a non-loopback listener in the application:

- `tailscaled` listens on the tailnet address, terminates HTTPS with a tailnet certificate, and
  proxies to `127.0.0.1:3838`.
- Only tailnet devices that the tailnet access policy allows can connect, so device identity acts
  as the authentication.
- The Next.js server stays on loopback, so the Setup §11 promise "bind to anything but loopback"
  still holds literally.

Tailnet device identity is accepted as the plan's "authentication", and tailnet HTTPS
certificates are used (decided [2026-10-09](../../log.md#2026-10-09)). No in-app check is added.

Checked on the development machine on 2026-09-14: MagicDNS is on, the Tailscale operator is the
login user (no `sudo` needed), no serve configuration exists, and HTTPS certificates are not yet
enabled for the tailnet.

With no code change, reading already works through `tailscale serve`, because page requests are
not guarded. Refresh does not:

- `requireSameOrigin` in `src/lib/server/security.ts` accepts only `allowedOrigins(config)`: the
  three `http://` loopback origins on `AUD_PORT`.
- The phone's browser sends `Origin: https://<machine>.<tailnet>.ts.net:8443`, so every refresh is
  refused with `403 cross_origin_denied`.
- The collector timer keeps collecting either way.

The guard must not be loosened by trusting `Host` or `X-Forwarded-Host`. The plan forbids
header-based trust, and any local process can send those headers.

## Dependencies and Gates

Every gate is closed; the user decided the direction on
[2026-10-09](../../log.md#2026-10-09):

- Tailnet device identity satisfies the plan's authentication rule; no in-app check is added.
  Plan §5 records this.
- Tailnet HTTPS certificates are used, so the allowlisted origin is `https:`.
- The tailnet holds only the user's own devices, so no tailnet access rule is required.
- Refresh from the phone is in scope, and the added origin is accepted by every mutating route,
  including Settings.
- The code, tests, and documentation changes are inside the agent's executable scope.

Human-only, not needed to implement or merge, but needed to close the live checks: enable the
tailnet HTTPS certificate, run `tailscale serve --bg --https=8443 3838`, and verify from the phone. An agent
cannot operate the phone, so report which live checks were actually performed.

## Scope

### In scope

- `AUD_ALLOWED_ORIGINS`: an optional, comma-separated list of extra exact origins that the
  same-origin guard accepts, validated when the configuration loads.
- The extra origin is accepted by every route that calls `requireSameOrigin`, including the
  Settings routes; no route stays loopback-only.
- A Setup subsection covering `tailscale serve`, the variable, and how to turn exposure off, plus
  the §7 row, `.env.example`, and the README security posture.
- Running `tailscale serve` and the live check from the phone, both performed by the user.

### Out of scope

- The `AUD_HOST` policy and the bind address, which stay loopback-only.
- `tailscale funnel` or any other public exposure.
- In-app authentication, including reading Tailscale identity headers such as
  `Tailscale-User-Login`.
- Installer automation of the serve configuration. `tailscaled` persists it across reboots.
- Any change to `Host` handling.

## Approach

1. `src/lib/config.ts`: add `AUD_ALLOWED_ORIGINS: z.string().optional()` to the environment
   schema and expose `extraOrigins: readonly string[]` on `AppConfig`.
   - A blank value means no extra origins.
   - Each comma-separated entry is trimmed and must parse with `new URL`, use `https:`, and
     satisfy `url.origin === entry`. That rejects paths, queries, a trailing slash, credentials,
     `*`, and `null`.
   - An invalid entry throws `ConfigError`, naming the entry.
2. `src/lib/server/security.ts`: `allowedOrigins` returns the three loopback origins followed by
   `config.extraOrigins`. The comparison stays an exact string match. Every route that calls
   `requireSameOrigin`, including Settings, then accepts the extra origin. Update the module
   comment, which currently assumes a loopback-only browser origin.
3. Tests:
   - `tests/unit/config-time.test.ts`: the default, accepted entries, and each rejected shape.
   - `tests/integration/api-security.test.ts`: the configured origin passes, and its `http://`
     twin and another `ts.net` host are refused. `testConfig` already goes through `loadConfig`,
     so the helper needs no change.
   - `tests/integration/settings-route.test.ts`: with the variable set, a Settings request whose
     `Origin` equals the entry passes the guard, proving the added origin is not refresh-only.
4. Documentation:
   - Setup §6 gets a "From a phone (Tailscale)" subsection:
     - `tailscale serve --bg --https=8443 3838` and `tailscale serve status`;
     - `AUD_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net:8443` in `collector.env`, which the web
       server reads because `getConfig` calls `loadCollectorEnvFile` and the web unit sets
       `AUD_ENV_FILE`;
     - `systemctl --user restart ai-usage-dashboard-web.service`;
     - turning exposure off with `tailscale serve --https=8443 off`;
     - a warning never to use `funnel`.
   - Correct the §6 sentence saying that authentication, TLS, and an origin policy "none of those
     exist yet", and add the §7 row.
   - Add a commented line to `.env.example` and a bullet to the README security posture. The plan
     §5 rule and the log `Decision` are already recorded (2026-10-09).

## Files Touched

| Path                                       | Change                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `src/lib/config.ts`                        | `AUD_ALLOWED_ORIGINS` parsing; `extraOrigins`          |
| `src/lib/server/security.ts`               | `allowedOrigins` appends `extraOrigins`; comment       |
| `tests/unit/config-time.test.ts`           | Default, accepted, and rejected origin entries         |
| `tests/integration/api-security.test.ts`   | Configured origin accepted; near-misses refused        |
| `tests/integration/settings-route.test.ts` | Settings route accepts the added origin                |
| `docs/operations/setup.md`                 | §6 Tailscale subsection and corrected sentence; §7 row |
| `.env.example`, `README.md`                | Commented variable; security posture bullet            |

## Acceptance Criteria

Agent-verifiable:

- [ ] Without `AUD_ALLOWED_ORIGINS`, `allowedOrigins` returns exactly the three loopback origins.
- [ ] Configuration loading rejects `http://x.ts.net`, `https://x.ts.net/`,
      `https://x.ts.net/path`, `https://user@x.ts.net`, `*`, and `null`, naming the entry.
- [ ] With the variable set, a refresh whose `Origin` equals the entry passes the guard, and its
      `http://` twin and a different `ts.net` host get `403`.
- [ ] A Settings route request whose `Origin` equals the entry passes the guard, proving the added
      origin is not refresh-only.
- [ ] A non-loopback `AUD_HOST` still fails at startup.
- [ ] `pnpm run verify` and the OKF validator pass.

Human-only (the user, from the phone):

- [ ] `ss -ltn` shows the Next.js server only on `127.0.0.1:3838`.
- [ ] From the phone on the tailnet, the page loads over HTTPS and Refresh updates a card, adding a
      manual row to `collector_runs`.
- [ ] With Tailscale disconnected on the phone, the address does not connect, and
      `tailscale funnel status` shows no public exposure.

## Testing

- Focused: `pnpm exec vitest run tests/unit/config-time.test.ts tests/integration/api-security.test.ts tests/integration/settings-route.test.ts`.
- `pnpm run test:e2e` still passes on the loopback path.
- Live, done by the user with the phone:
  - `tailscale serve status` and `ss -ltn`;
  - page load and Refresh from the phone;
  - the new `collector_runs` row;
  - the check with Tailscale disconnected.

  An agent cannot operate the phone, so report which live checks were actually performed.

- `pnpm run verify` is the final gate.

## Open Questions
