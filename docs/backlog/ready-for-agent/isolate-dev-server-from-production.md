# Isolate `npm run dev` from the production dashboard

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md`,
`docs/discovery/M0_DISCOVERY.md`, `docs/operations/SETUP.md`, or `docs/log.md`.

Related issue: none yet. Creating an issue is tracking hygiene, not an implementation gate.

## Objective

Make `npm run dev` safe to run while the production dashboard is active. With no development
variables set, it binds to `127.0.0.1:3839`, uses an empty development data directory, and refuses
manual refresh before any provider or database write. Production keeps its existing port, data,
credentials, collector timer, and web-unit behavior.

An explicit opt-in enables live manual refresh in development. Seeding remains a separate,
deliberate command and can never infer the production database as its target.

## Context

The dashboard runs at boot as `ai-usage-dashboard-web.service` on `AUD_PORT` (default `3838`),
serving the database written by the collector timer ([Setup](../../operations/SETUP.md) §6,
"Start on boot"). `scripts/next.ts` currently binds both `dev` and `start` to
`AUD_HOST`/`AUD_PORT`, so `npm run dev` collides with the web unit and opens the same database.

Changing only the bind port is insufficient:

- `requireSameOrigin` accepts `http://<loopback>:<config.port>`, so the child process must receive
  the development port as `AUD_PORT`, not only as a Next.js CLI flag.
- `openDb` applies pending migrations on open. A development branch must never migrate the
  production database.
- `getConfig()` loads `collector.env` into `process.env`; a child that simply inherits the parent
  environment receives the real DeepSeek and OpenRouter credentials.
- Codex needs no environment credential. Blanking HTTP keys alone is therefore not an offline
  mode: a refresh can still spawn `codex app-server`.

Next.js 16 writes `next dev` output under `.next/dev`, separately from the production build, and
locks duplicate development servers in one checkout. The separate production checkout remains
valuable for branch, dependency, build, restart, and rollback isolation, but it is not a dependency
of this port/data/refresh change. See
[separate-production-checkout](../ready-for-human/separate-production-checkout.md).

## Fixed Decisions

- The development port is `3839` by default and is overridden by `AUD_DEV_PORT`.
- The development data directory is
  `${XDG_DATA_HOME}/ai-usage-dashboard-dev` when `XDG_DATA_HOME` is absolute, otherwise
  `~/.local/share/ai-usage-dashboard-dev`. `AUD_DEV_DATA_DIR` overrides it and must be absolute or
  start with `~/`. It is independent of a custom production `AUD_DATA_DIR`.
- A new development database starts empty. Production data is never copied automatically.
- Manual refresh is disabled in development by default. `AUD_DEV_LIVE_REFRESH=1` opts in.
- With refresh disabled, the route returns HTTP `409` with a stable `refresh_disabled` code before
  checking the rate limiter, opening the database, recording an attempt, or constructing an
  adapter.
- The offline child receives empty `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` values so
  Next.js cannot refill them from `collector.env` or `.env.local`. It also receives
  `AUD_REFRESH_ENABLED=0`, which prevents credentialless sources such as Codex from running.
- `AUD_DEV_PORT`, `AUD_DEV_DATA_DIR`, and `AUD_DEV_LIVE_REFRESH` are launcher-only settings. They
  are not fields in the shared `AppConfig`, and invalid development values cannot break
  `npm run start`, `npm run collect`, or either systemd unit.
- `AUD_REFRESH_ENABLED` is an internal child-runtime setting with a production default of enabled.
  Operators use `AUD_DEV_LIVE_REFRESH`; the internal setting is not added to `.env.example`.
- `npm run seed:dev` is the explicit way to populate the development database. It replaces the
  seeded collector runs in that database only, just as `seed:demo` does for an explicit scratch
  directory.

## Dependencies and Gates

- The boot-time web unit and `--with-web` installer path are already on `main`; there is no PR or
  merge dependency for this work.
- The default path and port decisions above are final.
- No provider credential is needed to implement or verify the default offline path.
- Live-provider availability is not a completion gate. The opt-in path must be covered with
  controlled tests; any real-provider smoke test is reported separately and must never print or
  persist values in repository artifacts.

## Scope

### In scope

