# Reach the dashboard from a phone over Tailscale

## Status

Ready for human

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md`,
`docs/discovery/M0_DISCOVERY.md`, `docs/operations/SETUP.md`, or `docs/log.md`.

Related issue: none yet

## Objective

A phone on the user's tailnet opens the dashboard at `https://<machine>.<tailnet>.ts.net/`, and
manual refresh works there. The Next.js server still binds only to loopback, and nothing outside
the tailnet can reach it.

## Context

The dashboard runs as `ai-usage-dashboard-web.service` on `127.0.0.1:3838`
([Setup](../../operations/SETUP.md) §6). `loadConfig` in `src/lib/config.ts` rejects a
non-loopback `AUD_HOST`. The last security rule in the
[plan](../../plan/AI_Usage_Dashboard_Implementation_Plan.md) (§5) sets the bar for phone access:
"add authentication, TLS, origin policy, and a private network before opening a non-loopback
listener".

`tailscale serve` meets that bar without opening a non-loopback listener in the application:

- `tailscaled` listens on the tailnet address, terminates HTTPS with a tailnet certificate, and
  proxies to `127.0.0.1:3838`.
- Only tailnet devices that the tailnet access policy allows can connect, so device identity acts
  as the authentication.
- The Next.js server stays on loopback, so the Setup §11 promise "bind to anything but loopback"
  still holds literally.

Whether tailnet device identity counts as the plan's "authentication" is the user's decision (see
Open Questions).

Checked on the development machine on 2026-09-14: MagicDNS is on, the Tailscale operator is the
login user (no `sudo` needed), no serve configuration exists, and HTTPS certificates are not yet
enabled for the tailnet.

With no code change, reading already works through `tailscale serve`, because page requests are
not guarded. Refresh does not:

- `requireSameOrigin` in `src/lib/server/security.ts` accepts only `allowedOrigins(config)`: the
  three `http://` loopback origins on `AUD_PORT`.
- The phone's browser sends `Origin: https://<machine>.<tailnet>.ts.net`, so every refresh is
  refused with `403 cross_origin_denied`.
- The collector timer keeps collecting either way.

The guard must not be loosened by trusting `Host` or `X-Forwarded-Host`. The plan forbids
header-based trust, and any local process can send those headers.

## Dependencies and Gates

- PR #1 is merged into `main`, including the web unit (`f80c013`). Owner: user.
- HTTPS certificates are enabled for the tailnet in the Tailscale admin console. This publishes
  the machine's `ts.net` name in Certificate Transparency logs. Owner: user.
- A `Decision` in `docs/log.md` that `tailscale serve` plus tailnet device identity satisfies the
  plan's phone-access rule, with the plan's §5 rule updated to match. Owner: user.
- Authorization to run `tailscale serve --bg 3838` on the machine. Owner: user.

## Scope

### In scope

- `AUD_ALLOWED_ORIGINS`: an optional, comma-separated list of extra exact origins that the
  same-origin guard accepts, validated when the configuration loads.
- A Setup subsection covering `tailscale serve`, the variable, and how to turn exposure off, plus
  the §7 row, `.env.example`, the README security posture, the plan rule, and the log decision.
- Running `tailscale serve` and the live check from the phone, both gated on the user.

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
   `config.extraOrigins`. The comparison stays an exact string match. Update the module comment,
   which currently assumes a loopback-only browser origin.
3. Tests:
   - `tests/unit/config-time.test.ts`: the default, accepted entries, and each rejected shape.
   - `tests/integration/api-security.test.ts`: the configured origin passes, and its `http://`
     twin and another `ts.net` host are refused. `testConfig` already goes through `loadConfig`,
     so the helper needs no change.
4. Documentation:
   - Setup §6 gets a "From a phone (Tailscale)" subsection:
     - `tailscale serve --bg 3838` and `tailscale serve status`;
     - `AUD_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net` in `collector.env`, which the web
       server reads because `getConfig` calls `loadCollectorEnvFile` and the web unit sets
       `AUD_ENV_FILE`;
     - `systemctl --user restart ai-usage-dashboard-web.service`;
     - turning exposure off with `tailscale serve --https=443 off`;
     - a warning never to use `funnel`.
   - Correct the §6 sentence saying that authentication, TLS, and an origin policy "none of those
     exist yet", and add the §7 row.
   - Add a commented line to `.env.example`, a bullet to the README security posture, and the
     plan §5 rule and log `Decision` from the gates.

## Files Touched

| Path                                                  | Change                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `src/lib/config.ts`                                   | `AUD_ALLOWED_ORIGINS` parsing; `extraOrigins`          |
| `src/lib/server/security.ts`                          | `allowedOrigins` appends `extraOrigins`; comment       |
| `tests/unit/config-time.test.ts`                      | Default, accepted, and rejected origin entries         |
| `tests/integration/api-security.test.ts`              | Configured origin accepted; near-misses refused        |
| `docs/operations/SETUP.md`                            | §6 Tailscale subsection and corrected sentence; §7 row |
| `.env.example`, `README.md`                           | Commented variable; security posture bullet            |
| `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md` | §5 phone-access rule                                   |
| `docs/log.md`                                         | `Decision` entry                                       |

## Acceptance Criteria

- [ ] Without `AUD_ALLOWED_ORIGINS`, `allowedOrigins` returns exactly the three loopback origins.
- [ ] Configuration loading rejects `http://x.ts.net`, `https://x.ts.net/`,
      `https://x.ts.net/path`, `https://user@x.ts.net`, `*`, and `null`, naming the entry.
- [ ] With the variable set, a refresh whose `Origin` equals the entry passes the guard, and its
      `http://` twin and a different `ts.net` host get `403`.
- [ ] `ss -ltn` shows the Next.js server only on `127.0.0.1:3838`, and a non-loopback `AUD_HOST`
      still fails at startup.
- [ ] From the phone on the tailnet, the page loads over HTTPS and Refresh updates a card, adding a
      manual row to `collector_runs`.
- [ ] With Tailscale disconnected on the phone, the address does not connect, and
      `tailscale funnel status` shows no public exposure.
- [ ] `npm run verify` and the OKF validator pass.

## Testing

- Focused: `npx vitest run tests/unit/config-time.test.ts tests/integration/api-security.test.ts`.
- `npm run test:e2e` still passes on the loopback path.
- Live, done by the user with the phone:
  - `tailscale serve status` and `ss -ltn`;
  - page load and Refresh from the phone;
  - the new `collector_runs` row;
  - the check with Tailscale disconnected.

  An agent cannot operate the phone, so report which live checks were actually performed.

- `npm run verify` is the final gate.

## Open Questions

- Does tailnet device identity satisfy the plan's authentication rule, or is an in-app check (for
  example on a Tailscale identity header) also wanted? Owner: user.
- Tailnet HTTPS certificates (recommended; the machine name appears in Certificate Transparency
  logs) or `tailscale serve --http=80` (no certificate, but the phone treats the page as an
  insecure origin, and the allowlist would have to accept a non-loopback `http://` origin)?
  Owner: user.
- Does anyone else share the tailnet or this machine? If so, a tailnet access rule should limit
  this machine's port 443 to the user's own devices. Owner: user.
- Is refresh from the phone needed, or is read-only enough? Read-only needs only the Setup
  documentation and no code. Owner: user.
