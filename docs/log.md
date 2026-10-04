# Bundle Update Log

## 2026-10-04

- **Update**: the published one-line command was run end to end from the `v0.2.0` tag,
  closing the "installation through the published one-line command" gap that the
  [2026-10-03 installer entry](#2026-10-03) left as not performed. It ran on a Linux x86_64
  workstation, in a disposable account (`audtest`) with linger and its own user manager,
  separate from the account running the production units. The script was fetched from
  `raw.githubusercontent.com/.../v0.2.0/scripts/install.sh` and piped to
  `bash -s -- --version v0.2.0`, with `AUD_PORT=3840`. That port was set only because
  production (3838) and the dev server (3839) share the loopback interface.
  - **Install:** exit `0` after 104 s. It resolved `v0.2.0` to `411c27e`, downloaded and
    verified Node v24.19.0, and built the release. Web and timer were active and enabled,
    and linger was on. The installer printed the loopback URL and noted that the launcher
    directory is not on that account's `PATH`.
  - **Health:** `ai-usage-dashboard status` exited `0` with no recovery pending, and
    `http://127.0.0.1:3840/` answered `200`.
  - **First collection:** the run recorded `error: 0`. Codex read `unavailable` /
    `cli_not_found` because no `codex` was on the account's `PATH`, which confirms
    [#33](https://github.com/baktiaditya/ai-usage-dashboard/issues/33) on a real install.
    Claude read `no_event_yet`, and DeepSeek, OpenRouter, and OpenCode Go read
    `not_configured`. `/api/overview` and the database agreed.
  - **Uninstall:** exit `0`. Units and the launcher were removed, while the database, the
    data ownership record, and linger were kept, as specified.
  - **Still not performed:** reboot persistence; `update` from one published tag to
    another, which needs a second release that contains the installer; and a managed install
    with real provider credentials or a signed-in Codex CLI.

- **Update**: release `v0.2.0` is prepared, the first release that contains the managed
  installer. `package.json`, the HTTP `User-Agent`, and the Codex `clientInfo` move to
  `0.2.0`, and [CHANGELOG](../CHANGELOG.md) gains the `0.2.0` entry (#31, #38, #39). The
  public one-line command in the [README](../README.md),
  [setup](operations/setup.md#command-interface), and plan
  [§4.1.1](plan/ai-usage-dashboard-implementation-plan.md#411-managed-linux-installation)
  now pins `v0.2.0` instead of a placeholder. The disposable-systemd rehearsal sets its
  fixture's version to `0.1.0` before tagging `v0.1.0`, because the source now carries
  `0.2.0` and the installer refuses a tag that disagrees with `package.json`. The tag is
  created on the merge commit after this change lands.

- **Decision**: a local CLI that is not installed or not on `PATH` reads `unavailable`, not
  `error` ([#33](https://github.com/baktiaditya/ai-usage-dashboard/issues/33)). Plan
  [§4.5](plan/ai-usage-dashboard-implementation-plan.md#45-status-semantics) now lists it under
  `unavailable`. Only a spawn-time `ENOENT` maps to the new code `cli_not_found`. It is not
  retried and carries a hint to install the CLI or add it to `PATH`. A CLI that is found but
  crashes, exits early, or overflows its buffer stays `process_failed`. A fresh install without
  Codex therefore shows no red card, and `pnpm run collect` exits `0` when nothing else failed.
  Accepted trade-off: an installed service whose baked `PATH` stops reaching `codex`, as after an
  nvm switch, reads `unavailable` with that hint instead of `error`. Keeping `error` and
  classifying by previous success were both declined. The JSON-RPC client now also ignores
  `error` on the child's stdin. A CLI that exits before reading it, such as `/bin/false`, turned
  the next write into an unhandled async `EPIPE` that could crash the collector; the `exit` event
  already reports `process_failed`. The installer's missing-`codex` warning now says
  `unavailable`.

- **Update**: the bootstrap `uninstall --dry-run` preview now names only release, runtime,
  cache, and journal paths that exist, one per line, and reports a proven root with none of
  them left (and no owned unit or launcher) as nothing to remove. A real run already treated
  missing paths as no-ops. Regression assertions cover a journal-proven root whose runtime
  tree is gone and an ownership-record-only root.
  Validation: `pnpm run verify` passes (41 files, 758 tests); Bash syntax passes.

- **Update**: addressed the dry-run preview nit in PR
  [#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38#issuecomment-5972857408).
  When no runtime can run the manager, `uninstall --dry-run` no longer reports "nothing to
  remove" while owned remnants exist. A read-only collector now shares its ownership
  decision with the removal path, and the preview names the units (stop, disable, remove),
  the launcher, and the release/runtime/cache trees plus journal that a real run would
  remove — or notes that an absent root would not be created. Regression assertions cover
  unit-only, launcher-only, and combined absent-root remnants, a proven tree-only root, the
  held-lock preview, and the unchanged no-op wording.
  Validation: `pnpm run verify` passes (41 files, 757 tests), including 92 installer tests;
  Bash syntax, OKF bundle validation, and `git diff --check` pass.

- **Update**: corrected the absent-root cleanup regression reported in PR
  [#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38#issuecomment-5972228752).
  Bootstrap uninstall checks owned services and launcher before requiring the root to
  exist. If owned external remnants survive a removed root, it stops/disables/removes only
  those units and removes the owned launcher, without creating a root or lifecycle lock.
  This cleanup mode cannot delete release/runtime/cache trees or a journal, including if
  a root appears during the service commands. Existing roots still take the lifecycle lock
  before manager selection or cleanup. Regression coverage exercises unit-only,
  launcher-only, and combined remnants, preserves foreign surfaces and application data,
  verifies dry runs and repeat invocation, and checks that a newly appearing root survives.
  [Setup](operations/setup.md#lifecycle-semantics) distinguishes absent roots with and
  without owned remnants.
  Validation: `pnpm run verify` passes (40 files, 753 tests), including 92 installer tests;
  Bash syntax, OKF bundle validation, and `git diff --check` pass. An initial full-gate
  attempt failed to start three existing fixture health servers. The installer suite alone
  and subsequent full runs passed; the cause remains unconfirmed and temporary diagnostics
  were removed before the final gate.

- **Update**: addressed the optional foreign/absent-root finding in PR
  [#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38#issuecomment-5972003666).
  Bootstrap uninstall now checks for managed evidence without writing: an absent root or
  an unrecognized directory succeeds without creating a directory or `lifecycle.lock`.
  Existing lock/metadata files or owned services/launcher still select the locked lifecycle
  path, whose manager or fallback rechecks removal ownership under the lock. The evidence
  check and cleanup share service/launcher predicates, preserving recovery for unit-only
  and launcher-only remnants. Regression tests cover absent, empty, unrelated-file, and
  unproven-tree roots, plus launcher-only cleanup; the held-lock refusal and retry remain
  covered. [Setup](operations/setup.md#lifecycle-semantics) records the no-op behavior.
  Validation: `pnpm run verify` passes (40 files, 749 tests), including 88 installer tests;
  Bash syntax, OKF bundle validation, and `git diff --check` pass. One full-gate attempt
  failed to start an existing fixture health server; that test passed in isolation and the
  subsequent full gate passed. The cause of that startup failure is unconfirmed.

- **Update**: addressed the remaining lifecycle-lock finding in PR
  [#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38#issuecomment-5971772481).
  The bootstrap now shares its nonblocking install lock with mutating uninstall, taking it
  before manager selection, state validation, and fallback cleanup. An incomplete first
  install's releases, runtime, cache, journal, units, and launcher therefore survive a
  concurrent uninstall attempt; cleanup succeeds after the holder releases the lock and
  keeps application data and its ownership record. Regression coverage drives the real
  bootstrap under a separately held `flock`, checks those preserved surfaces and active
  units, then retries after release. Bootstrap fallback status and dry runs remain
  observational, including when the root is absent. The behavior is documented in
  [Setup](operations/setup.md#lifecycle-semantics).
  Validation: `pnpm run verify` passes (40 files, 745 tests), including 84 installer tests;
  Bash syntax, OKF bundle validation, and `git diff --check` pass.

## 2026-10-03

- **Update**: the managed Linux installer is implemented on branch
  `feat/managed-linux-installer` and reviewed through
  PR [#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38), following the approved
  [simplify-linux-installation](backlog/archive/simplify-linux-installation.md)
  brief. Nothing is tagged, published, or deployed by this change, and the public one-line
  command in the [README](../README.md) stays a labelled placeholder until a tagged release
  contains the installer.
  - **Bootstrap and runtime:** `scripts/install.sh` preflights Linux x86_64/glibc ≥ 2.28 and
    the required tools, refuses root, resolves a stable `vX.Y.Z` tag to an exact commit
    reachable from `main` (numeric SemVer, tag/package.json agreement, detached checkout,
    moved-tag refusal), provisions the checksum-verified private Node/Corepack runtime from
    `scripts/install-runtime.env` (Node 24.19.0, official SHA-256), and hands off through a
    versioned interface to the selected checkout's `scripts/manage-installation.ts`. Every
    child runs with stdin on `/dev/null`, so `curl … | bash` never has the piped script
    consumed.
  - **Lifecycle:** the manager (`src/lib/installation/`, stdlib-only so it runs before
    `pnpm install`) implements staged first install, observational status, staged update
    with a verified pre-cutover backup and journaled recovery, explicit Claude bridge
    ownership, data-preserving uninstall, and same-root reinstall through a durable
    `data-ownership.json`. Manual/maintainer units, launchers, roots, and databases are
    refused rather than adopted. Effective configuration is persisted and reapplied on
    update; linger changes require `--enable-linger`.
  - **Evidence performed:** `pnpm run verify` passes (41 files, 758 tests), including 27
    unit tests for release selection, manifests, path boundaries, atomic-temp handling,
    state/journal/ownership validation, retention, and unit ownership, and 66 integration tests that drive the real manager against
    fixture releases with PATH-level systemctl/loginctl/ss stubs, plus 4 health-server
    helper tests. The OKF validator and
    `git diff --check` pass. The rehearsal guard was run for real and refused the
    maintainer's environment (exit 2 without `AUD_INSTALL_SYSTEMD_REHEARSAL=1`, and exit 2
    with it because the account already has dashboard units). A local real-toolchain
    rehearsal then exercised the same lifecycle with user systemd substituted by a process
    launcher: a real Node 24.19.0 download verified against the manifest checksum, a real
    pinned-pnpm frozen-lockfile install, the real `better-sqlite3` prebuilt native module,
    a real Next.js production build with isolated `AUD_DATA_DIR`/`AUD_ENV_FILE`, real SQLite
    migrations, a verified pre-cutover backup, a failed candidate that crossed the database
    boundary and recovered through the previous release's restore executable (failed copy
    retained as `usage.db.pre-restore-*`), a successful update that refreshed an owned
    Claude bridge while preserving its wrapped command, real HTTP 200 at the configured
    loopback URL, and uninstall → reinstall that preserved three collected runs. An
    `agent-browser` session against that live install captured the dashboard and the
    Settings entry point (no key was saved) and was closed afterwards. Two real defects
    were found and fixed on the way: a candidate web unit that fails to start now enters
    update recovery instead of escaping it, and timer ownership is derived from the owned
    collector service instead of a `WorkingDirectory` the timer template does not carry.
  - **Disposable-systemd rehearsal:** after the CI job was taught to give the throwaway
    account a real login session, XDG bases inside its own home, and unprivileged user
    namespaces, the full rehearsal passes in CI (49 checks, 0 failures): real units and HTTP
    health, a scheduled timer run, a failed candidate that crossed the database boundary and
    recovered through the previous release's restore executable, a SIGKILL at the database
    boundary recovered on the next update, Claude composition, uninstall, and reinstall with
    history preserved. The rehearsal caught two product defects that were fixed: the
    manager's runtime downloader omitted the `vX.Y.Z` dist path, and a crash-looping
    candidate left systemd's start rate limit set, so activation now clears failed unit
    state first. PR [#38](https://github.com/baktiaditya/ai-usage-dashboard/issues/38)'s
    checks are the live record.
  - **Review follow-up:** a fourth review of the resumed-install adoption found that a retry
    resolving a different data directory could adopt a database the interrupted run never
    created. The journal now persists the canonical database path at `db-creating`, adoption
    requires a physical-path match, and the integrity and holder checks gate adopted
    databases too; the bootstrap uninstall fallback now removes the release/runtime/cache
    trees when ownership is demonstrable and leaves unproven trees alone.
  - **Not performed:** reboot persistence (no reboot is exercised, so no boot claim is
    made), and installation through the published one-line command, which waits on the
    first tagged release. Browser evidence was captured locally with `agent-browser` against
    a disposable managed dashboard built by the installer with the service manager
    substituted, not against the CI systemd dashboard; the CI rehearsal proves that
    dashboard's units, HTTP health, and timer instead. Spec-table scenarios not exercised by
    tests are recorded here rather than claimed: glibc < 2.28/musl preflight refusal, a
    release whose runtime manifest pins a different Node major, a real Codex CLI discovered
    on PATH (tests stub `codex`), collector-stuck, backup-refusal, and state-write failure
    paths, and SIGKILL at journal boundaries other than the database and uninstall bounds.
  - **Archived:** with the CI rehearsal passing, the brief moves to
    [archive](backlog/archive/simplify-linux-installation.md) and the plan's section 4.1.1
    records the delivered state. Release publication remains the user's subsequent call.
  - **Review fixes:** an independent review of PR
    [#38](https://github.com/baktiaditya/ai-usage-dashboard/issues/38) against `e6e8b82` at
    head `2941dc6` confirmed ten issues, and the working tree now fixes all of them with
    regression coverage. Data safety first: install and uninstall compare the data directory
    and database _physically_, so a path named outside the root that symlinks inside it is
    refused instead of deleted; update refuses to touch units a manual installation has
    replaced; recovery restores the journaled database through the recorded `state.config`
    rather than the caller's `AUD_DATA_DIR`; a crash between stopping the writers and
    journaling that phase restores the snapshotted service state; and recovery rewrites an
    already-refreshed Claude status line back to the release `state.json` records. Contract
    fixes: `--dry-run` no longer runs recovery or performs network resolution (install
    included, and it no longer creates the root); an update whose recorded tag resolves to a
    different commit is refused as a moved tag; the bootstrap takes the lifecycle lock before
    provisioning, fetching, or chmod; and the bootstrap fallback honours the launcher's
    `AUD_INSTALL_ROOT` and removes this root's collector timer through its service's
    ownership.
  - **Second review pass:** a re-review of `61b9e70` verified both first-pass P1s fixed and
    reported four more P2s, now fixed in the working tree: the bootstrap validates the root
    before creating directories or chmodding (an unowned root is rejected untouched), and
    its `--dry-run` guard precedes release resolution, so a preview needs no network; the
    fallback uninstall reads only active unit directives, so a commented
    `WorkingDirectory=` no longer marks a manual unit owned; and bridge refresh, recovery,
    and uninstall write at the recorded `state.bridge.settingsPath` rather than the
    caller's `CLAUDE_CONFIG_DIR`.
  - **Third review pass:** a review of `2422b67` confirmed the earlier P1s fixed and raised
    contract, durability, and documentation findings, fixed in the working tree: an
    interrupted first install adopts the database its own `db-creating` journal was creating
    instead of refusing it as unowned, and keeps the original journal identity; the
    pre-cutover backup runs the _previous_ release's backup executable; uninstall removes
    `state.json` before the heavy release/runtime trees so an interruption leaves the
    executable remnant path; `status` counts a stopped timer as degraded and exits `2` on
    corrupt state; a failed `stopWriters` restores the service snapshot before surfacing;
    the bootstrap validates the root with the same atomic-temp tolerance as `classifyRoot`;
    preflight checks `systemctl --user` access and repository reachability; the manager
    refuses mutating commands as root; metadata writes fsync the parent directory; and the
    install summary reports unit state and a PATH hint. The duplicated error-message
    formatter is now one shared `errorText`, and the backup stamp is single-sourced in
    `src/lib/timestamps.ts`. The remaining judgment-call refactor is splitting `manager.ts`
    and untangling its `(releaseDir, runtime)` data clump.
  - **Consequences:** mocks prove decision and ordering logic only; the real-systemd,
    timer, and recovery evidence now comes from the CI rehearsal above, while reboot
    persistence and installation through the published one-line command remain unclaimed.
    The plan's §4.1.1 status records implemented-in-code/release-pending without claiming a
    release or deployment.

- **Decision**: simplify end-user Linux installation through a managed, per-user
  source installer and lifecycle launcher. [Plan §4.1.1](plan/ai-usage-dashboard-implementation-plan.md#411-managed-linux-installation)
  records the approved scope: private checksum-verified Node/Corepack, pinned pnpm,
  stable release commits, existing hardened user systemd units, explicit linger,
  unchanged provider/credential onboarding, staged updates with quiescent backup
  and database-aware recovery, and data-preserving uninstall. The initial managed
  bootstrap targets Linux x86_64/glibc; existing manual installations remain supported.
  Automatic adoption of maintainer/manual installations and release publication are
  outside implementation authorization.
- **Creation**: [simplify-linux-installation](backlog/archive/simplify-linux-installation.md)
  is ready for agent with resolved design choices, command/path/ownership contracts,
  implementation sequence, crash recovery, verified existing owners, acceptance
  criteria, and disposable-systemd/browser proof requirements. Assessment baseline:
  `d7a6543`. Tracked in [#37](https://github.com/baktiaditya/ai-usage-dashboard/issues/37).
  Validation added a glibc 2.28 preflight, the `better-sqlite3` prebuilt/toolchain
  fallback, prompt-free Corepack and child stdin, a release/runtime retention rule,
  and rehearsal isolation through a dedicated account or VM rather than a substitute
  `HOME`. Review added a data ownership record that survives uninstall, so reinstall
  from the same root reuses the retained database after a newer-schema check and a
  verified backup instead of refusing it as unowned. This change adds documentation only; installer implementation, runtime
  rehearsal, tagging, publication, and deployment have not occurred.

- **Update**: the [README](../README.md) Quick start becomes an Installation section. It now
  covers:
  - platform scope: Linux supported, macOS untested with no scheduler yet (#29), Windows
    unsupported;
  - requirements;
  - clone and toolchain (`nvm install` reads `.nvmrc`), then install, collect, build, and start;
  - per-provider connection steps;
  - the systemd timer and web unit (`scripts/install-systemd.sh --install --enable --with-web`
    and linger);
  - updating, uninstalling, and development.

  It keeps linking volatile details (Node range, port defaults, interval) to `package.json`,
  `.nvmrc`, and Setup, as the earlier drift entry decided. A fresh HTTPS clone, run in an
  isolated data directory on an alternate port, confirmed the install, migrate, collect, build,
  and start steps. That run also found that the earlier wording "providers you have not set up
  render as `unavailable`" does not hold for Codex. Without `codex` on `PATH`, the adapter fails
  with `process_failed`: the card shows an error and `pnpm run collect` exits `1`, while Claude
  (`no_event_yet`) and the key-based providers (`not_configured`) read `unavailable`. The README
  now says so. Product behavior is unchanged.

- **Update**: the collector timer's catch-up is attributed to the mechanism that provides it,
  for [#34](https://github.com/baktiaditya/ai-usage-dashboard/issues/34).
  - [Setup](operations/setup.md) §5 said `Persistent=true` catches up a missed run after a reboot,
    and plan §5 named `Persistent=true` as the catch-up mechanism. Neither holds for this timer:
    `systemd.timer(5)` limits `Persistent=` to `OnCalendar=` timers, and the collector timer is
    purely monotonic (`OnBootSec=2min`, `OnUnitActiveSec=`).
  - The catch-up after a reboot comes from `OnBootSec=`. Per the same manual, an `OnBootSec=`
    already in the past at activation elapses immediately. Setup §5 now says so, and adds that
    the monotonic clock generally pauses during suspend, so a resume makes no catch-up run.
  - Plan §5 now names `OnBootSec=` for a monotonic timer.
  - The timer template's comments are corrected. `Persistent=true` stays as a documented no-op,
    so the timer's behavior is unchanged and installed units need no re-render.
  - The re-rendered units pass `systemd-analyze --user verify`.

- **Update**: [support-database-restore-on-macos](backlog/archive/support-database-restore-on-macos.md)
  is implemented on branch `feat/macos-restore-guard` for
  [#28](https://github.com/baktiaditya/ai-usage-dashboard/issues/28), and the brief moves to
  `archive/`.
  - When `/proc` cannot be read, `processesHolding()` in `src/lib/db/backup.ts` asks
    `lsof -w -t`. PIDs on stdout count as holders whether `lsof` exits 0 or 1, and exit 1 with no
    output means none. Any other outcome refuses with
    `cannot tell whether the database is in use`.
  - The Linux `/proc` scan is unchanged. The refusal names the systemd units only on Linux.
  - Both Husky hooks put `/opt/homebrew/bin` in their fallback `PATH`.
  - The README platform note names only the scheduler, and Setup §1 says how the in-use check
    works off Linux.
  - One deviation from the brief: the runner uses `spawnSync`, not `execFileSync`. Exit status,
    stdout and stderr then arrive without exception handling, and the decision table is unchanged.
  - `pnpm run verify` (38 files, 661 tests) and the OKF validator pass. The real-`lsof` case runs
    on Linux against `lsof` 4.95.0.
  - Unperformed: no run on real macOS. `pnpm run db:restore` refusing and succeeding on a Mac stays
    unproven until someone runs it there.

- **Proposed**: macOS support, split into two briefs after an assessment at `c7b6c05`. That
  assessment found the application portable apart from the two couplings the README names.
  [support-database-restore-on-macos](backlog/archive/support-database-restore-on-macos.md)
  goes straight to `ready-for-agent/`. It adds an `lsof` fallback, failing closed, when the restore
  guard cannot read `/proc`, and puts `/opt/homebrew/bin` in the Husky fallback `PATH`. It changes
  no canonical contract, and it can be proven on Linux; a run on real macOS stays unperformed.
  [schedule-collection-with-launchd-on-macos](backlog/ready-for-human/schedule-collection-with-launchd-on-macos.md)
  waits in `ready-for-human/`. Plan §3.3 and §5 fix the scheduler as user systemd, so adding
  LaunchAgents is a scope decision for the user. The brief also needs the user's acceptance of
  unsandboxed agents, a decision on who verifies on a real Mac, and a decision on a macOS CI job.
  The briefs are tracked by [#28](https://github.com/baktiaditya/ai-usage-dashboard/issues/28)
  (`ready-for-agent`) and [#29](https://github.com/baktiaditya/ai-usage-dashboard/issues/29)
  (`ready-for-human`).

- **Update**: the [README](../README.md) keeps the product overview and quick start while
  linking changing details to their owning sources: Node and pnpm requirements to
  `package.json` and `.nvmrc`, commands to package scripts and Setup, and dated provider
  verification to Discovery. The architecture diagram describes the shared collection flow
  without enumerating adapters, the screenshot is labelled as illustrative demo data, and
  repeated provider counts, CLI versions, endpoint details, port defaults, and historical
  credential setup are removed from the entry point. Product behavior and scope are unchanged.

- **Update**: [prepare-open-source-release](backlog/archive/prepare-open-source-release.md) is
  implemented on branch `feat/open-source-release-prep` and moves to `archive/`. The repository
  gains an MIT [LICENSE](../LICENSE) with
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the Lobe Icons marks,
  `license`/`repository`/`bugs`/`homepage` package metadata, a `.nvmrc` naming Node 24, a
  [CHANGELOG](../CHANGELOG.md), [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md),
  GitHub issue templates, and CI that runs `pnpm run verify` on Node 24 from `.nvmrc`. With
  `AUD_TIMEZONE` unset or blank, `loadConfig` now follows the system timezone as Node resolves it,
  falling back to `UTC` when none resolves or the resolved zone is invalid; an explicit invalid
  zone still throws `ConfigError`. Setup §7, `.env.example`, and plan §3.2 describe that default.
  The production deploy and rollback runbook moves from Setup §6 to
  [production-checkout](operations/production-checkout.md) with an HTTPS clone URL; Setup §3, §4,
  §5, §6 and §10 point there, the implementation prompt carries a historical-record note, and the
  Setup §4 upgrade steps note that only installs predating the Settings dialog need them. The
  Claude usage spike script, its unit test, its package script, and its README row are removed;
  dated entries and archived briefs keep their mentions. The Husky hooks no longer assume nvm and
  fail with a clear message when `node` or corepack's `pnpm` is not on `PATH`. Maintainer home
  paths in the two 2026-09-14 entries and in the archived
  [separate-production-checkout](backlog/archive/separate-production-checkout.md) and
  [store-provider-keys-in-settings](backlog/archive/store-provider-keys-in-settings.md) briefs are
  redacted to `~/Workspace/ai-usage-dashboard-prod`; this is a redaction, not a decision change.
  `pnpm run verify`, `pnpm run test:e2e`, the OKF validator, and a fresh-clone
  install/migrate/collect/build/start pass. The README screenshot is captured from
  `pnpm run seed:demo` data in an isolated data directory. Nothing is committed, pushed, tagged,
  or made public in this session; `v0.1.0` is tagged after the change is merged.

## 2026-10-02

- **Update**: [prepare-open-source-release](backlog/archive/prepare-open-source-release.md)
  is tracked by [#25](https://github.com/baktiaditya/ai-usage-dashboard/issues/25), labelled
  `ready-for-agent`, and the brief links back to it. The fixture fix in the entry below landed as
  [#24](https://github.com/baktiaditya/ai-usage-dashboard/pull/24) (`59eb129`): the OpenCode Go
  collector cases pin `Date` before the earliest fixture reset, and `pnpm run verify` passes on
  `main` again, so the brief's green-`verify` gate is met.
- **Decision**: the open-source release removes `scripts/spike-claude-oauth-usage.ts`, its unit
  test, the `spike:claude-usage` package script, and its README row. The user chose removal over
  keeping it as a maintainer-only script. By default it reads the full-login token in
  `~/.claude/.credentials.json`, which plan §2 forbids for the product, and the quota probe that
  shipped in #16 does not use it. Dated entries, M0 Discovery, and archived briefs that cite it keep
  their wording. Recorded in
  [prepare-open-source-release](backlog/archive/prepare-open-source-release.md).
- **Update**: [prepare-open-source-release](backlog/archive/prepare-open-source-release.md)
  is re-checked against `main` at `69def69`, after pnpm (#11), the Claude quota probe (#16), and
  OpenCode Go (#20) landed. The brief now:
  - counts four saved secrets for `SECURITY.md`, including the OpenCode key and the optional Claude
    token, and the probe's subscription usage;
  - names OpenCode Go's undocumented usage endpoint and the probe's unified rate-limit headers in
    the interface-stability caveat;
  - drops the Node work already done by the pnpm migration, leaving only `.nvmrc`;
  - points the add-a-provider guide at the OpenCode Go delivery and its history-preserving
    migration `0004`;
  - names the Setup references to repoint and the `v0.1.0` tag;
  - requires `pnpm run verify` to pass on `main` before starting. On this date it fails two
    OpenCode Go collector cases, because their fixtures carry fixed reset times that are now in
    the past; that fix lands on `main` separately.

## 2026-09-30

- **Update**: [PR #20](https://github.com/baktiaditya/ai-usage-dashboard/pull/20) is merged as
  `ad85dcf` and deployed to the production checkout from `2614f5a`, after a `db:backup` of the live
  database. The Setup §6 deploy and verify blocks from `origin/main` passed with no rollback:
  `verify` passed (38 files, 647 tests), migration `0004` applied with no foreign key violation and
  `integrity_check` returning `ok`, and all collector runs and the saved Claude, DeepSeek and
  OpenRouter keys were kept. The first collector run after the deploy succeeded for every configured
  provider and reported OpenCode Go as `not_configured`. With the key then saved in production
  Settings, **Refresh** on the card recorded `success` and the card drew its three windows and the
  **Today** chart.
  [The OpenCode Go brief](backlog/archive/add-opencode-go-quota.md) moves to `archive/`.
- **Design**: the OpenCode Go card spans the full grid width. It shows the windows on the left
  and a **Today** chart on the right: each window's utilisation at the end of every local hour,
  drawn from the collector's own snapshots. The user asked for a layout like the OpenCode
  console's overview. Most of that page (cost, requests, tokens, per-model usage, request log,
  credits) is only in the console, behind a browser session. The API key reads no more than the
  three percentages, upstream has no usage-history endpoint (anomalyco/opencode#43983), and
  scraping or reading `opencode.db` stays out of scope under plan §3.1. The hourly chart is the
  one widget our own data supports. It takes the history chart's series slots, keeps the latest
  reading of each hour, and never sums a gauge. The overview carries it only for OpenCode Go, so
  no other card and no extra request pays for it. `labelWindow` moved to
  `src/lib/queries/labels.ts`, so the overview can import the history query without a cycle.
  Hours are keyed by the UTC instant each local hour starts, not by the hour number, because
  review found a DST fall-back merging the two occurrences of `01:00` into one point. An hour
  also ends at any offset change inside it, since a second review found Lord Howe's
  thirty-minute fall-back still starting the repeated half hour before the change.
- **Update**: the OpenCode Go live check passed with a key saved in dev-server Settings. The
  collector (`pnpm run collect --manual --provider=opencode_go` against the dev data directory),
  **Refresh** on the card with `AUD_DEV_LIVE_REFRESH=1`, and the OpenCode Go case of
  `pnpm run test:live` each recorded `success`. The card rendered three healthy windows, and the
  weekly reset fell on Monday 00:00 UTC. No key or percentage is recorded here.
- **Discovery**: the card can read one point lower than the OpenCode console. On a
  side-by-side check, rolling and weekly were one point lower and monthly matched. Our side
  caches nothing: requests use `cache: 'no-store'`, and a reading taken after the console
  screenshot still matched the earlier ones. The cause is upstream rounding, read from
  anomalyco/opencode `dev`:
  - `/zen/go/v1/usage` rounds down: `Math.floor` in
    `packages/console/core/src/subscription.ts`.
  - The console rounds to the nearest value: `getUsagePercent` uses `Math.round` in
    `packages/console/app/src/lib/lite-usage.ts`.

  The dashboard keeps the source value unchanged, as plan §3.1 requires.
  [Setup](operations/setup.md) §4 explains the difference.

- **Update**: [add-opencode-go-quota](backlog/archive/add-opencode-go-quota.md) is
  implemented on branch `feat/opencode-go-quota`. It is not merged or deployed. The pieces:
  - the adapter, `src/lib/adapters/opencode-go.ts`;
  - migration `0004`;
  - the Settings field;
  - the card, logo, and demo seed;
  - [setup](operations/setup.md) §4.

  `pnpm run verify` (626 tests) and `pnpm run test:e2e` (66 tests) pass. The live check with a
  key saved in Settings is still to be run by the user. Two deviations from the brief:
  - **Credential order.** `CREDENTIAL_PROVIDERS` lists OpenCode Go before Claude, so the optional
    Claude token stays the last field in Settings.
  - **Deploy backup.** The deploy procedure in setup §6 does not take a backup. Before deploying
    this build, run `pnpm run db:backup` in the production checkout by hand, because `0004` is
    the first migration that rebuilds tables holding history.

- **Discovery**: `getJsonLossless` hands every JSON number to an adapter as its source text,
  `{ __rawNumber: "41" }`, not as a number. A schema that expects `z.number()` for OpenCode Go's
  `percent` would therefore reject every live response as `schema_mismatch`, while fixture tests
  that use plain `JSON.parse` still pass. The adapter accepts both forms, and its tests drive the
  real HTTP path. A scratch run of the `0004` SQL with `foreign_keys = ON` confirmed the history
  risk: every `provider_snapshots` and `quota_windows` row was deleted. The runner change is
  load-bearing.

- **Decision**: OpenCode Go is added as a fifth provider, a quota provider like Codex and Claude,
  at the user's request. [Plan](plan/ai-usage-dashboard-implementation-plan.md) §3.1 gains an
  OpenCode Go contract, and §1, §3.5, §5 and §7 now count five providers and name its key.
  - **Source.** `GET https://opencode.ai/zen/go/v1/usage` with the user's OpenCode API key,
    saved in Settings. OpenCode's `auth.json` and local database are never read, and the console
    is never scraped.
  - **What it shows.** The response carries only used percentages and reset times for the
    `rolling`, `weekly`, and `monthly` windows. The card never shows dollars, the plan tier, or a
    Zen balance.
  - **`usageAllowed` stays `null`.** A `rate-limited` window becomes a limit-reached code and
    never sets `usageAllowed` to false, because the console's "Use balance" option can keep
    requests flowing and the response does not say whether it is on.
  - **Migration `0004` must not lose history.** It widens the `provider` CHECK on
    `collector_attempts` and `provider_snapshots`, and both are parents of `ON DELETE CASCADE`
    keys. So the migration runner switches to SQLite's documented rebuild with foreign keys off
    and a `foreign_key_check` before commit, rather than dropping the tables with enforcement on,
    which would delete history.
- **Discovery**: the OpenCode Go gate passed live. The user's key got a `200` with the shape now
  recorded in [M0 discovery](discovery/m0-discovery.md), and requests with no key or a bogus key
  got `401` JSON. The endpoint is upstream PR anomalyco/opencode#16513 and is not yet in OpenCode's
  public docs. Evidence is shape-only; no key or percentage is recorded.
- **Proposed**: [add-opencode-go-quota](backlog/archive/add-opencode-go-quota.md) files
  the implementation directly in `ready-for-agent/`, tracked by
  [#21](https://github.com/baktiaditya/ai-usage-dashboard/issues/21). The scope decision and live
  gate above close every dependency, so no user decision is outstanding.
- **Restructure**: the Claude Code skill entrypoints under `.claude/skills/` are now relative
  symlinks into `.agents/skills/`, so each skill has one `SKILL.md` source of truth. The
  "update both SKILL.md files" rule in
  [`okf-sync`](../.agents/skills/okf-sync/SKILL.md) no longer applies.

## 2026-09-17

- **Decision**: [issue #15](https://github.com/baktiaditya/ai-usage-dashboard/issues/15)
  resolves the status divergence recorded in the Risk entry below. An unrecognised format or
  version guard (`schema_mismatch` or `version_unsupported`) is an `error` attempt for every
  provider: the source should be available, but its response cannot be trusted. `unavailable`
  remains for sources that are not configured, not entitled, or have no event yet. The
  [plan](plan/ai-usage-dashboard-implementation-plan.md) §4.5, the §9 format-change mitigation, and
  the Claude spool comment now match the existing collector mapping; no runtime status mapping changes. Tests pin both codes across
  all four providers. This supersedes the 2026-09-17 Risk entry about the divergence.
- **Update**: [PR #16](https://github.com/baktiaditya/ai-usage-dashboard/pull/16) is merged as
  `b46205e` and deployed to the production checkout from `820d873`, after a `db:backup` of the live
  database. The Setup §6 deploy and verify blocks from `origin/main` passed with no rollback:
  `verify` passed (36 files, 589 tests), migration `0003` applied and kept the saved DeepSeek and
  OpenRouter keys, and the next collector run recorded a successful attempt for every provider. The
  Claude token is saved in production Settings. While a Claude Code session was reporting, Claude
  readings still came from the status line and no probe was claimed, as designed; the first idle
  probe, and whether it opens a five-hour window, is still to be observed.
  [The poll brief](backlog/archive/poll-claude-quota-without-a-session.md) moves to `archive/`.
- **Update**: plan §2's read-only principle now names the Claude quota probe as its one
  exception. The probe's `POST /v1/messages` is real inference that spends subscription usage, so
  "only performs read operations" was no longer true. Found in PR #16 review.
- **Discovery**: a `claude setup-token` token cannot read `GET /api/oauth/usage`. Saved from
  dashboard Settings on 2026-09-17, it got `403`. Public reports (anthropics/claude-code#11985,
  #22450, #24200) show why: such a token is scoped to `user:inference` only, and the endpoint
  requires `user:profile`. The 2026-09-16 gate's `200`s most likely came from the spike's fallback
  to the full-login token in `~/.claude/.credentials.json`, which carries that scope. The poll as
  built on PR #16 could never have answered with the token setup §3 told users to mint.
  [M0 discovery](discovery/m0-discovery.md) records the correction.
- **Decision**: the Claude pull source is now a quota probe, replacing the usage poll on PR #16.
  It sends `POST /v1/messages` to `claude-haiku-4-5` with one output token and no system prompt,
  discards the body unread, and reads the `anthropic-ratelimit-unified-5h-*` and `-7d-*`
  utilisation and reset headers. A live probe with a saved `setup-token` token returned `200` and
  those headers. Haiku accepts a subscription token without Claude Code's identity prompt, so the
  probe never impersonates Claude Code. Reading a full-login token out of
  `~/.claude/.credentials.json` was rejected: it breaks the plan's extraction rule, and refreshing
  it would race Claude Code's own refresh-token rotation. The probe is real inference and spends a
  few tokens of subscription usage, which the user accepted. So it runs only when the spool has no
  reading within the probe's freshness budget; an active session never pays for one. The
  five-minute floor, durable claim, deferral rule, and fallback semantics are unchanged. Plan §3.1,
  §3.3, §4.4 and §7 and setup §3 are rewritten for it.
- **Superseded**: the two earlier 2026-09-17 decisions below, to refuse unlabelled `limits[].kind`
  values and to keep status-line and polled Claude windows as separate history series. The probe
  produces the status line's own `five_hour` and `seven_day` windows from the headers that feed the
  status line, so `session` and `weekly_all` labels are gone and a Claude window is one series again,
  whichever source observed it. The history legend still shows window labels instead of raw
  identifiers.
- **Update**: [the poll brief](backlog/archive/poll-claude-quota-without-a-session.md)
  is implemented on branch `feat/poll-claude-quota-without-a-session`, tracked by
  [#13](https://github.com/baktiaditya/ai-usage-dashboard/issues/13). Migration `0003` rebuilds
  `provider_credentials` with `claude` in its `CHECK` and creates the `claude_poll_state` singleton
  that plan §4.4 now describes as implemented. `src/lib/adapters/claude-usage.ts` holds the poll and
  the single composite Claude adapter. Freshness now keys the Claude budget on the snapshot's
  `sourceVersion`, and [setup](operations/setup.md) §3 documents enabling the poll and the whole
  token lifecycle.
- **Decision**: a `limits[].kind` without a label is refused in the adapter, not rendered. The
  brief left the choice open between labelling and refusing. Refusing there keeps an undocumented
  internal name out of the database, the history legend, and the advisory subject, not only the
  card. A payload whose active limits all carry unknown kinds is `schema_mismatch`, because
  `not_entitled` would misstate an account that does have limits. The two kinds seen live, `session`
  and `weekly_all`, read as window names and are labelled `Session` and `Weekly, all models`.
- **Discovery**: one re-probe with `--show-limit-kinds` returned 13 unrecognised top-level keys
  instead of the 12 recorded on 2026-09-16, one still carrying a value. The drift signal fired on a
  field the adapter does not read. Recorded as a count in
  [M0 discovery](discovery/m0-discovery.md); the names stay withheld.
- **Decision**: a run that loses the poll claim and has no usable spool records no Claude attempt.
  The first implementation let it record the spool's `no_event_yet`, so with a token saved and no
  bridge, a **Refresh** inside the five-minute interval — or a scheduled run landing just under it
  from start-up jitter — turned a fresh polled reading `unavailable`. Pre-merge review of PR #16
  ruled that out, because it defeats the point of polling. Any row that run could write would be a
  verdict about a poll it never made, and since the loser starts later it would also mask the
  claimant's result, including a request still in flight. The adapter now throws
  `CollectionDeferred`, the collector records nothing and reports the provider as `deferred`, and
  the card keeps the claimant's reading, aged by the polled budget, or its error. It reads
  `unavailable` only when no poll result exists. This amends plan §3.3 and is the one exception to
  "one run, one attempt per provider"; the brief's criterion that `getLatestAttempts` sees one
  Claude row per run holds for every run that polled or read a usable spool.
- **Decision**: history keeps status-line and polled Claude windows as separate series, labelled
  `(status line)` and `(usage poll)`, and no longer prints raw bucket and window identifiers in the
  legend. `session` is not mapped onto `five_hour`: the names look equivalent, but nothing has
  verified that they measure the same window, and one merged line could mislead. Runs that
  alternate sources leave gaps in both lines, which [setup](operations/setup.md) §3 records as a
  limitation. Merging the series waits on evidence that the metrics are equal.
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
  found that [the poll brief](backlog/archive/poll-claude-quota-without-a-session.md)
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
- **Design**: [the poll brief](backlog/archive/poll-claude-quota-without-a-session.md)
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
- **Update**: [poll-claude-quota-without-a-session](backlog/archive/poll-claude-quota-without-a-session.md)
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
- **Proposed**: [poll-claude-quota-without-a-session](backlog/archive/poll-claude-quota-without-a-session.md)
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

- **Decision**: the open-source release adopts pnpm.
  [prepare-open-source-release](backlog/archive/prepare-open-source-release.md) now depends
  on the [npm to pnpm migration](backlog/archive/migrate-from-npm-to-pnpm.md), which
  lands first. The user ordered the migration before the release so that the first public README,
  contributing guide, and CI already use pnpm. CI runs `pnpm run verify` only, installing with
  `pnpm install --frozen-lockfile` through corepack; this supersedes "CI runs `npm run verify`" in
  the entry below. The brief's Testing and Acceptance Criteria name pnpm commands, and the portable
  hook `PATH` must still find corepack's `pnpm` shim. The readiness evidence, gathered with npm,
  stays as recorded. The migration narrows `engines.node` to `^24.15.0`, so the brief no longer
  tests Node 22.12: it adds `.nvmrc` for Node 24, CI runs on Node 24 only, and widening to Node 22
  or 26 is a later decision once CI exists.

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

- **Decision**: the open-source release gates are closed, and
  [prepare-open-source-release](backlog/archive/prepare-open-source-release.md) moves to
  `ready-for-agent/`. The user chose each term. The license is MIT. The timezone default follows the
  system timezone as Node resolves it, falling back to `UTC` when none resolves; an explicit
  `AUD_TIMEZONE` still wins, and an invalid one is still rejected.
  [Plan](plan/ai-usage-dashboard-implementation-plan.md) §3.2 now states that default;
  `src/lib/config.ts`, Setup §7, and `.env.example` change on delivery, and until then
  `Asia/Jakarta` is what runs. This machine resolves `Asia/Jakarta` and production sets no
  `AUD_TIMEZONE`, so production's day boundary does not move. Maintainer-only content: `docs/log.md`,
  the implementation prompt, the Tailscale brief, `AGENTS.md`, `.mcp.json`, `.claude/`, and
  `.agents/` stay, the prompt gains a historical-record note, and `CONTRIBUTING.md` marks the agent
  tooling optional. The production-checkout deploy and rollback runbook moves out of Setup §6 into
  its own maintainer operations document. The Setup §4 steps for upgrading from keys in
  `collector.env` stay, with a note that only an install predating the Settings dialog needs them.
  Commits keep the current author email, and history is not rewritten. CI runs `npm run verify`
  only; `npm run test:e2e` stays local. Changing the repository's visibility remains the user's
  step after delivery.

- **Proposed**: prepare the repository for an open-source release, in
  [prepare-open-source-release](backlog/archive/prepare-open-source-release.md). A readiness
  assessment at `e1d6923`, re-run against `e2d553c` after provider keys moved into the database,
  found the code ready: `npm run verify` passes, `npm audit` is clean, a fresh clone installs,
  collects, and builds, and the git history holds no real key. The re-run added the second
  archived brief carrying a maintainer path and the plaintext key storage to the brief. The gaps are
  packaging: no license, maintainer paths in tracked docs, an unstated platform scope and provider
  affiliation, maintainer-only agent tooling, and no CI or contributor policy. Publishing the source
  leaves the plan's "Public or multi-user access" non-goal intact. The brief waits on the user: the
  license, whether to keep the `Asia/Jakarta` timezone default, what to do with maintainer-only
  content, and the commit author email. Nothing is executed yet.

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
  `~/Workspace/ai-usage-dashboard-prod`, detached at `f6fcb03` from `origin/main`. The
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
  `~/Workspace/ai-usage-dashboard-prod`; no development or hotfix commit originates there.
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