- A deep development-environment module whose interface returns the validated host, port, data
  directory, refresh policy, and complete child environment for `next dev`.
- Development-only port and path parsing, environment-file precedence, credential isolation, and
  production-port collision refusal behind that interface.
- A runtime refresh-enabled flag and an early `409 refresh_disabled` response.
- `seed:dev` targeting the resolved development directory.
- Setup, README, `.env.example`, tests, and the bundle log updates described below.

### Out of scope

- Changing `npm run start`, scheduled collection, or the installed systemd units.
- Copying or restoring production data into development.
- Moving production to its own checkout; that remains
  [separate-production-checkout](../ready-for-human/separate-production-checkout.md).
- Changing the origin policy, loopback-only host policy, provider contracts, or rate limits.
- UI redesign. The existing refresh-error surface may display the `409` message.
- Automatic live-provider access in development.

## Implementation Contract

1. Add `src/lib/dev-environment.ts` with one public seam:
   `resolveDevEnvironment(sourceEnv?: EnvLike): DevEnvironment`.
   - Clone the supplied environment; never mutate the caller's object.
   - Load `collector.env` into the clone with the existing "already set wins" precedence.
   - Resolve the production host and port through `loadConfig(clone)` so loopback validation and
     `AUD_PORT` precedence remain canonical.
   - Parse launcher-only `AUD_DEV_PORT`, `AUD_DEV_DATA_DIR`, and `AUD_DEV_LIVE_REFRESH` inside this
     module. Accept only unset/`0`/`1` for the boolean and reject malformed values.
   - Default the path through `xdgBaseDir` and validate an override through `userPath`.
   - Refuse `devPort === productionPort` before a child is spawned.
   - Return a complete child environment with `AUD_PORT`, `AUD_DATA_DIR`, and
     `AUD_REFRESH_ENABLED` overridden. When live refresh is disabled, set both provider credential
     variables to empty strings; when enabled, preserve the resolved credentials.
   - Keep error messages free of environment values other than the already-safe port/path setting
     that failed validation. Never include credential contents.
2. Update `scripts/next.ts`:
   - Keep the existing bind-flag refusal and signal forwarding.
   - In `start` mode, preserve the current `getConfig()` bind behavior exactly.
   - In `dev` mode, call `resolveDevEnvironment`, spawn
     `next dev --hostname <host> --port <devPort>`, and pass the returned child environment.
   - The bind-flag error names `AUD_DEV_PORT` for `dev` and `AUD_HOST`/`AUD_PORT` for `start`.
3. Update `src/lib/config.ts` with `refreshEnabled`, parsed from internal
   `AUD_REFRESH_ENABLED` (`1`/unset means enabled; `0` means disabled; anything else fails).
   Do not add any `AUD_DEV_*` field to `AppConfig` or its schema.
4. Update `src/app/api/providers/[provider]/refresh/route.ts`:
   - Keep same-origin and provider validation first.
   - When refresh is disabled, return `409` with
     `{ error: { code: "refresh_disabled", message: <safe fixed text> } }`.
   - Return before the rate limiter, `db()`, `collectOnce`, or adapter construction. A disabled
     refresh writes no collector run or attempt.
5. Update `scripts/seed-demo.ts`:
   - Accept only the optional `--dev` flag; unknown arguments fail with exit code `2`.
   - Resolve `--dev` through `resolveDevEnvironment` and set the resolved development data
     directory before `getConfig()` can load a production value.
   - Without `--dev`, retain the existing requirement for an explicitly exported
     `AUD_DATA_DIR` checked before `getConfig()`.
   - Add `"seed:dev": "tsx scripts/seed-demo.ts --dev"` to `package.json`.
6. Update documentation only after behavior exists:
   - Setup §1 and §6: `npm run dev` uses `3839`, an isolated empty database, and disabled refresh;
     document `seed:dev` and the live-refresh opt-in.
   - Correct Setup's instruction to stop `npm run dev` before installing the web unit; different
     default ports may coexist, while an explicit collision is still refused.
   - README quick start and command table: distinguish `dev` from production `start`.
   - `.env.example`: document the three public `AUD_DEV_*` settings, not
     `AUD_REFRESH_ENABLED`.
   - `docs/log.md`: record the delivered behavior and archive this brief after acceptance.

