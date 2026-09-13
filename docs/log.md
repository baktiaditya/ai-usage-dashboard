# Bundle Update Log

## 2026-09-14

- **Update**: the restore schema check also compares each object's stored
  `CREATE` text, with comments and layout removed. A re-review showed pragmas
  miss what only that text holds: the event index narrowed to
  `WHERE source_event_id IS NULL` kept its name, columns and partial flag,
  passed backup, and let one Claude event be stored twice. The same gap hid
  `CHECK` and `DEFAULT` expressions and trigger bodies. The live database,
  upgraded through 0001, matches a fresh one object for object.

- **Update**: a credit trend chart never draws an amount a double cannot carry.
  A re-review plotted `100000000000000.01`, which reads back from its nearest
  double as `.02`, and the axis labelled it so. Each value is used as a chart
  position only when its number reads back as the same decimal; a currency
  with any value that does not shows a note instead of a line, and axis ticks
  are formatted through `decimal.js`. Tooltips already showed the exact string.

- **Decision**: agent skills read their per-repo configuration from
  [Agents](agents/index.md), set up with `/setup-matt-pocock-skills`. Issues live
  in GitHub Issues; a brief that is long, needs separate review, or must outlive
  its issue stays in `docs/backlog/`, linked both ways, as
  [Backlog](backlog/index.md) already stated. Triage uses the five default role
  labels, three of which match the backlog status folders. The repo is
  single-context, with no `CONTEXT.md` or ADR directory yet; decisions stay in
  this log. `AGENTS.md` points to the three pages.

- **Update**: `npm run db:restore` checks the whole schema before it replaces
  the database. It used to require only `schema_migrations` and
  `collector_runs`. A PR review built a file that recorded every migration
  but had no other table; restore accepted it, replaced the live database, and
  the next overview failed with `no such table: provider_snapshots`. Migrations
  cannot repair such a file, because they skip every version already recorded.
  The migrated backup is now compared with a fresh database built from this
  build's migrations: every table, column, index, foreign key and trigger must
  be present. The comparison reads pragmas rather than stored `CREATE` text,
  which differs between a fresh and an upgraded database with the same schema.
  `npm run db:backup` applies the same check to a source already at the latest
  schema. Procedure: [Setup](operations/SETUP.md) §1.

- **Update**: the web unit carries `AUD_HOST` and `AUD_PORT`. The installer
  resolved and reported both, but the rendered unit left them out, so a value
  exported only in the installing shell was lost: the installer announced port
  `4444` while the service bound `3838`. The units keep the host and port they
  were rendered with, like the data directory and interval, so the installer
  must be re-run after either changes ([Setup](operations/SETUP.md) §5).

- **Update**: a quota window no longer vanishes from a card when the source
  stops reporting it at its reset. Claude Code's status line omits
  `five_hour` from the moment the window resets until the first request of the
  next one, and the Claude card then showed only "7 day". The overview now
  compares the latest snapshot with the newest stored reading of each window.
  A window whose last reading reset at or before the latest observation, less
  than one window length earlier, is listed as ended: its label, when it
  ended, and no percentage, because the old reading ended with its window and
  the new one does not exist yet. Ended windows feed neither freshness nor the
  advisory. Plan §9 records the rule.

- **Update**: the web server could lose its database locks. Next.js bundles
  the database client into several server chunks, so the page and the API
  routes each open a connection in one process. Every `openDb` also opened and
  closed a descriptor on the database file, and that close releases every
  POSIX lock the process holds on the file. The next collector to close then
  believed it was the last connection and deleted the WAL and SHM the server
  still used. The dashboard reported `database disk image is malformed` while
  the file on disk passed `integrity_check`. `ensureOwnerOnly` now only creates
  the file and never opens an existing one. A server built before the fix
  recovers with a rebuild and a restart ([Setup](operations/SETUP.md) §10).

