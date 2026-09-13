# Bundle Update Log

## 2026-09-14

- **Decision**: ad-hoc browser work uses the global `agent-browser` CLI, not the
  Playwright MCP server. The rule is copied from Kyomi-pos
  (`agent-guides/testing.md`, "Ad-Hoc Browser Automation") into a new
  `AGENTS.md` section, because this repository has no `agent-guides/` split. It
  is adapted in three ways:
  - The spec lane is `npm run test:e2e`.
  - The dashboard's default URL is named.
  - A named `AGENT_BROWSER_SESSION` plus `agent-browser close` is required,
    because the default session is shared by every agent and conversation on
    the machine.

  The tool is machine tooling, not a dependency: v0.36.0 on this machine, where
  `agent-browser doctor --offline --quick` passes. The Playwright e2e lane is
  unchanged.

## 2026-09-13

- **Decision**: `AUD_DATA_DIR` and `AUD_ENV_FILE` must be absolute or start
  with `~/`, which is expanded. Other relative paths are rejected at startup
  instead of being resolved, because every process would resolve them against
  its own working directory: the systemd collector, a manual `npm run collect`,
  and the dashboard would open different databases. A relative `XDG_DATA_HOME`
  or `XDG_CONFIG_HOME` is ignored, as the XDG spec requires. The unit renderer
  also refuses a relative path placeholder or `PATH` entry. Before this fix,
  `AUD_DATA_DIR=relative-data` rendered `ReadWritePaths=relative-data`, which
  systemd ignores with only a warning.

- **Decision**: fixes for the fourth review of PR #1.
  - An attempt that cannot be written to the database counts as an error with
    code `io_error`, whatever the adapter returned. A summary that reported
    success over zero stored rows let `npm run collect` exit `0`.
  - The OpenRouter trend plots usage since the period began, measured against
    the same pre-period baseline as the delta. With no baseline the chart is
    empty, and it stops at a counter reset. The DeepSeek trend still plots the
    observed balance.
  - Units are rendered in TypeScript (`src/lib/systemd-unit.ts`) with one literal
    substitution pass. `%` is escaped as `%%`, and a value containing whitespace,
    a quote, a backslash, or a control character is refused. The previous `sed`
    substitution turned a data directory containing `&` into a different path in
    both `Environment=` and `ReadWritePaths=`.

- **Update**: the third review of PR #1 found two standards gaps, now closed:
  - The status-line installer sets `settings.json` and its backup to `0600`
    even when they already existed. Before this, `writeFileSync`'s `mode`
    applied only on creation and `copyFileSync` kept the source mode, so a `0644`
    file stayed `0644`.
  - `npm run seed:demo` routes its failure message through the redactor like
    every other entry point.

- **Update**: fixes for the second review of PR #1 change these facts in
  [Setup](operations/SETUP.md):
  - The collector unit has no `EnvironmentFile=`. The installer resolves the
    environment file, data directory, and interval through the collector's own
    configuration and bakes them in as `Environment=` values. The collector reads
    `collector.env` itself and fills only unset variables. Before this, a data
    directory set only in `collector.env` sent the collector's writes outside the
    unit's `ReadWritePaths`, because systemd lets `EnvironmentFile=` override
    `Environment=`.
  - `npm run dev` and `npm run start` refuse a passed-through `--hostname` or
    `--port`, because `next` keeps the last value and would bypass the loopback
    check.
  - `npm run test:e2e` builds before serving, so a clean checkout never tests a
    missing or stale `.next`.

- **Decision**: a local day starts at its first instant, not necessarily at
  00:00. Where a transition skips midnight (Havana, Santiago, the Azores), the
  day begins at the transition. A sweep of every IANA zone across 2026–2027
  confirms the boundary on all transition days.