## Files Touched

| Path                                                | Required change                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/dev-environment.ts`                        | Development configuration seam and child-environment construction      |
| `src/lib/config.ts`                                 | Internal `refreshEnabled` runtime configuration                        |
| `scripts/next.ts`                                   | Mode-specific launch behavior                                          |
| `src/app/api/providers/[provider]/refresh/route.ts` | Early, side-effect-free disabled-refresh response                      |
| `scripts/seed-demo.ts`                              | Safe `--dev` target and strict argument handling                       |
| `package.json`                                      | `seed:dev` command                                                     |
| `tests/unit/dev-environment.test.ts`                | Defaults, overrides, precedence, isolation, and validation             |
| `tests/unit/config-time.test.ts`                    | `AUD_REFRESH_ENABLED` parsing and production default                   |
| `tests/integration/next-wrapper.test.ts`            | Mode selection, collision refusal, bind flags, and production behavior |
| `tests/integration/seed-demo.test.ts`               | Development target and production sentinel preservation                |
| `tests/integration/refresh-route.test.ts`           | `409`, no rate-limit use, no database open, and opt-in path            |
| `docs/operations/SETUP.md`                          | Development workflow and corrected web-unit guidance                   |
| `README.md`, `.env.example`                         | Public development defaults and opt-in                                 |
| `docs/log.md`                                       | Delivery update and archive link                                       |

Equivalent test-file placement is acceptable only when it preserves every named assertion and
keeps the production-regression proof easy to find.

## Acceptance Criteria

- [ ] With the production web unit listening on `127.0.0.1:3838`, `npm run dev` starts on
      `127.0.0.1:3839` without exported development variables.
- [ ] The development process resolves its database under
      `~/.local/share/ai-usage-dashboard-dev` (or the absolute XDG equivalent), while production
      keeps its configured database.
- [ ] The default development refresh returns `409 refresh_disabled`; controlled tests prove it
      consumes no rate-limit slot, opens no database, constructs no adapter, calls no upstream, and
      writes no run or attempt.
- [ ] The default development child has empty DeepSeek and OpenRouter credential variables even
      when `collector.env`, the parent shell, or `.env.local` contains them. Tests assert only empty
      versus non-empty state and never print a credential.
- [ ] `AUD_DEV_LIVE_REFRESH=1` enables the existing refresh path, preserves resolved provider
      credentials in the child, passes same-origin validation on port `3839`, and writes only the
      development database.
- [ ] `AUD_DEV_PORT` equal to the resolved production `AUD_PORT` exits `2` before any Next.js child
      starts. Invalid development settings also exit `2` with a safe configuration error.
- [ ] Invalid `AUD_DEV_*` values do not change or prevent `npm run start`, `npm run collect`, or
      systemd unit rendering.
- [ ] `npm run seed:dev` seeds only the resolved development directory. A production sentinel
      database remains byte-for-byte unchanged, including when `collector.env` names it.
- [ ] `npm run start`, both systemd units, and the existing e2e refresh behavior retain their
      current defaults.
- [ ] `npm run verify`, `npm run test:e2e`, the OKF validator, and `git diff --check` pass.

## Testing

Focused automated checks while iterating:

```bash
npx vitest run \
  tests/unit/dev-environment.test.ts \
  tests/unit/config-time.test.ts \
  tests/integration/next-wrapper.test.ts \
  tests/integration/seed-demo.test.ts \
  tests/integration/refresh-route.test.ts
```

The tests must use temporary homes, environment files, ports, and databases. They must not read the
operator's real data or assert credential values.

Browser/runtime proof:

1. Confirm the production web unit still owns `3838` and record the production database run count
   without printing provider values.
2. Start `npm run dev` with no development variables and confirm `3839` with `ss -ltn`.
3. Use a named `agent-browser` session at `http://127.0.0.1:3839/`; trigger one refresh and verify
   the `409` message plus unchanged development and production run counts.
4. Run `npm run seed:dev`, reload the development page, and verify seeded cards render while the
   production count remains unchanged.
5. Close the named browser session and stop the development server. Do not restart, reinstall, or
   mutate the production units as part of this brief.

Completion gates:

```bash
npm run verify
npm run test:e2e
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
git diff --check
```

## Open Questions