- **Update**: `npm run db:backup` and `npm run db:restore` supply the backup and
  restore tests that plan M6 requires and a PR review found missing.
  - Backup uses SQLite's online backup API, so it captures rows still in the
    WAL while the units run. It writes one verified `0600` file.
  - Restore refuses while any process holds the database open, and refuses a
    file that is not an intact dashboard database, comes from a newer schema,
    or has a non-empty WAL beside it.
  - Restore moves the replaced database aside together with its WAL. A probe
    showed why: a WAL left beside a restored file is replayed on the next
    open, so the file opens as the old database and still passes
    `integrity_check`.

  Procedure: [Setup](operations/SETUP.md) §1.

- **Update**: Setup names the minimum supported CLI versions, as plan §4.1
  requires: `codex-cli 0.154.0` and Claude Code 2.1.269, the versions
  live-verified in [M0 Discovery](discovery/M0_DISCOVERY.md). Older releases
  are untested rather than known broken.

- **Update**: plan §3.3 now names the optional boot-time web unit, so the plan
  agrees with the web-unit decision below. A PR review had read the unit as
  unrequested scope.

- **Proposed**: reach the dashboard from a phone over Tailscale, in
  [access-dashboard-over-tailscale](backlog/ready-for-human/access-dashboard-over-tailscale.md).
  `tailscale serve` proxies tailnet HTTPS to the loopback server, so the
  application never binds beyond loopback. The same-origin guard refuses the
  phone's `ts.net` origin, so refresh needs an exact `AUD_ALLOWED_ORIGINS`
  allowlist. The brief waits on the user: whether tailnet device identity
  meets the plan's authentication rule, and enabling tailnet HTTPS
  certificates. It is planned as a pull request separate from PR #1.

- **Discovery**: the DeepSeek and OpenRouter gates passed live. With both keys
  in `collector.env`, `npm run test:live` passes all four provider gates with
  nothing skipped, and scheduled collector runs record `success` for every
  provider. [M0 Discovery](discovery/M0_DISCOVERY.md), the README, and the
  indexes now say all four are live-verified.
  [provision-provider-credentials](backlog/archive/provision-provider-credentials.md)
  moves to `archive/`.

- **Update**: the browser e2e server blanks `DEEPSEEK_API_KEY` and
  `OPENROUTER_MANAGEMENT_KEY`. `next start` loads a repository `.env.local`,
  and @next/env fills only unset variables. With real keys there, a refresh in
  the suite reached the real upstreams, turned the seeded DeepSeek card healthy,
  and leaked live values into the database the mobile run reads: 5 of 38 specs
  failed. An empty string counts as set, so the keys stay blank.

- **Update**: `npm run seed:demo` refuses to run unless `AUD_DATA_DIR` is
  exported explicitly. The script deletes every collector run in the database
  it opens. Its header claimed it "can never touch a real collection", yet
  without the variable it resolved the real data directory, or one named in
  `collector.env`, and would have wiped the collected history. Playwright
  already exports the variable, so the e2e lane is unaffected.

- **Proposed**: now that the dashboard runs at boot, two backlog briefs keep
  development from reaching production. Both wait on the user in
  `ready-for-human/`:
  - [isolate-dev-server-from-production](backlog/ready-for-human/isolate-dev-server-from-production.md):
    `npm run dev` gets its own port and data directory by default. Today it
    shares port 3838 and the database with the web unit, and migrations apply
    on open.
  - [separate-production-checkout](backlog/ready-for-human/separate-production-checkout.md):
    after PR #1 merges, both units run from a dedicated checkout of `main`, so
    a development build cannot replace what production serves.

- **Decision**: the dashboard web server can start at boot as a systemd user unit,
  `ai-usage-dashboard-web.service`, installed with `--with-web`. pm2 was rejected
  for three reasons:
  - It adds a global daemon whose boot integration (`pm2 startup`) registers a
    systemd service anyway.
  - It would need its own answer to the nvm-managed `node`, which the installer
    already resolves.
  - It would split one application across two process managers.

  The unit reuses the collector's rendering, sandbox, and resolved settings,
  because manual refresh runs the collector in-process. It serves a production
  build but never builds at start, since a slow or failing build at boot would
  leave the dashboard down. The installer therefore refuses to install without
  `.next/BUILD_ID`, and refuses to start while another process holds the port.

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
  [provision-provider-credentials](backlog/archive/provision-provider-credentials.md)
  — the two remaining live gates (DeepSeek, OpenRouter) wait on human-provisioned
  keys.
