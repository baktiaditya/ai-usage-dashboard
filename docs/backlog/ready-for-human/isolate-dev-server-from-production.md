# Isolate `npm run dev` from the production dashboard

## Status

Ready for human

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md`,
`docs/discovery/M0_DISCOVERY.md`, `docs/operations/SETUP.md`, or `docs/log.md`.

Related issue: none yet

## Objective

`npm run dev` runs alongside the production dashboard on `127.0.0.1:3838` without sharing its
port or its database. By default, with no variable to remember, the development server binds a
separate loopback port that manual refresh accepts, and reads and writes a separate data
directory.

## Context

The dashboard now runs at boot as the `ai-usage-dashboard-web.service` user unit on `AUD_PORT`
(3838), serving the database the collector timer writes ([Setup](../../operations/SETUP.md) §6,
"Start on boot"). `scripts/next.ts` binds both `dev` and `start` to `AUD_HOST`/`AUD_PORT`, so
today `npm run dev` collides with the service.

Changing only the development port is not enough. `requireSameOrigin` in
`src/lib/server/security.ts` accepts only `http://<loopback>:<config.port>`. A development server
bound to another port would therefore reject every refresh as cross-origin, unless `AUD_PORT`
inside that server matches the bound port.

A shared database is the larger risk:

- Every process resolves the same default data directory, and `openDb` in
  `src/lib/db/client.ts` applies pending migrations on open. A development branch with a new
  migration would upgrade the live database under the older production build.
- `npm run seed:demo` now refuses to run without an exported `AUD_DATA_DIR`, because it deletes every
  collector run in the database it opens. Seeding a development directory still needs that
  variable typed by hand.

A working interim needs no code:
`AUD_PORT=3839 AUD_DATA_DIR=~/.local/share/ai-usage-dashboard-dev npm run dev`. This brief turns
that habit into the default.

## Dependencies and Gates

- The web unit, the installer's `--with-web` flag, and its Setup section are on the branch this
  work lands on. They were committed to PR #1 in `f80c013`. Owner: user, by merging.
- The default values are confirmed (see Open Questions). Owner: user.

## Scope

### In scope

- `dev` mode binds `AUD_DEV_PORT` (proposed default `3839`) and uses `AUD_DEV_DATA_DIR` (proposed
  default: `ai-usage-dashboard-dev` beside the production data directory). It passes both to the
  Next.js process as `AUD_PORT` and `AUD_DATA_DIR`, so `getConfig()` inside the server agrees with
  the bind.
- `dev` refuses to start when the development port equals `AUD_PORT`.
- A `seed:dev` shortcut that seeds the development data directory.
- Setup, README, and `.env.example` document the development settings. The "stop any `npm run
dev`" sentence in Setup §6 is corrected.

### Out of scope

- `npm run start` and both systemd units, which keep their current behavior.
- Moving production to its own checkout, covered by
  [separate-production-checkout](separate-production-checkout.md).
- Any change to the origin guard's policy or to the loopback-only rule.

## Approach

1. `src/lib/config.ts`: add `AUD_DEV_PORT` (`numericEnv(3839, 1, 65535)`) and `AUD_DEV_DATA_DIR`
   (resolved through `userPath` from `src/lib/paths.ts`) to the environment schema, and expose
   `devPort` and `devDataDir` on `AppConfig`.
2. `scripts/next.ts`, in `dev` mode:
   - Refuse to start when `devPort === port`.
   - Spawn `next dev --hostname <host> --port <devPort>` with
     `env: { ...process.env, AUD_PORT: String(devPort), AUD_DATA_DIR: devDataDir }`. Exported
     variables win over `collector.env`, because `loadCollectorEnvFile` fills only unset keys, so
     the server's cached config reads the development values.
   - Keep the bind-flag refusal, and name `AUD_DEV_PORT` in its message.
3. `scripts/seed-demo.ts`: accept `--dev` to target `devDataDir`, with a `seed:dev` package script.
   The explicit-`AUD_DATA_DIR` guard already in the script stays.
4. Document the development server in Setup §6, add the two rows to §7, update the README
   command table and `.env.example`, and record the decision in `docs/log.md`.

## Files Touched

| Path                                     | Change                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/config.ts`                      | `AUD_DEV_PORT`, `AUD_DEV_DATA_DIR`; `devPort` and `devDataDir`          |
| `scripts/next.ts`                        | `dev` binds and passes the development port and data directory          |
| `scripts/seed-demo.ts`                   | `--dev` target                                                          |
| `package.json`                           | `seed:dev` script                                                       |
| `tests/unit/config-time.test.ts`         | Defaults, validation, and `~/` expansion for the development settings   |
| `tests/integration/next-wrapper.test.ts` | `dev` refuses a port equal to `AUD_PORT` before starting                |
| `docs/operations/SETUP.md`               | §6 development server, §7 rows, corrected "stop `npm run dev`" sentence |
| `README.md`, `.env.example`              | Development port and data directory                                     |
| `docs/log.md`                            | `Decision` entry                                                        |

## Acceptance Criteria

- [ ] With `ai-usage-dashboard-web.service` active on 3838, `npm run dev` starts on
      `127.0.0.1:3839` with no variable set.
- [ ] A manual refresh on the development server is accepted as same-origin and writes only
      under the development data directory; the production database's `collector_runs` count
      is unchanged.
- [ ] `AUD_DEV_PORT` equal to `AUD_PORT` stops `npm run dev` with an error before any server
      starts.
- [ ] `npm run seed:dev` seeds the development directory, and `npm run test:e2e` still passes.
- [ ] `npm run start` and both systemd units behave exactly as before.
- [ ] `npm run verify` passes.

## Testing

- Focused: `npx vitest run tests/unit/config-time.test.ts tests/integration/next-wrapper.test.ts`.
- Live, with the web service running:
  - start `npm run dev`, and confirm with `ss -ltn` that the service holds 3838 and the development
    server holds 3839,
  - click Refresh through `agent-browser` in a named session,
  - compare `collector_runs` counts in both databases.
- `npm run test:e2e` covers the seed change. `npm run verify` is the final gate.

## Open Questions

- Is `3839` the default development port? Owner: user, still deciding.
- Should the development data directory default to `~/.local/share/ai-usage-dashboard-dev`,
  starting empty or seeded with `seed:dev`, rather than a copy of production data? Owner: user.
- Should the development server load provider keys from `collector.env`, so refresh calls the real
  upstreams, or run offline by default? Owner: user.