- **Update**: fixes for the fifteen confirmed PR #1 review findings change
  several operator-facing facts, now in [Setup](operations/SETUP.md):
  - The collector environment file is loaded by every entry point (`npm run collect`, `npm run test:live`, and the dashboard's manual refresh), not only
    by the systemd unit. `AUD_ENV_FILE` overrides the path, and exported shell
    variables take precedence. The provisioning brief's steps therefore work as
    written.
  - The generated unit bakes a `PATH` that covers the `node` and `codex`
    directories, and makes `CODEX_HOME` writable. Before this, the unit was
    live-verified to fail: `codex` was not found without `PATH`, and
    `codex app-server` exited early under `ProtectHome=read-only`.
  - `npm run dev` and `npm run start` bind to `AUD_HOST`/`AUD_PORT` through
    `scripts/next.ts`, the same source the refresh origin guard reads.
  - `AUD_THRESHOLDS` overrides advisory thresholds per provider, window, or
    currency.

- **Decision**: `quota_windows.used_percent` stores the source value unclamped
  (migration `0001` rebuilds the table without its 0–100 `CHECK`), matching the
  [plan](plan/AI_Usage_Dashboard_Implementation_Plan.md): only the derived
  remaining percentage is clamped, at presentation time. "Latest" snapshot and
  attempt are selected by observation and start time, not by row id, so an
  overlapping run that persists last cannot replace newer data.

## 2026-09-12

- **Update**: `AGENTS.md` step 1 gains a semantic-search obligation. The
  `code-review-graph` knowledge graph is now embedded for vector search (local
  `all-MiniLM-L6-v2`; every `Function`, `Class`, and `Test` node covered — `File`
  nodes carry no embedding by design). Upstream states that routine builds never
  refresh embeddings, and `code-review-graph update` — which the `PostToolUse`
  hook runs on every edit — does not either. Unlike graph staleness, this failure
  is unsignalled: `search_mode` still reports `semantic` when the nodes an agent
  is looking for were never embedded, so a semantic miss reads as "absent from the
  codebase". The obligation therefore lives in `AGENTS.md`, not in
  [Setup](operations/SETUP.md): it constrains how an agent may interpret a result,
  while installing the `embeddings` extra is per-machine state that step 1's
  existing tools-unavailable clause already covers. `README.md` is unchanged —
  the fact is agent-facing and has no bearing on product commands.

- **Tooling**: Husky git hooks, copied from Kyomi-pos and adapted from Yarn to
  npm (`npx`/`npm run`; `commitlint.config.cjs` because this repo is
  `"type": "module"`). `pre-commit` runs lint-staged (Prettier), then
  `typecheck` plus related Vitest files in parallel when TS/TSX is staged;
  `commit-msg` enforces Conventional Commits with a 72-character subject cap.
  [Setup](operations/SETUP.md) documents the hooks.

- **Restructure**: the four flat documents move into topic folders — plan
  ([plan/](plan/index.md)), discovery ([discovery/](discovery/index.md)), operations
  ([operations/](operations/index.md)) — each with its own `index.md`. No content
  changes; every intra-bundle link, code comment, and entry-point reference
  (`README.md`, `AGENTS.md`, `okf-sync` skill, sync map, backlog brief) follows the
  move. The bundle is no longer flat: each folder carries its own navigation list.
- **Initialization**: `docs/` becomes an OKF v0.1 bundle rooted at itself. New:
  [index](index.md) (root navigation, holds `okf_version`), this log, and
  [backlog/](backlog/index.md) with its brief template and four status folders.
  The four existing documents stay flat where they are — the bundle is small and
  needs no subfolders yet. Canonical authority: the
  [Implementation Plan](plan/AI_Usage_Dashboard_Implementation_Plan.md) for scope and
  contracts, [M0 Discovery](discovery/M0_DISCOVERY.md) for what is live-verified vs
  fixture-tested, [Setup](operations/SETUP.md) for operations. The
  [`okf-sync`](../.agents/skills/okf-sync/SKILL.md) skill and its validator keep
  the bundle coherent. First brief filed:
  [provision-provider-credentials](backlog/ready-for-human/provision-provider-credentials.md)
  — the two remaining live gates (DeepSeek, OpenRouter) wait on human-provisioned
  keys.
