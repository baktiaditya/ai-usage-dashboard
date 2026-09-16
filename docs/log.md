# Bundle Update Log

## 2026-09-17

- **Risk**: plan §4.5 and the implementation disagree on how a failed format or version guard is
  shown. §4.5 lists it under `unavailable`, and the comment in
  `src/lib/ingestors/claude-statusline.ts` says the same, but `UNAVAILABLE_CODES` in
  `src/lib/errors.ts` holds only `not_configured`, `not_entitled`, and `no_event_yet`. The collector
  therefore records `schema_mismatch` and `version_unsupported` as an `error` attempt, and
  `evaluateFreshness` renders `error`, for Codex, DeepSeek, OpenRouter, and the Claude spool alike.
  The divergence predates the Claude poll. It is annotated in §4.5 rather than resolved there,
  because either direction is a cross-provider change that belongs in its own brief. The decision
  is tracked in [#15](https://github.com/baktiaditya/ai-usage-dashboard/issues/15).
- **Decision**: the Claude usage poll follows the implemented mapping, not §4.5. A review of PR #14
  found that [the poll brief](backlog/ready-for-agent/poll-claude-quota-without-a-session.md)
  required `schema_mismatch` on drift while its acceptance criteria required the card to render
  `unavailable`, which the existing collector cannot produce. Drift now renders `error` when no
  spool snapshot is usable, and no Claude-specific status mapping is added. This supersedes the
  2026-09-16 shorthand "render drift as `unavailable`" in plan §3.1.
- **Decision**: every poll failure falls back to the spool, not only a `429`. A `401`, a transport
  failure, a timeout, or a drifted shape leaves the spool exactly as valid as a refusal does. When
  the spool has nothing usable, the composite surfaces the poll's failure code, because the user
  configured the token and that code is the one that explains the card.
- **Update**: the brief now states that `src/lib/adapters/http.ts` must be extended, rather than
  "only if" needed. `HttpGetOptions` accepts no extra headers and `getJsonLossless` hard-codes its
  `User-Agent`, while the poll requires `anthropic-beta` and a `claude-cli/<version>` agent. It
  also forbids wrapping the poll in `withBoundedRetry`, since `rate_limited` is a retryable code.

## 2026-09-16

- **Decision**: [the plan](plan/ai-usage-dashboard-implementation-plan.md) now gives a Claude
  usage refusal conditional, not unconditional, status semantics. The
  composite falls back to the spool without retrying. A usable spool snapshot produces one
  successful Claude attempt and ordinary source freshness decides `healthy` or `stale`; without a
  usable spool the attempt is `error`, and any older snapshot is historical. This replaces the
  earlier shorthand below that said every refusal degrades to `stale`, which contradicted the
  canonical latest-attempt precedence.
- **Design**: [the poll brief](backlog/ready-for-agent/poll-claude-quota-without-a-session.md)
  specifies that the five-minute Claude usage floor is enforced by an atomic, durable SQLite claim,
  not by configuration or process memory. The systemd collector is a new oneshot process on every
  run, while manual refresh runs in the web process; only shared state prevents either path, or two
  overlapping paths, from calling the endpoint inside the interval. The planned migration `0003`
  must therefore create singleton `claude_poll_state(last_attempted_at)` alongside the
  credential-table rebuild; it has not been implemented yet.
  Claiming happens before the request, so a refusal or crash conservatively spends the interval;
  a caller that loses the claim reads the spool without polling.
- **Update**: the hand-run usage probe now validates the contract recorded in
  [M0 discovery](discovery/m0-discovery.md). It accepts real
  ISO-8601 offsets without accepting impossible calendar dates, distinguishes missing nullable
  fields from explicit `null`, maps absent/empty/all-inactive `limits[]` to `not_entitled`, rejects
  malformed credential JSON and whitespace-only file tokens cleanly, counts withheld names through
  every array row, and never reads or prints a non-2xx provider body. Focused unit tests cover those
  boundaries.
- **Decision**: Claude keeps exactly one collector adapter. A second review found that the brief's
  two-source design could not be built as written: `src/lib/collector/index.ts` states "one run,
  one attempt per provider", `getLatestAttempts` partitions by provider alone, and
  `evaluateFreshness` lets a failed attempt dominate any snapshot. Two adapters both named `claude`
  would overwrite each other's latest attempt, and a poll refused with `429` would drive the card
  to `error` on top of a perfectly good spool reading. The poll and the spool are therefore
  composed behind a single adapter that emits one attempt and one snapshot, with precedence by
  `observedAt` decided inside it rather than in `src/lib/queries/overview.ts`. `sourceVersion`
  records which source won; `sourceEventId` stays the spool's event id when the spool wins and is
  `null` when the poll wins, which is what the partial unique index already expects. The
  alternative — a source discriminator on attempts and snapshots, with matching partition and
  freshness keys — was rejected as a large schema change bought for one provider.
- **Discovery**: `freshnessBudgetMs` keys on the provider, so it cannot tell a polled Claude
  observation from a spooled one. It needs the source passed in. Widening `PULL_PROVIDERS` to
  include `claude` was considered and rejected: it would silently change how a spool-only install
  ages out.
- **Update**: the same review found the poll was cited as plan §3.2 throughout the bundle. §3.2 is
  the Dashboard; the poll lives in §3.1 under Claude Code. Corrected in the plan, discovery and
  this log. The probe count is reconciled to three everywhere, the brief's acceptance criteria now
  name the credential row and the normalised observations as the two deliberate exceptions to
  "nothing sensitive in the database" rather than forbidding what the feature exists to do, and
  [#13](https://github.com/baktiaditya/ai-usage-dashboard/issues/13) has had its body rewritten:
  it still carried the open questions and the `ready-for-human` path after promotion.
- **Decision**: the plan's Claude-poll amendment is completed. The first pass amended
  [the plan](plan/ai-usage-dashboard-implementation-plan.md) §2 and §3.1 only, and code review
  found three further passages still asserting the pre-amendment world, which left the canonical
  document contradicting itself and the brief unexecutable.
  - §3.3 said the collector pulls Codex, DeepSeek and OpenRouter and ingests the Claude spool. It
    now records the optional poll joining that parallel pull, and states that the five-minute floor
    belongs to the poll rather than to the timer, so a manual refresh cannot bypass it.
  - §4.4 said the database stores no OAuth tokens and exactly two API keys. The Claude token from
    `claude setup-token` is an OAuth token, so that sentence forbade the very thing §3.1 now
    permits. It now names the token as the single exception — user-supplied, never read from a
    CLI's auth file — and the prohibition on reading `~/.claude/.credentials.json` is restated
    unchanged.
  - §7 said Claude shows quota only when the bridge receives a payload. It now accepts either
    source, spool by default.
  - §3.5 gains the optional third key, with the reason it differs in kind: DeepSeek and OpenRouter
    report nothing without their key, while Claude keeps reporting through the spool, so Settings
    must say the Claude field is optional or an empty field reads as a broken provider.
- **Discovery**: widening `CREDENTIAL_PROVIDERS` does not reach the database. The provider column
  is constrained twice more — a Drizzle `enum` in `src/lib/db/schema.ts` and
  `CHECK (provider IN ('deepseek', 'openrouter'))` in `drizzle/0002_provider_credentials.sql` —
  and `readProviderCredentials` in `src/lib/db/credentials.ts` returns a hand-written two-field
  object rather than following the constant. The brief's impact map claimed the credential store
  would follow automatically; had it been implemented as written, saving a Claude token would have
  been refused by the `CHECK`. The brief now carries the migration, the regenerated
  `migrations.generated.ts`, the read model, and their tests. SQLite cannot alter a `CHECK` in
  place, so `0003` rebuilds the table and `0002` stays untouched as history.
- **Update**: the usage-endpoint gate is now recorded in
  [M0 discovery](discovery/m0-discovery.md), superseding the note in the `Proposed` entry below
  that deliberately left that document unchanged. That note was right while the source was a
  proposal; the plan has since accepted it, and
  [the sync map](../.agents/skills/okf-sync/references/repo-sync-map.md) puts a passing provider
  gate in discovery. The record withholds the codenamed key names and keeps only their count, which
  is the drift signal. `pnpm run spike:claude-usage` is also added to the README command table.
- **Decision**: Claude quota may be polled, as an optional source that is off by default. This
  amends [the plan](plan/ai-usage-dashboard-implementation-plan.md) §2 and §3.1.
  - §2 "Structured source first" previously forbade calling internal endpoints with extracted
    tokens outright. It now carries one narrow exception, for Claude quota only, and only because
    no documented interface answers while no session is live. The token must be minted
    deliberately with `claude setup-token`; extracting one from `~/.claude/.credentials.json` stays
    forbidden, which is what that clause was written to prevent.
  - §2 "Separate pull and event ingestion" now records that Claude may also be polled.
  - §3.1 previously ruled `/usage` out as an MVP source. It stays ruled out as a _source_:
    `claude -p "/usage"` is a diagnostic, and no value it prints is stored, because its percentages
    are integers and its reset time is a rounded relative duration.
  - §3.1 gains the optional poll: read the normalised `limits[]` projection, at most one request
    per five minutes, never retry a refusal, fall back to the spool on refusal, and render drift as
    `unavailable`. The newer decision above records the exact status when the fallback succeeds or
    fails. The status-line spool stays the default and the fallback.
  - Default-off was chosen so that cloning this repository never causes an undocumented Anthropic
    endpoint to be called without the user opting in.
  - The codenamed keys the endpoint returns are deliberately not recorded anywhere in this
    repository. `scripts/spike-claude-oauth-usage.ts` reports them at runtime without hard-coding
    them, so drift stays visible without the bundle publishing the list.
- **Discovery**: `CREDENTIAL_PROVIDERS` in `src/lib/domain.ts` is not an internal list.
  `src/components/settings-dialog.tsx` maps over it, so adding a provider renders a new field in
  Settings on its own, and `src/app/api/settings/credentials/[provider]/route.ts`,
  `tests/unit/settings-dialog.test.tsx` and `tests/e2e/settings.spec.ts` all follow it. Widening it
  for Claude is therefore a browser-visible change that Playwright must cover, and the doc comment
  above the constant — "Codex and Claude authenticate through their own CLIs and have no key here"
  — has to be rewritten. The Claude token is also optional in a way the other two are not: the
  status-line spool keeps reporting quota without it, so the Settings copy must say so. The brief's
  impact map and testing plan were corrected accordingly; its first version understated both.
- **Update**: [poll-claude-quota-without-a-session](backlog/ready-for-agent/poll-claude-quota-without-a-session.md)
  is promoted to `ready-for-agent/` on the decision above, and
  [#13](https://github.com/baktiaditya/ai-usage-dashboard/issues/13) is relabelled to match.
  Whether `claude -p "/usage"` calls the same endpoint underneath was probed with `claude --debug`
  and stayed inconclusive; it no longer blocks anything, because that path is a diagnostic rather
  than a fallback source.

- **Discovery**: Claude quota can be read without a live Claude Code session. Two pull-shaped
  sources were probed live on the development machine, and both answered while no session was
  running.
  - `GET /api/oauth/usage`, the source Claude Code reads for `/usage`, returned `200 OK` on every
    probe. Two were run when this entry was first written and a third followed the same day, each
    at least five minutes apart. Active windows carry `utilization` plus an absolute ISO-8601
    `resets_at`, and the payload also exposes a normalised `limits[]` projection, per-model
    breakdown rows, and credits in minor units with an explicit currency and decimal places. The
    endpoint is undocumented, its upstream issue is labelled `invalid`, and refusals escalate
    30/60/120/240/300s with no `Retry-After`, so one request per five minutes or slower is the
    only safe cadence. Its OAuth token expires and is rotated by Claude Code, so a collector that
    refreshes it races the CLI for the same file.
  - `claude -p "/usage"` consumes no quota — the `--output-format json` envelope reports zero
    turns, zero tokens, zero API duration and `local_command: "usage"` — but returns the numbers
    as human-rendered prose with integer percentages, and its reset time is a rounded relative
    duration that differed between two runs seconds apart. It is a good health check and a poor
    data source.
  - `claude auth status` reports `loggedIn` reliably but `subscriptionType` is `null` on this Pro
    account, so it cannot confirm plan tier. It also returns an email address and an organisation
    ID, which must never reach the database or this bundle.
  - Evidence is shape-only. No quota value, token, email address or account ID was recorded, here
    or anywhere in the repository.
  - `scripts/spike-claude-oauth-usage.ts` (`pnpm run spike:claude-usage`) is the gate probe. It
    sends exactly one request, never retries a refusal, never writes the credentials file, and
    prints structure with every leaf elided.
- **Proposed**: [poll-claude-quota-without-a-session](backlog/ready-for-agent/poll-claude-quota-without-a-session.md)
  files the above as a brief, first in `ready-for-human/` and promoted the same day, tracked by
  [#13](https://github.com/baktiaditya/ai-usage-dashboard/issues/13). It is blocked on a user decision, because the
  plan §2 and §3.1 both state that Claude quota arrives via the status line; that contradiction
  must be resolved in the plan before the brief can be worked. `docs/discovery/m0-discovery.md` is
  deliberately left unchanged — it records gates for accepted provider contracts, and this source
  is a proposal, not yet a contract.

## 2026-09-15

- **Update**: the move to pnpm is delivered in
  [PR #11](https://github.com/baktiaditya/ai-usage-dashboard/pull/11), merged as `820d873` and
  deployed to the production checkout, and
  [migrate-from-npm-to-pnpm](backlog/archive/migrate-from-npm-to-pnpm.md) moves to `archive/`.
  In that PR:
  - `pnpm import` kept all 739 resolved versions.
  - `allowBuilds` names exactly `@tailwindcss/oxide@4.1.13`, `better-sqlite3@12.4.1`,
    `esbuild@0.25.12` and `unrs-resolver@1.12.2`. Dropping one entry makes
    `pnpm install --frozen-lockfile` fail with `ERR_PNPM_IGNORED_BUILDS` naming it.
  - `packageManager` pins `pnpm@12.4.2` with the sha512 hash corepack's `lastKnownGood.json`
    records, and `engines.node` is `^24.15.0`.
  - Existing installs run `corepack enable pnpm` once per Node installation, on Node 24.15 or a
    later Node 24 release.
  - `db:backup` and `db:restore` accept both `<file>` and `-- <file>`.
  - `pnpm-workspace.yaml` sets `pmOnFail: ignore`, so `pnpm-lock.yaml` is one YAML document with
    the same resolved versions. Otherwise pnpm 12 writes an environment document first, which
    GitHub's dependency graph reads as zero dependencies
    ([dependabot-core#15904](https://github.com/dependabot/dependabot-core/issues/15904), open).
    Dependabot alerts are off for this repository, so no alert was hidden. Corepack alone enforces
    the pin; a pnpm run outside corepack ignores `packageManager` instead of switching to it. With
    this lockfile the Setup §6 deploy and rollback passed in zsh and bash, and
    `pnpm install --frozen-lockfile` left the checkout clean.
  - [Setup](operations/setup.md) §6 caches the candidate's pinned pnpm before any unit stops, and
    rolls back with `npm ci` to a commit that has only `package-lock.json`. Its deploy preflight
    also requires `pnpm-lock.yaml` and a `pnpm@<version>+sha512.<hash>` pin, and its rollback
    preflight refuses any other pin. In rehearsals, candidates with the lockfile and no pin, a bare
    `pnpm@12.4.2` pin, or a hash corepack rejected all stopped at the preflight, and no unit was
    stopped. A candidate with the hashed pin still deployed and rolled back in zsh and bash.

  Plan §4.1, §3.3, §3.4 and §3.5, Setup, the README and `AGENTS.md` describe pnpm in that PR. In
  throwaway clones, with an empty `COREPACK_HOME` and standard input closed, the Setup §6 blocks ran
  verbatim in zsh and bash against shimmed units. Each pass:
  1. cached pnpm and its platform binary during the preflight;
  2. replaced the npm-built `node_modules` without a prompt;
  3. passed `verify` and `build`;
  4. rolled back to `e2d553c` with `npm ci`.

  `pnpm run verify`, `pnpm run test:e2e`, `pnpm audit`, a fresh-clone install, migrate and build, and
  the pre-commit hook passed through pnpm.

  The production checkout then moved from `e2d553c` to `820d873`. The Setup §6 blocks from
  `origin/main` ran verbatim in bash with standard input closed:
  1. the preflight cached the pinned pnpm before any unit stopped;
  2. `pnpm install --frozen-lockfile` replaced the npm-built `node_modules` without a prompt;
  3. `verify` and `build` passed;
  4. no rollback was needed.

  The verify block showed a clean checkout on `origin/main`, both units running from the production
  checkout with installed units identical to the rendered ones, and the dashboard answering. The
  timer's first run, a manual Codex refresh from the dashboard, and the next scheduled run all
  recorded successful attempts for every provider they collected.

- **Decision**: the package manager moves from npm to pnpm, and
  [migrate-from-npm-to-pnpm](backlog/archive/migrate-from-npm-to-pnpm.md) is promoted to
  `ready-for-agent/`. The user chose each term:
  - pnpm and `pnpm-lock.yaml` replace npm and `package-lock.json`. This supersedes the
    "npm + `package-lock.json`" pin in [plan](plan/ai-usage-dashboard-implementation-plan.md) §4.1
    and the `npm run` commands in §3.3, §3.4, and §3.5.
  - pnpm is provided through corepack, with `packageManager` pinned to `pnpm@12.4.2` plus its
    sha512 integrity hash.
  - `engines.node` narrows from `>=22.12.0` to `^24.15.0`. Corepack 0.35.0 supports only
    `^22.22.2 || ^24.15.0 || >=26.0.0`, Node 25 no longer bundles corepack and falls outside that
    range, and the trial ran only on Node 24.19.0. Node 25 is unsupported; widening to Node 22 or
    26 waits for CI in the open-source release. This corrects, the same day after review, an
    earlier version of this entry that had Node 25 install corepack with `npm install -g corepack`.
  - The build allowlist moves to `allowBuilds` at the exact versions `allowScripts` already names,
    dropping the unused `esbuild@0.28.2`, so no future version runs an install script unreviewed.
  - The production deploy confirms, before any unit stops, that corepack has the pinned pnpm cached.
  - The migration lands before the open-source release is implemented, so that work adopts pnpm.
  - The agent may deploy the first pnpm commit to the production checkout once a deploy and
    rollback rehearsal in a throwaway clone passes.

  The plan, [Setup](operations/setup.md), and the README change on delivery; until then npm is what
  runs.

- **Proposed**: migrating the package manager from npm to pnpm, filed as
  [migrate-from-npm-to-pnpm](backlog/archive/migrate-from-npm-to-pnpm.md). A trial at
  `e2d553c` in a throwaway clone, with pnpm 12.4.2, found no blocker: `pnpm import` kept every
  resolved version, and `verify`, `build`, `test:e2e`, and `pnpm audit` passed once the native build
  allowlist moved to `allowBuilds` in `pnpm-workspace.yaml` and `pnpm-lock.yaml` joined
  `.prettierignore`. It also found that pnpm forwards a literal `--` to scripts, which would break
  the documented `db:backup -- <file>` and `db:restore -- <file>` forms. The brief waits on the
  user to order it against the open-source release and to choose how pnpm is installed.
  Plan §4.1 still pins npm, and [Setup](operations/setup.md) still describes it.

- **Update**: the Claude status line now runs its bridge from the production checkout. It was
  installed on 2026-09-12 from the development repository, and the 2026-09-14 move to a
  [separate production checkout](backlog/archive/separate-production-checkout.md) did not repoint
  it, so the production spool depended on the branch checked out for development. Re-running
  `npm run claude:install-statusline -- --apply` from the production checkout refreshed the
  installation in place: only the bridge path changed, `settings.json` stayed `0600` with a backup,
  and the spool was next written through the new path 12 seconds later.
  [Setup](operations/setup.md) §3 and §6 now say to install from the production checkout and to
  keep the `--`, without which npm consumes `--apply` and only a dry run happens.

- **Update**: provider keys are saved from the dashboard's Settings dialog, and
  [store-provider-keys-in-settings](backlog/archive/store-provider-keys-in-settings.md) moves to
  `archive/`. Migration `0002` adds `provider_credentials`. Every collection path — the systemd
  collector, `npm run collect`, and manual refresh — reads the DeepSeek and OpenRouter keys from the
  database at the start of each run, and `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` are no
  longer read from any environment; `npm run collect` logs one warning naming them, never their
  values, while either is set. `GET /api/settings/credentials` and `PUT` and `DELETE
/api/settings/credentials/[provider]` require a same-origin request, reads included, answer
  `Cache-Control: no-store`, and return only whether a key is saved, its last four characters for a
  key of at least 16 characters, and when it was saved. The dialog uses `@floating-ui/react`
  `0.27.20`. The development launcher no longer rewrites the credential variables, and development
  refresh still answers `409 refresh_disabled` without `AUD_DEV_LIVE_REFRESH=1`. Beyond the brief,
  an outside press dismisses the dialog on `click` rather than `pointerdown`: in the browser, the
  `mousedown` after a pointerdown dismissal moved focus off the Settings button. An integration test
  also runs `scripts/collect.ts` itself to prove the warning. [Setup](operations/setup.md) §1, §4,
  §6, §7, §9, §10 and §11, the README, [m0-discovery](discovery/m0-discovery.md), and
  [plan](plan/ai-usage-dashboard-implementation-plan.md) §0, §3.4, §3.5, §4.4 and §5 now describe the
  delivered behavior. `npm run verify` and `npm run test:e2e` passed in the development checkout with
  fake keys only. Not performed: deploying to the production checkout, saving the real keys, and live
  collection from them. After deploy, both cards read `unavailable` until the Setup §4 upgrade steps
  are followed.

- **Decision**: provider keys move from the environment into the database, entered from a Settings
  dialog on the dashboard. The canonical contract is
  [plan §3.5](plan/ai-usage-dashboard-implementation-plan.md), and the implementation brief is
  [store-provider-keys-in-settings](backlog/archive/store-provider-keys-in-settings.md),
  now in `ready-for-agent/`. The user chose each term. The DeepSeek API key and the OpenRouter
  Management key are stored in plaintext in the `0600` database, so `npm run db:backup` files
  contain them. `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` are removed outright, with no
  environment fallback and no one-time import. After the upgrade, an install shows both cards as
  `unavailable` until the keys are saved in Settings. The settings API sends the browser only
  whether a key is saved, its last four characters, and when it was saved. The OpenRouter field
  is labelled "OpenRouter Management Key" (changed by the user the same day from "OpenRouter API Key"). This supersedes plan §5's
  environment-file rule, the §4.4 statement that the database stores no API keys, and the
  unqualified "never send any credential to the browser" rule in Setup §11 and the README. Those
  documents change on delivery, and until then the environment behavior in Setup §4 is what runs.

- **Update**: the production deploy and rollback runbook in [setup §6](operations/setup.md) now
  fails closed and reads its settings from the rendered web unit. A unit that does not stop halts
  the procedure before the checkout changes. The installer runs without `--enable`, because its
  own activation starts the timer before the port check and the web restart. The runbook then
  refuses a port held by another process, restarts the web unit, waits until it answers, and starts
  the timer last, so a failed web start leaves the collector stopped. Step 3 reads `AUD_HOST` and
  `AUD_PORT` back from `systemd/generated/ai-usage-dashboard-web.service`, and the verify block
  also reads `AUD_DATA_DIR` there. A non-default host, port or data directory therefore needs no
  edits: an IPv6 host such as `::1` is bracketed in the URL, and the database query opens
  `$DATA_DIR/usage.db`. Reading the unit back is exact because the renderer refuses whitespace,
  quotes and backslashes and writes `%` as `%%`. The 2026-09-14 migration ran the earlier
  `--install --enable --with-web` sequence; the new sequence has been exercised in bash and zsh with
  shimmed `systemctl`, `npm`, `git`, `ss`, `curl` and installer, and has not run against the
  live units. Making the installer's own activation fail closed remains a code change outside this
  runbook.

## 2026-09-14

- **Update**: production now runs from its own checkout, and
  [separate-production-checkout](backlog/archive/separate-production-checkout.md) moves to
  `archive/`. Both user units were reinstalled from the separate clone at
  `/home/bago/Workspace/ai-usage-dashboard-prod`, detached at `f6fcb03` from `origin/main`. The
  data directory, `collector.env`, host, port, 5-minute interval and boot enablement are unchanged,
  and the rendered units are byte-identical to the installed ones. Before cutover, `npm ci`,
  `npm run verify` and `npm run build` passed in the clone while the old units kept serving. After
  cutover the dashboard answered on `127.0.0.1:3838`, and manual refreshes and scheduled runs
  recorded successful attempts in `collector_runs` and `collector_attempts`. They kept succeeding
  after an `npm run build` in the development repository, which left the production `BUILD_ID` and
  web process untouched. A rollback rehearsal and a redeploy each ran the full
  stop/detach/`npm ci`/build/reinstall sequence and passed the same checks. The recorded pre-migration
  SHA and the candidate were both `f6fcb03`, so both passes deployed the same revision. Before the
  migration, the development checkout's `HEAD` was `f6fcb03`, but its web unit served a `.next`
  built from an unmerged branch at an unrecorded commit — the failure this change removes. Setup §6
  now holds the deploy, failure and rollback runbook. The installer's closing "After pulling
  changes" hint still describes an in-place rebuild; the runbook supersedes it in the production
  checkout, and changing the hint is a code change outside this brief. The boot acceptance check
  needs a real reboot and was not performed.

- **Decision**: production-checkout isolation is fixed and ready for implementation in
  [separate-production-checkout](backlog/archive/separate-production-checkout.md).
  Production deploys only commits from `origin/main` through the separate clone at
  `/home/bago/Workspace/ai-usage-dashboard-prod`; no development or hotfix commit originates there.
  Brief downtime is accepted so the timer, any active collector service, and the web unit can stop
  before source, dependencies, or `.next` change. Each deploy records its candidate and previous
  SHA, and rollback restores source, dependencies, build, and rendered units from one known-good
  commit. The user authorizes creating the clone, reinstalling and restarting both user units, and
  rehearsing rollback. Setup §6 receives the canonical runbook after the live migration succeeds.

- **Update**: development-server isolation is delivered, and
  [isolate-dev-server-from-production](backlog/archive/isolate-dev-server-from-production.md)
  moves to `archive/`. `npm run dev` binds `127.0.0.1:3839` with its own
  `ai-usage-dashboard-dev` data directory. `src/lib/dev-environment.ts` parses
  `AUD_DEV_PORT`, `AUD_DEV_DATA_DIR` and `AUD_DEV_LIVE_REFRESH` for the launcher
  only, refuses a development port equal to the resolved production `AUD_PORT`
  with exit code `2`, and hands `next dev` a complete environment. Beyond the
  brief, it also refuses an `AUD_DEV_DATA_DIR` that resolves to the production
  data directory, through symlinks and even before either directory exists, or
  that cannot be resolved at all, since opening that database would migrate it; and a blank `AUD_DEV_LIVE_REFRESH` is rejected rather than read as unset,
  matching the brief's unset/`0`/`1` rule. Without the
  opt-in, that child gets empty DeepSeek and OpenRouter keys and the internal
  `AUD_REFRESH_ENABLED=0`, so manual refresh answers `409 refresh_disabled`
  before the rate limiter, the database, or any adapter, Codex included.
  `npm run seed:dev` seeds only that directory; tests keep a production database
  named in `collector.env` or the shell byte-for-byte unchanged. `npm run start`,
  collection, and both systemd units keep their defaults, and existing installs
  need no action. [Setup](operations/setup.md) §1, §6 and §7, `README.md`,
  `.env.example`, and plan §0 and §3.4 describe the delivered behavior.

- **Update**: units installed before the kebab-case rename below keep
  `Documentation=file://…/docs/operations/SETUP.md`, which no longer exists. The
  services still run; only the metadata link dangles. Re-render them with
  `scripts/install-systemd.sh --install` (plus `--with-web` when the web unit is
  installed), which reloads systemd without restarting anything.
  [Setup](operations/setup.md) §5 now says to re-run the installer after pulling
  a template change. Plan §0 and §3.4 also mark development isolation as decided
  but not yet implemented, so the plan no longer reads as fully delivered.

- **Restructure**: all markdown filenames under `docs/` are lowercase kebab-case.
  `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md` is now
  [implementation plan](plan/ai-usage-dashboard-implementation-plan.md),
  `docs/plan/AI_Usage_Dashboard_Implementation_Prompt.md` is now
  [implementation prompt](plan/ai-usage-dashboard-implementation-prompt.md),
  `docs/discovery/M0_DISCOVERY.md` is now [m0 discovery](discovery/m0-discovery.md),
  and `docs/operations/SETUP.md` is now [setup](operations/setup.md). References
  updated across `docs/`, `README.md`, `AGENTS.md`, both okf-sync skills, `src/`
  comments, systemd templates, and `.env.example`; no content changed.

- **Decision**: development-server isolation is fixed and ready for implementation in
  [isolate-dev-server-from-production](backlog/archive/isolate-dev-server-from-production.md).
  `npm run dev` defaults to loopback port `3839`, an empty XDG data directory named
  `ai-usage-dashboard-dev`, and side-effect-free disabled manual refresh. Live refresh requires
  `AUD_DEV_LIVE_REFRESH=1`; the default child receives no DeepSeek/OpenRouter credential values and
  cannot run the credentialless Codex adapter. Development settings live behind a launcher seam so
  malformed `AUD_DEV_*` values cannot stop production entry points. `seed:dev` is explicit and may
  target only the resolved development directory. Plan §3.4 owns the canonical contract; the brief
  has no remaining question or external credential gate.

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
  are formatted through `decimal.js`. Tooltips format the stored string, not
  the plotted number, to two decimal places, as the card does; the note says so
  rather than promising exact figures.

- **Creation**: [Agents](agents/index.md) joins the bundle with
  [Issue tracker](agents/issue-tracker.md),
  [Triage labels](agents/triage-labels.md) and [Domain docs](agents/domain.md).
  The okf-sync skill trees and its sync map list the folder, and the bundle
  validator now fails when a top-level `docs/` folder is missing from them.

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
  schema. Procedure: [Setup](operations/setup.md) §1.

- **Update**: the web unit carries `AUD_HOST` and `AUD_PORT`. The installer
  resolved and reported both, but the rendered unit left them out, so a value
  exported only in the installing shell was lost: the installer announced port
  `4444` while the service bound `3838`. The units keep the host and port they
  were rendered with, like the data directory and interval, so the installer
  must be re-run after either changes ([Setup](operations/setup.md) §5).

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
  recovers with a rebuild and a restart ([Setup](operations/setup.md) §10).

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

  Procedure: [Setup](operations/setup.md) §1.

- **Update**: Setup names the minimum supported CLI versions, as plan §4.1
  requires: `codex-cli 0.154.0` and Claude Code 2.1.269, the versions
  live-verified in [M0 Discovery](discovery/m0-discovery.md). Older releases
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
  provider. [M0 Discovery](discovery/m0-discovery.md), the README, and the
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
  development from reaching production:
  - [isolate-dev-server-from-production](backlog/archive/isolate-dev-server-from-production.md)
    began here as a human-gated port/data proposal and is promoted by the decision above.
  - [separate-production-checkout](backlog/archive/separate-production-checkout.md)
    began here as a human-gated proposal and is promoted by the decision above.

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
  [Setup](operations/setup.md):
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
  several operator-facing facts, now in [Setup](operations/setup.md):
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
  [plan](plan/ai-usage-dashboard-implementation-plan.md): only the derived
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
  [Setup](operations/setup.md): it constrains how an agent may interpret a result,
  while installing the `embeddings` extra is per-machine state that step 1's
  existing tools-unavailable clause already covers. `README.md` is unchanged —
  the fact is agent-facing and has no bearing on product commands.

- **Tooling**: Husky git hooks, copied from Kyomi-pos and adapted from Yarn to
  npm (`npx`/`npm run`; `commitlint.config.cjs` because this repo is
  `"type": "module"`). `pre-commit` runs lint-staged (Prettier), then
  `typecheck` plus related Vitest files in parallel when TS/TSX is staged;
  `commit-msg` enforces Conventional Commits with a 72-character subject cap.
  [Setup](operations/setup.md) documents the hooks.

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
  [Implementation Plan](plan/ai-usage-dashboard-implementation-plan.md) for scope and
  contracts, [M0 Discovery](discovery/m0-discovery.md) for what is live-verified vs
  fixture-tested, [Setup](operations/setup.md) for operations. The
  [`okf-sync`](../.agents/skills/okf-sync/SKILL.md) skill and its validator keep
  the bundle coherent. First brief filed:
  [provision-provider-credentials](backlog/archive/provision-provider-credentials.md)
  — the two remaining live gates (DeepSeek, OpenRouter) wait on human-provisioned
  keys.
