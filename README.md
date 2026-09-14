# AI Usage Dashboard

A localhost-first dashboard that answers three questions on one screen: how much
subscription quota is left, how much prepaid credit is left, and whether any
provider is worth switching away from right now.

Four providers, three kinds of number, deliberately never mixed:

| Provider        | Source                                                  | Measures                                    |
| --------------- | ------------------------------------------------------- | ------------------------------------------- |
| **Codex**       | `codex app-server` JSON-RPC (`account/rateLimits/read`) | quota gauge per window                      |
| **Claude Code** | status-line bridge → local spool                        | quota gauge per window                      |
| **DeepSeek**    | `GET api.deepseek.com/user/balance`                     | money balance per currency                  |
| **OpenRouter**  | `GET openrouter.ai/api/v1/credits`                      | money: credits, cumulative usage, remaining |

## Quick start

```bash
npm install
npm run db:migrate
npm run collect
npm run build
npm run start        # http://127.0.0.1:3838
```

Working on the dashboard itself? `npm run dev` runs beside production on
`http://127.0.0.1:3839` with its own empty database (`npm run seed:dev` fills it)
and manual refresh disabled unless `AUD_DEV_LIVE_REFRESH=1`.

It works with nothing configured. Providers you have not set up render as
`unavailable` with a setup hint instead of blocking the page or failing the run.

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

**Money never touches binary floating point.** Every amount is a canonical
decimal string, combined only through `decimal.js`, stored in `TEXT` columns and
never in SQLite `REAL`. A chart converts an amount to a number only to position
it, and draws nothing when that number would not read back as the same decimal.
The subtle part is JSON: OpenRouter sends
`{"total_credits": 100.5}` as a JSON _number_, and `response.json()` would round
it before anything could react. The HTTP layer reads the body as text and uses
Node 24's JSON source-text access to keep the literal digits from the wire.

**Freshness is derived, never stored.** Card status, data age and advisories all
depend on the current clock and on configurable thresholds, so a persisted copy
would be wrong the moment either moved. They are computed at query time from
immutable observations. The consequence that matters: **a card that is not
`healthy` always yields an `unknown` advisory** — a "switch providers" verdict
computed from a two-day-old percentage is a guess wearing the costume of a fact.

## Architecture

```
scripts/collect.ts ─┐                        ┌─ adapters/codex      (JSON-RPC child process)
                    ├─ collector/  ──────────┼─ adapters/deepseek   (HTTPS)
POST /api/.../refresh┘   parallel,           ├─ adapters/openrouter (HTTPS)
                         isolated,           └─ ingestors/claude-statusline (local spool)
                         one attempt/provider
                              │
                              ▼
                      db/  SQLite + WAL
                      immutable observations, full attempt audit trail
                              │
                              ▼
                      queries/  overview + history
                      freshness · advisory · aggregation by metric type
                              │
                              ▼
                      app/  Next.js, bound to 127.0.0.1
```

One idempotent collection path serves both the systemd timer and manual refresh,
so scheduled and manual runs cannot drift apart in behaviour.

## Security posture

- binds explicitly to `127.0.0.1`; a non-loopback `AUD_HOST` fails at startup;
- authentication is delegated to the source: no auth file is read, no token is
  extracted, no terminal UI is scraped;
- adapters select an allowlist at the boundary and discard the raw payload —
  account IDs, emails, session IDs and transcript paths are never persisted;
- a redaction pass runs before every log write, persisted diagnostic, API
  response and rendered string, with tests asserting on each secret shape;
- manual refresh is `POST`, same-origin enforced, and locally rate limited;
- credentials live outside the repository in a `0600` environment file, and are
  never sent to the browser;
- read-only by construction: no plan change, no purchase, no key management.

## Commands

| Command                                    | Does                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `npm run start`                            | production dashboard on `127.0.0.1:3838` (or `AUD_HOST`/`AUD_PORT`) from an `npm run build`               |
| `npm run dev`                              | development server on `127.0.0.1:3839` (`AUD_DEV_PORT`), own database, refresh off by default             |
| `npm run seed:dev`                         | fill the development database with every card state; never the production one                             |
| `npm run collect`                          | one collection pass (`--manual`, `--provider=codex,deepseek`)                                             |
| `npm run db:migrate`                       | apply migrations, print schema state                                                                      |
| `npm run db:backup` / `npm run db:restore` | back up the database while it runs; restore one with the units stopped                                    |
| `npm run claude:install-statusline`        | install the bridge (dry run by default)                                                                   |
| `npm run systemd:install`                  | render the collector units and the optional web unit (install, enable, and `--with-web` are opt-in flags) |
| `npm run verify`                           | format + lint + typecheck + unit + integration                                                            |
| `npm run test:e2e`                         | browser smoke at desktop and mobile widths                                                                |
| `npm run test:live`                        | opt-in live checks; skips gates whose credential is absent                                                |

## Status

**Codex** and **Claude Code** are verified live — Codex against
`codex-cli 0.154.0`, Claude against a real status-line event from
`claude-code 2.1.269` with both the 5-hour and 7-day windows.

**DeepSeek** and **OpenRouter** are verified live as well, against their balance
and credits endpoints once a key is in `collector.env`. Without a key, each
surfaces as `unavailable` with a precise setup hint. Per-gate evidence is in
**[docs/discovery/m0-discovery.md](docs/discovery/m0-discovery.md)**.

Design rationale and scope: [docs/plan/ai-usage-dashboard-implementation-plan.md](docs/plan/ai-usage-dashboard-implementation-plan.md).
Knowledge bundle root: [docs/index.md](docs/index.md).
