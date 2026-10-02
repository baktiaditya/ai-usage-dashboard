# AI Usage Dashboard

A localhost-first dashboard that answers three questions on one screen: how much
subscription quota is left, how much prepaid credit is left, and whether any
provider is worth switching away from right now.

![AI Usage Dashboard with seeded demo data](docs/assets/dashboard.png)

_Illustrative screenshot using seeded demo data._

Supported providers, with quota and money kept separate:

| Provider        | Source                                                 | Measures                                    |
| --------------- | ------------------------------------------------------ | ------------------------------------------- |
| **Codex**       | Codex CLI interface                                    | quota gauge per window                      |
| **Claude Code** | status-line bridge → local spool; optional quota probe | quota gauge per window                      |
| **OpenCode Go** | OpenCode Go usage API                                  | quota gauge per window                      |
| **DeepSeek**    | DeepSeek balance API                                   | money balance per currency                  |
| **OpenRouter**  | OpenRouter credits API                                 | money: credits, cumulative usage, remaining |

Source contracts and provider requirements live in the
[implementation plan](docs/plan/ai-usage-dashboard-implementation-plan.md) and
[Setup](docs/operations/setup.md).

## Quick start

Runs on **Linux only**: scheduling uses user `systemd`, and the database restore
guard reads `/proc`. Install Node.js matching `engines.node` in
[package.json](package.json); [.nvmrc](.nvmrc) selects the supported release line.
Corepack runs the pnpm version pinned by `packageManager` in the same package file.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run collect
pnpm run build
pnpm run start
```

Open the local URL printed by the server. Ports, data directories, timezone, and
other overrides are documented in [Setup](docs/operations/setup.md#7-configuration-reference).

Working on the dashboard itself? `pnpm run dev` uses a separate port and database;
`pnpm run seed:dev` fills that database with demo data. See
[Development server](docs/operations/setup.md#development-server) for isolation and live-refresh options.

It works with nothing configured. Providers you have not set up render as
`unavailable` with a setup hint instead of blocking the page or failing the run.
Enter provider credentials under **Settings**. The optional Claude quota probe can
report quota while no session is running; it sends real inference that counts toward
your Claude subscription usage. See [Setup](docs/operations/setup.md) for each
provider's configuration.

Full instructions, including the Claude status-line bridge, credentials, and the
systemd timer: **[docs/operations/setup.md](docs/operations/setup.md)**.

## The three ideas this is built around

**A quota gauge, a cumulative counter, and a money balance are not the same
number.** A quota window resets to zero; `total_usage` only rises; a balance
moves on top-ups as well as spend. They are separate types end to end — in the
adapters, the schema, the queries and the UI — so nothing can sum them,
average them, or render them through the same component by accident. It also
means DeepSeek's balance is never called "usage": that endpoint reports no usage
at all, and inferring it from a falling balance would be a fabricated number.

**Money keeps its decimal precision.** Amounts are canonical decimal strings,
calculated with decimal arithmetic and stored without floating-point columns.
A chart converts an amount to a number only to position it, and draws nothing
when that number would not read back as the same decimal. Numeric JSON values
are read losslessly, preserving the literal digits from the wire before arithmetic.

**Freshness is derived, never stored.** Card status, data age and advisories all
depend on the current clock and on configurable thresholds, so a persisted copy
would be wrong the moment either moved. They are computed at query time from
immutable observations. The consequence that matters: **a card that is not
`healthy` always yields an `unknown` advisory** — a "switch providers" verdict
computed from a two-day-old percentage is a guess wearing the costume of a fact.

## Architecture

```
Scheduled collection ─┐
                      ├─ Shared collector ── Provider APIs, CLI interfaces, local events
Manual refresh ───────┘          │
                                ▼
                       SQLite observations + attempt audit
                                │
                                ▼
                       Overview and history queries
                       freshness · advisory · aggregation by metric type
                                │
                                ▼
                       Loopback-only dashboard
```

One idempotent collection path serves both the systemd timer and manual refresh,
so scheduled and manual runs cannot drift apart in behaviour.

## Security posture

- binds only to loopback; a non-loopback `AUD_HOST` fails at startup;
- authentication is delegated to the source: no auth file is read, no token is
  extracted, no terminal UI is scraped. The one token the dashboard holds for a
  CLI provider is a Claude token the user mints with `claude setup-token` and
  pastes into Settings to opt into the quota probe;
- adapters select an allowlist at the boundary and discard the raw payload —
  account IDs, emails, session IDs and transcript paths are never persisted;
- a redaction pass runs before every log write, persisted diagnostic, API
  response and rendered string, with tests asserting on each secret shape;
- manual refresh is `POST`, same-origin enforced, and locally rate limited;
- saved credentials live in the owner-only database, are never read from the environment, and never
  reach the browser in full: it receives at most a key's last four characters,
  and every settings route requires a same-origin request;
- read-only toward providers: no plan change, no purchase, and no key is ever
  created, modified, or deleted at a provider. Saving or removing a key in
  Settings changes only the dashboard's local copy.

Credential storage, backup handling, and the quota probe's subscription usage are
covered in [SECURITY.md](SECURITY.md).

## Commands

Run `pnpm run` to list the scripts available in your checkout. Their definitions live in
[package.json](package.json).

For collection, credentials, scheduling, backup, and restore commands, follow
[Setup](docs/operations/setup.md). For development and validation commands, follow
[CONTRIBUTING.md](CONTRIBUTING.md).

## Affiliation and interface stability

This project is not affiliated with, endorsed by, or sponsored by the providers it supports.
Provider names and marks belong to their respective owners and are shown
only to identify the services the dashboard reads; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

CLI protocols, status-line payloads, and undocumented usage interfaces can change without
notice. Adapters validate the fields they consume and report unsupported formats as errors.
The [implementation plan](docs/plan/ai-usage-dashboard-implementation-plan.md) describes the
source contracts and fallback behavior.

## Contributing and license

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the `pnpm run verify`
gate, and how to add a provider. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md). Released under the [MIT License](LICENSE).

## Compatibility and verification

Provider requirements are documented in [Setup](docs/operations/setup.md). Dated live
verification, tested CLI versions, and known limitations are recorded in
[Discovery](docs/discovery/m0-discovery.md), alongside the distinction between live and
fixture evidence. These are observations from their recorded dates.

To check your own installation, follow [Verification](docs/operations/setup.md#9-verification).
Live checks are opt-in and use your configured provider credentials.

Design rationale and scope: [docs/plan/ai-usage-dashboard-implementation-plan.md](docs/plan/ai-usage-dashboard-implementation-plan.md).
Knowledge bundle root: [docs/index.md](docs/index.md).
