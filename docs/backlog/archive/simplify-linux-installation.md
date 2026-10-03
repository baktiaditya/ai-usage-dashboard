# Simplify Linux installation and lifecycle management

## Status

Archived

Delivered on branch `feat/managed-linux-installer` (PR
[#38](https://github.com/baktiaditya/ai-usage-dashboard/pull/38)); the
[log](../../log.md) records the evidence, including the disposable-systemd rehearsal that now
passes in CI (49 checks: real units, timer run, failed-update database recovery, SIGKILL at
the database boundary with recovery, uninstall, and reinstall). Release publication and
reboot-persistence checks remain future work and are not claimed. The rest of this file is
the approved brief as written. The
[plan](../../plan/ai-usage-dashboard-implementation-plan.md),
[Setup](../../operations/setup.md), [Discovery](../../discovery/m0-discovery.md),
and [log](../../log.md) remain canonical. The 2026-10-03 installation decision
authorizes the scope below. Existing manual installations remain supported.

Related issue: [#37](https://github.com/baktiaditya/ai-usage-dashboard/issues/37).

## Objective

A Linux user can install the dashboard with one terminal command, obtain a working
loopback dashboard and scheduled collection, then connect providers in the existing
UI. The user can update, inspect, and uninstall the managed installation without
learning the repository's build commands. Existing history, credentials, CLI
authentication, and unrelated shell or service configuration are preserved.

## Context

Assessed against `main` at `d7a6543` on 2026-10-03. Recheck these owners at the
implementation head; this SHA identifies the assessment, not a deployment target.

| Existing owner                                                                             | Relevant behavior                                                                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `README.md`, Setup                                                                         | Users manually clone, prepare Node/Corepack, install, migrate, collect, build, start, and install systemd units. |
| `package.json`, `.nvmrc`, `pnpm-workspace.yaml`                                            | Node release line/range, hashed pnpm pin, package scripts, and exact native-build approvals.                     |
| `scripts/install-systemd.sh`, `scripts/render-systemd-units.ts`, `src/lib/systemd-unit.ts` | Render/install hardened user units with resolved configuration and absolute runtime paths.                       |
| `scripts/next.ts`, `src/lib/config.ts`, `src/lib/env-file.ts`                              | Validate loopback binding and resolve application settings.                                                      |
| `scripts/collect.ts`                                                                       | Exit `0`: success/unavailable; `1`: provider errors with partial results saved; `2`: run cannot start.           |
| `scripts/db-backup.ts`, `scripts/db-restore.ts`, `src/lib/db/backup.ts`                    | Verified SQLite backup and guarded restore; backups contain the locally saved credentials.                       |
| `src/lib/db/client.ts`                                                                     | Opening a writable database normally applies migrations automatically.                                           |
| `scripts/install-claude-statusline.ts`                                                     | Preview/apply/wrap/remove a bridge, preserve settings, and record absolute runtime and checkout paths.           |
| `.github/workflows/ci.yml`                                                                 | Repository verification exists; it does not currently prove the proposed managed lifecycle.                      |

The [nvm installer](https://github.com/nvm-sh/nvm#install--update-script) and
[Oh My Zsh installer](https://ohmyz.sh/#install) demonstrate a downloadable script
as the entry point. Adopt that entry experience and per-user installation, with
the dashboard's own runtime, storage, and lifecycle requirements.

## Dependencies and Gates

- **Decisions resolved:** Linux-first, build from source, isolated managed runtime,
  user systemd, existing provider onboarding, data-preserving uninstall. See plan
  §4.1.1 and the 2026-10-03 log entry.
- **Executable within this work:** select and checksum an exact supported Node
  release, implement lifecycle ownership/state, and add an isolated systemd
  rehearsal. No provider credentials are necessary for implementation proof.
- **Distribution boundary:** implementation can finish against fixture release
  tags and a candidate checkout. Publishing the first installable release and its
  public command follows the repository's normal release process after merge.
  This brief authorizes code and documentation, not tagging, pushing, publishing,
  or modifying the maintainer's running installation.
- **No external decision blocks implementation.** Native hardware/platform claims
  are limited to the environments actually verified below.

## Scope

### In scope

- A downloadable Bash bootstrap, `scripts/install.sh`.
- A managed installation with a private Node/Corepack runtime, release checkouts,
  persistent ownership metadata, and a launcher named `ai-usage-dashboard`.
- `update`, `status`, `uninstall`, and `claude-statusline` launcher commands.
- Installation/update failure recovery, locking, repeated invocation, and
  interrupted-operation recovery.
- Reuse and narrowly extend existing systemd/configuration/backup/status-line
  modules. Keep the current hardening and provider contracts.
- Fresh-machine and lifecycle tests, README/Setup/runbook guidance, and CI proof.

### Out of scope

- Prebuilt application bundles, Next.js standalone packaging, npm publication,
  Docker, an updater running in the background, or additional schedulers.
- macOS/Windows installers. The separate [macOS scheduler brief](../ready-for-human/schedule-collection-with-launchd-on-macos.md)
  keeps its existing gates.
- Automatic adoption of an existing manual or maintainer production checkout.
- Installing/signing in to provider CLIs, importing authentication files, entering
  API keys in the terminal, or enabling the Claude quota probe.
- Purging application data, backups, provider authentication, or Claude settings
  backups. No purge flag in this delivery.
- ARM/musl runtime bootstrapping in the first delivery. The managed installer
  initially targets Linux x86_64 with glibc; manual platform scope is unchanged.

## Approach

### 1. Establish the command and distribution contract

Deliver this interface; fail with usage before mutation on unsupported arguments:

```text
bash scripts/install.sh [--version vX.Y.Z] [--install-dir ABSOLUTE_PATH]
                       [--enable-linger] [--dry-run]
bash scripts/install.sh status [--install-dir ABSOLUTE_PATH]
bash scripts/install.sh uninstall [--install-dir ABSOLUTE_PATH] [--dry-run]
ai-usage-dashboard update [--version vX.Y.Z] [--dry-run]
ai-usage-dashboard status
ai-usage-dashboard uninstall [--dry-run]
ai-usage-dashboard claude-statusline [existing status-line installer flags]
```

`--help` works on bootstrap and launcher without installation. No install prompt
or TTY is required; piped input must not be used for questions. Run every child
process with stdin redirected from `/dev/null`: in the `curl … | bash` form the
rest of the script is still on stdin, and a child that reads it consumes the
script. `--enable-linger`
is explicit because it changes logout/boot persistence. Without it, install and
start the user units, report linger state, and explain the existing
`loginctl enable-linger "$USER"` step when needed. A requested linger change that
the session cannot authorize returns a clear nonzero result with a runnable
remedy; it never launches an implicit `sudo` or waits for interactive input.

Bootstrap `status`/`uninstall` are recovery entry points when the launcher is
missing or already removed. They inspect the selected root; with no managed
installation, status reports absent and uninstall succeeds without provisioning
Node, creating metadata, or installing anything.

The public one-line command must fetch `scripts/install.sh` from a release tag,
then run it with that same explicit `--version`. Also document download/read/run
as an alternative. Show placeholders while preparing the feature; publish a real
copyable command only when its tag contains the implemented installer. No domain
purchase or custom hosting is required; GitHub raw URLs are sufficient.

For bootstrap without `--version`, fetch upstream refs and select the highest
stable `vMAJOR.MINOR.PATCH` tag whose commit is reachable from upstream `main`.
Exclude prereleases, malformed tags, and tags outside that history. If none is
eligible, fail before runtime/data/unit mutation and explain the missing release.
Explicit versions obey the same eligibility rules. Resolve once to an exact
commit SHA, fetch/check out that SHA detached, and record tag plus SHA. Use
numeric SemVer comparison, not lexical sorting. Never deploy a floating branch.
Validate that the tag agrees with `package.json.version` and that the checkout
contains the runtime manifest and lifecycle entry points before accepting it.

The bootstrap only preflights, resolves and fetches the release, provisions the
runtime, and hands off. Every lifecycle step runs from the selected checkout's
`scripts/manage-installation.ts`, so a bootstrap downloaded from one tag can
install another without its own copy deciding lifecycle behavior. Version the
bootstrap-to-manager interface; an unknown interface version fails before mutation.

Read-only source fetches may use an ephemeral directory. GitHub API credentials
and `gh` are not prerequisites. Accept the tag/HTTPS trust model; a remembered
tag resolving to a different SHA is an error, not an upgrade. User-facing output
identifies the version and commit. Do not claim tag signature verification unless
it is implemented and tested.

Completion: fixture refs prove stable selection, ancestry checks, exact detached
checkout, moved-tag refusal, and no-release handling.

### 2. Preflight and provision the private runtime

Check Linux x86_64, glibc 2.28 or later, Bash, Git, curl, tar/xz, SHA-256
tooling, `flock`, systemctl/user-session access, journalctl, and `ss`. The glibc
floor is that of Node 24's official linux-x64 binaries (Node `BUILDING.md`); check
it before downloading, for example with `getconf GNU_LIBC_VERSION`, so a musl or
older system fails without a wasted download.
Reject root execution and unsupported platforms before persistent mutation.
List missing tools with actionable guidance; leave OS package installation to the
user. Validate writable locations, configuration, unit ownership, launcher
ownership, and port availability before activating anything.

Use a small versioned manifest, `scripts/install-runtime.env`, containing the
exact Node version and the SHA-256 of its official Linux x64 archive. Treat it as
constrained key/value data, never `eval` or arbitrary shell code. Select the first
pin from the supported Node line in Discovery, verify it against `.nvmrc` and
`engines.node`, and obtain its checksum from Node's official distribution. Add CI
checks that manifest versions remain compatible when package requirements change.

Download that exact archive over HTTPS, check its committed checksum, then extract
into a private runtime directory. Check paths/archive entries and refuse extraction
outside staging. Execute the extracted Node and verify version, platform, and
Corepack availability before accepting it. A runtime already managed at that exact
version can be reused after validation. A failed download or checksum never leaves
a completed runtime marker.

Run the application with this private Node even when nvm/system Node exists.
Do not change shell profiles, nvm aliases/defaults, or system/global Node/pnpm.
Use Corepack from the private runtime with a private cache (`COREPACK_HOME`) and
locally available pnpm shim; verify the candidate's exact `packageManager` version
and integrity. Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`: an implicit Corepack call
otherwise asks for confirmation before downloading pnpm whenever stdin is a TTY,
which the download/read/run path has. Node 25 and later no longer distribute
Corepack. The manifest stays on the Node 24 line that `engines.node` requires; a
later move past Node 24 must replace this pnpm provisioning step, and manifest
validation fails rather than assuming the selected Node ships Corepack.

`pnpm install --frozen-lockfile` keeps the existing `allowBuilds` policy.
`better-sqlite3` installs through `prebuild-install || node-gyp rebuild --release`:
it downloads a prebuilt binary from the package's GitHub releases (12.4.1 publishes
`node-v137-linux-x64` for Node 24) and compiles only when that fails, which needs
Python 3, `make`, and a C++ compiler. Preflight checks HTTPS reach to nodejs.org,
the npm registry, and GitHub release downloads, and names the compiler toolchain
as needed only for the fallback. A failed native install reports both causes. Set
`HUSKY=0` for managed consumer checkouts; contributor setup is unchanged. Keep
build dependencies, including `tsx`; a production-only install cannot run the
current launcher/collector path.

Capture the caller's `codex` path before prepending the private runtime. Preserve
its directory alongside private Node in the generated service PATH so both
scheduled and manual collection can reach it. Keep `CODEX_HOME` resolution.
An absent Codex CLI is a setup hint, not an install failure. Prove compatibility
with the supported Codex installation in a rehearsal; keep untested third-party
CLI/runtime combinations explicit.

Completion: a fixture with no Node/Corepack/pnpm on PATH installs the runtime;
another with an incompatible system Node retains that Node and shell configuration
unchanged while the managed runtime and baked Codex PATH work.

### 3. Establish layout, ownership, and configuration

Default install root: `$XDG_DATA_HOME/ai-usage-dashboard-install` when the XDG base
is absolute, otherwise `~/.local/share/ai-usage-dashboard-install`. This is separate
from the existing application data directory. `--install-dir` selects an absolute
root, persisted for subsequent launcher commands. Initial consumer launcher:
`~/.local/bin/ai-usage-dashboard`; if this directory is absent from PATH, print
the full launcher path and a shell-neutral instruction. No profile edits.

```text
<install-root>/
  runtime/<node-version>/          private Node and Corepack
  releases/<commit-sha>/           detached source + dependency tree + build
  current                         symlink to the activated release
  state.json                      versioned, owner-only installation metadata
  operation.json                  owner-only durable recovery journal
  lifecycle.lock                  concurrent-operation lock
  data-ownership.json             owner-only record of databases this root created
  cache/                          private package-manager caches
```

Paths are illustrative planned output, not existing repository files. Protect
managed directories with `0700`, metadata with `0600`, and retain database/unit
modes from the existing owners. Runtime executable bits remain usable by the
owner. Validate canonical paths/symlinks and the renderer's current path limits.
Preserve existing AUD configuration precedence by resolving through `getConfig()`;
resolve XDG bases consistently with `src/lib/paths.ts`.

Metadata records schema version, installation identifier, install root, launcher,
tag/SHA, runtime, resolved data/env paths, bind address/port, interval, CODEX_HOME,
Codex directory, unit ownership, previous release, and managed bridge ownership.
Store no API keys, tokens, provider values, raw payloads, or complete environments.
Parse metadata as data with strict validation; shell wrappers do not source it.
Write metadata and the operation journal with temporary files and atomic rename.

Units point to the resolved physical release directory and absolute runtime,
not an unvalidated moving symlink. Changing `current` alone is insufficient:
activation renders/reinstalls units for that release. Persist effective installed
configuration and reapply it on update; a different caller shell must not silently
move the database or port. Document rerendering for deliberate configuration
changes through the existing systemd installer run from the managed checkout.

Refuse occupied roots/launcher paths or existing application units not owned by
this managed installation. Inspect installed unit contents, not filenames alone.
Never repoint a manual installation implicitly. Explain how to keep using the
manual path; migration/adoption can be a separate feature.

Use one exclusive `flock` across install/update/uninstall. Contention fails before
mutation. Recheck ownership before activation/removal. Status may read state without
the exclusive lock and must report an operation/recovery in progress coherently.
Keep the root and its lock sentinel across uninstall so reinstall cannot acquire
a different lock inode while removal is still running.

Database ownership has its own record, `<install-root>/data-ownership.json`
(owner-only, written atomically, parsed as strict data). Each entry names the
canonical data directory and database path, the installation identifier that
created the database, and the time it was created. The installation adds an entry
when it creates the database (§4 step 5); nothing else adds one. Uninstall keeps
this file with the lock sentinel, because the database it describes is kept too.
A root containing only the recognized sentinel and ownership record is an empty
managed root, not a foreign installation. The record proves only that this root's
managed installation created the database at that path. It never adopts a
database it did not create, and removing the install root forfeits the claim.

Completion: repeated install recognizes its own metadata and, after uninstall, its
own retained database; unrelated files, units,
configuration, data symlinks, and launcher collisions are preserved/refused.

### 4. Implement first installation as a staged activation

1. Acquire the lifecycle lock and complete preflight/version resolution.
2. Stage the source and runtime; cache/verify pinned pnpm and install dependencies.
3. Build with an isolated temporary `AUD_DATA_DIR` and absent temporary
   `AUD_ENV_FILE`, controlled AUD settings, and Next telemetry disabled. Build and
   tests must not open the user's actual database or invoke configured providers.
4. Resolve/validate the real configuration, render units, and record the operation
   journal before the first database or unit mutation. A nonexistent/empty target
   directory is eligible. A database at the resolved path is reused only when the
   ownership record names that canonical path; otherwise refuse adoption before
   opening it and name the remedies: choose another data directory, or move the
   existing one aside. For a reused database:
   - read its applied migration versions read-only, and refuse when any exceeds
     what the candidate knows. `openDb` does not refuse a newer schema itself, so
     an older release must never open it writable;
   - refuse while any process holds it, using the existing in-use check;
   - take and verify a backup with the candidate's backup path before its first
     writable open, and report the backup's location.
5. Initialize the real database, or open the reused one. Before creating a new
   database, record in the journal that this operation is creating it. Once it
   exists, add its ownership record entry. Preserve it on a later failure so
   retry/recovery never destroys user data.
6. Install units without `--enable`, start the web unit, and wait at most 60 seconds
   for HTTP success at the resolved loopback URL (including IPv6 URL brackets).
   Keep the timer stopped until step 7 completes. Preserve hardening.
7. Perform one installer-initiated collection through the existing collector. Exit `1`
   is installation success with provider setup/errors summarized; exit `2` is a
   failed activation needing recovery. Then enable/start the web unit and timer.
   Do not retry providers in a loop. The timer may subsequently fire immediately
   under its existing OnBootSec contract; it starts only after the initial run
   finishes, and that scheduled run is not an installer retry.
8. Apply linger only when requested. Write launcher/current/state atomically,
   clear the completed journal, and print the URL, resolved paths, running unit
   state, linger state, and provider connection instructions. No secret values.

Provider success is not the health criterion. Installation must work without
provider accounts. Keys are entered in Settings; Codex login stays with Codex;
Claude requires a subsequent explicit bridge command and session. Quota probing
remains a separate Settings opt-in.

First-install failure disables/stops/removes only newly created owned units and
retains database/configuration for recovery. Record partial state before every
externally visible step. An interrupted first install recognizes its own journal
and can resume from retained data; an ordinary pre-existing database with neither
that journal nor an ownership record entry is still refused. Never print
“installed” after failed health.

Completion: fresh isolated install yields HTTP success and an active timer with
provider credentials absent; injected failures leave a recognizable recoverable
state and no accidental success output.

### 5. Implement update and recovery around the database boundary

`update` defaults to the highest eligible stable release and accepts an explicit
eligible version. Reject intentional downgrades; automatic recovery to the
recorded previous release is the only backward transition in this delivery.
Updating to the active SHA is a no-op unless an unfinished journal needs recovery.

Use the following sequence, recording durable phase transitions:

1. Check current ownership, state, required runtime, effective config, and exact
   candidate SHA. Stage install/build and native-module smoke checks in isolation
   while the active release keeps serving. All downloads precede downtime.
2. Snapshot previous unit contents, enabled/active state, launcher/current metadata,
   and any managed Claude bridge configuration. Retain the previous source and
   runtime. Record the intended candidate and phase before stopping anything.
3. Stop the timer, wait for the collector to finish with a bounded deadline, then
   stop the web unit. Refuse cutover if any required process will not stop or any
   process still holds the database. Restore the previous service state when
   possible; never change the active tree while a process uses it.
4. With writes quiescent, create and verify a SQLite backup using the previous
   release's existing backup path. Record its exact location before candidate
   migration. A live backup made before stopping writers is not a cutover backup.
5. Mark the database as potentially changed before running candidate migration
   or startup. Apply migrations, install candidate units without enabling them,
   start/health-check candidate web, refresh an owned Claude bridge if present,
   then restore each unit's prior enabled and active state independently. A
   previously inactive web unit used temporarily for health is stopped again.
   Activation never broadens prior disabled/inactive services or linger settings.
6. Commit state/current only after health and integration steps pass. Retain the
   last known-good release/runtime and the backup. Report the new tag/SHA.

Each release holds its own dependency tree and build, so retention is explicit.
Keep the active release and the recorded previous release, with their runtimes.
After a commit, prune any other release or runtime that state, an installed unit,
and an owned bridge no longer reference. Never prune while an operation is
unfinished. A pruning failure is reported with the retained paths and does not
fail a committed update. Backups are application data and are never pruned here.

Before the database-change boundary, recovery can restore prior units/state
without restoring data. After that boundary, stop all candidate writers and use
the **previous release's** restore command on the verified pre-cutover backup
before restarting the previous services. Current restore validates against the
build that runs it and migrates forward; using the candidate's restore cannot
prove compatibility with the previous code. Source rollback alone is insufficient.

The failed candidate database is preserved by the existing restore mechanism.
Explain that observations/settings written during the failed activation are not
part of the recovered live database; they remain in the retained failed copy.
Do not restore over an in-use database. If recovery fails, leave writers stopped,
retain source/runtime/backup/journal, and print exact paths and recovery commands.
Never loop between candidates or silently continue with incompatible data.

On the next mutating invocation, inspect the journal first and recover an
interrupted operation before starting another. Test abrupt process termination,
not only catchable exceptions. Use physical previous-release paths for recovery
even if `current` or the launcher already moved. Unit/config snapshots and phase
markers survive power loss; persist them before the side effects they guard.
Define an explicit committed operation identity in authoritative state. Recovery
of a committed update finishes metadata/journal cleanup, without restoring its
pre-cutover backup. Test interruption after commit but before journal removal so
a successful upgrade cannot later lose new observations through false rollback.

Completion: failed download/build leaves the running installation unchanged;
failed migration/health/bridge refresh recovers the previous code, runtime, units,
and database; interruption at each cutover boundary is recoverable; after
repeated updates only the active and previous releases/runtimes remain.

### 6. Implement status, Claude integration, and uninstall

`status` reports installation version/SHA, runtime, installation/data/config paths,
effective URL, web/timer state, linger state, bridge state, and pending recovery.
Use existing redacted diagnostics/journal access. HTTP/service health does not
require healthy provider accounts. Exit `0` for an installed healthy web/timer,
`1` for missing/degraded installation or recovery required, and `2` for invalid
arguments/state. Report disabled units distinctly. Status creates no database,
does not migrate/collect, and does not fetch an update.

`claude-statusline` forwards the existing installer's preview/apply/wrap/print/
uninstall flags from the active physical release using the managed runtime and
installed configuration. Initial dashboard installation leaves Claude settings
unchanged. Record bridge ownership only after an explicit successful apply.
Refresh that owned bridge on update because existing commands embed absolute
checkout/runtime paths. Preserve wrapped commands, padding, and unrelated fields.
If the user replaced it, mark it externally managed and leave it untouched.
Ownership must validate the recorded install root/runtime/bridge path, not merely
the substring marker the current standalone installer uses.

`uninstall` locks and validates ownership, stops the owned timer, waits for the
collector, and stops the owned web unit before removing unit files and reloading
systemd. Remove an owned Claude bridge through the existing restoration logic,
returning any wrapped status line. If safe removal cannot be proven, retain the
referenced runtime/release and return actionable failure. Never delete a runtime
that a surviving bridge or unit still references.

Remove only the owned launcher and managed source/runtime/cache/metadata, never
the data ownership record. Preserve
application data, credentials, spool, backups, collector.env, CODEX_HOME, provider
CLIs, Claude settings backups, and previously chosen linger state. Refuse a data
directory nested inside the removable install root. Repeated uninstall of an
already removed installation is a successful no-op when no owned remnants exist;
invoke it through the bootstrap recovery entry point once the launcher is gone.
The root, its lock sentinel, and the data ownership record remain, so a later
install from the same root with the same configuration reuses the retained
database (§4 step 4). Foreign remnants are reported and left alone. Uninstall
output names the retained data directory and ownership record. Retain minimal recovery metadata
until removal completes. Status/removal code must remain executable throughout.

For all mutating commands, `--dry-run` means no persistent writes, downloads,
migration, provider calls, service actions, chmod, or linger changes. Use local
state/ref information and clearly mark release resolution that would require
network access. The preview identifies planned ownership/path/service effects.

Completion: status is observational, explicit bridge operations survive update,
and uninstall removes managed execution surfaces while retained data/settings
match their pre-uninstall content.

### 7. Document and deliver

Update README with one user entry point and a manual-install fallback. Setup owns
managed paths, command semantics, recovery, configuration, prerequisites, and
platform limitations. Explain the retained Node/build requirement behind the
installer without burdening the default user flow with contributor commands.
Keep the maintainer production-checkout runbook separate: managed installer
commands must not target its checkout or existing units implicitly.

Add no claims of published installer URLs, successful ARM/macOS support, live
provider proof, or reboot persistence without the corresponding evidence. Keep
the release command unpublished until its tagged source exists. Follow normal
repository commit/release authorization; this brief does not supply it.

At delivery, fold implemented details into Setup and the plan, update the log,
archive this brief with `git mv`, set Status to `Archived`, and update index links.

## Files Touched

Existing paths below were verified at the assessment head. New paths are intended
outputs; extract small helpers where the implementation needs a clear seam.

| Path                                                                                                           | Change                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `scripts/install.sh` (new)                                                                                     | Bash preflight, source/runtime bootstrap, and invocation.                                                         |
| `scripts/install-runtime.env` (new)                                                                            | Constrained exact runtime version/checksum manifest.                                                              |
| `scripts/manage-installation.ts` (new)                                                                         | Validated state, lifecycle sequencing, launcher commands, recovery.                                               |
| `src/lib/installation/` (new)                                                                                  | Focused ownership/state/runtime/process helpers as needed.                                                        |
| `scripts/install-systemd.sh`, `scripts/render-systemd-units.ts`, `src/lib/systemd-unit.ts`                     | Reuse rendering and installation; add only seams needed for controlled start/health/timer ordering and ownership. |
| `scripts/install-claude-statusline.ts`                                                                         | Managed ownership/path support while preserving current standalone behavior.                                      |
| `scripts/db-backup.ts`, `scripts/db-restore.ts`, `src/lib/db/backup.ts`                                        | Reuse verified backup/restore; change only if lifecycle reuse needs a narrow interface.                           |
| `src/lib/config.ts`, `src/lib/env-file.ts`, `src/lib/paths.ts`                                                 | Reuse canonical resolution, avoid a second config parser.                                                         |
| `package.json`                                                                                                 | Focused test/rehearsal scripts; preserve existing runtime and pnpm policies.                                      |
| `tests/unit/installation.test.ts` (new)                                                                        | Version/state/ownership/transition and manifest validation.                                                       |
| `tests/integration/installation.test.ts` (new)                                                                 | CLI/fixtures, failure injection, permissions, recovery, and bridge behavior.                                      |
| `scripts/test-installation-systemd.sh` (new)                                                                   | Disposable Linux systemd rehearsal, isolated HOME/data/units/port.                                                |
| `.github/workflows/ci.yml`                                                                                     | Run focused installer checks and a disposable systemd rehearsal; separate proof from mocked tests.                |
| `README.md`, `docs/operations/setup.md`, `docs/operations/production-checkout.md`                              | User flow, managed operations/recovery, and explicit separation from maintainer deploys.                          |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`, `docs/log.md`, `docs/index.md`, `docs/backlog/index.md` | Delivery contract, evidence, navigation, and archive links.                                                       |

Do not change adapters, provider/credential semantics, migration definitions, or
Next.js packaging for this task. Read the installed Next.js guides before any
necessary launcher/build-related change, as AGENTS.md requires.

## Acceptance Criteria

- [ ] The release-pinned public command and local bootstrap interface agree;
      unsupported/missing release targets fail before persistent activation.
- [ ] Linux x86_64 installation succeeds without preinstalled Node/pnpm, and the
      Node default, shell profiles, global packages, and unrelated units are unchanged.
- [ ] The private runtime checksum/version and exact Corepack-managed pnpm pin
      are checked; frozen lockfile and exact build approvals remain enforced.
- [ ] Install and update run without prompts both from a TTY and from `curl … | bash`;
      no child process reads the bootstrap's stdin.
- [ ] Preflight refuses glibc below 2.28 before downloading and reports the native
      build fallback's toolchain when no `better-sqlite3` prebuilt can be fetched.
- [ ] Only the active and previous releases/runtimes are retained after a commit;
      nothing referenced by state, a unit, or an owned bridge is pruned.
- [ ] Managed metadata records detached tag/SHA provenance and resolved config;
      moved tags, unsafe roots, foreign ownership, and concurrent operations are refused.
- [ ] Builds/rehearsals leave real user data untouched; fresh activation yields
      the configured loopback HTTP success and scheduled collection without accounts.
- [ ] Collector exit `1` reports provider setup/errors while allowing installation;
      exit `2` triggers recovery. No automatic quota-probe opt-in is introduced.
- [ ] Update stages before downtime and takes a verified backup after writers
      stop; failed activation restores prior code/runtime/units/database safely.
- [ ] SIGKILL/interruption at stop, backup, migration, unit installation, health,
      and metadata commit boundaries is recovered from the durable journal.
- [ ] Status performs no migration, collection, or mutation and exposes incomplete
      recovery, disabled/degraded services, and actual linger state accurately.
- [ ] Claude settings remain unchanged until explicit apply; an owned bridge
      follows updates/recovery and hands back any wrapped command on uninstall.
- [ ] Uninstall and repeated uninstall preserve data, credentials, configuration,
      provider state, and linger; only demonstrably owned execution surfaces disappear.
- [ ] Install → uninstall → install from the same root and configuration reuses the
      retained database after a verified backup, with history and saved keys intact.
      A database newer than the candidate, one in use, or one at a path the
      ownership record does not name is refused before any writable open.
- [ ] Dry runs produce no persistent or external side effects; failures identify
      stage, retained paths, and a concrete remedy without printing secrets.
- [ ] Real disposable-systemd install/update/failure-recovery/uninstall rehearsal,
      focused tests, `pnpm run verify`, browser proof, and OKF validation pass.
- [ ] README/Setup document the implemented commands and verified platform scope;
      release publication and any unperformed live/boot/hardware checks are explicit.
- [ ] Implemented contracts are folded into canonical docs and this brief is archived
      with corrected status/links; no unrequested deployment or release is performed.

## Testing

### Focused checks

Add the named test files/scripts above and run these commands from the repo root:

```bash
bash -n scripts/install.sh scripts/install-systemd.sh scripts/test-installation-systemd.sh
pnpm exec vitest run tests/unit/installation.test.ts tests/integration/installation.test.ts
pnpm exec vitest run tests/integration/render-systemd-units.test.ts tests/integration/statusline-installer.test.ts tests/integration/db-backup.test.ts
pnpm run test:installation:systemd
```

The final command is a **new** package script to add for the disposable-systemd
runner. It must refuse the ordinary developer/production environment; run it in
a disposable Linux VM or container with a working user systemd session. CI provisions
that environment. All rehearsal source refs, HOME/config/data, launchers, units,
ports, and fake provider executables belong to that disposable instance.

The user manager reads unit files from its own account's configuration directory
and ignores the `HOME` of the process calling `systemctl --user`. Isolation
therefore means a dedicated throwaway account with linger, entered through a real
login session such as `machinectl shell` or SSH, or a VM/container with its own
systemd. A substitute `HOME` under the developer's account is not isolation: units
written there are never loaded. The runner refuses to start unless an explicit
opt-in variable is set and the account has no pre-existing dashboard units, data,
or launcher. On GitHub-hosted Ubuntu images, `/etc/environment` sets
`XDG_RUNTIME_DIR` to the runner account's directory for every session
([actions/runner-images#14649](https://github.com/actions/runner-images/issues/14649));
a dedicated account's session must use its own `/run/user/<uid>`.

### Required scenarios and proof

| Scenario                                   | Required evidence                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold install without Node or providers     | Checked private runtime/pnpm, HTTP success, active owned timer, owner-only paths, useful provider setup hints.                                                        |
| Existing wrong-major Node/nvm/global Codex | Original runtime/profile unchanged; baked PATH executes the captured Codex fixture with the managed Node.                                                             |
| Version/ref selection                      | Stable SemVer/ancestry selection, no release, explicit missing version, moved tag, and downgrade refusal.                                                             |
| Paths/configuration                        | Absolute XDG/custom root, spaces rejected according to renderer limits, literal `%`/`&` handling, custom loopback port/IPv6, retained installed config across shells. |
| Ownership                                  | Manual units/launcher/root/database are untouched; symlink escape and changed installed unit ownership are refused.                                                   |
| Dependency/runtime failures                | Offline/download/checksum/Corepack/native-build/build failures before cutover preserve the running release.                                                           |
| Platform/native preflight                  | glibc below 2.28 or musl refused before download; unreachable `better-sqlite3` prebuilt without a toolchain fails with both causes named.                             |
| Non-interactive execution                  | TTY and `curl … \| bash` runs complete without prompts; Corepack never asks to download; the piped script is never consumed by a child.                               |
| Retention                                  | Three successive updates leave only active and previous releases/runtimes; a release referenced by a unit or owned bridge survives pruning.                           |
| Activation failures                        | Port conflict, stuck collector, backup refusal, migration failure, unhealthy web, and bridge-refresh failure yield bounded recovery or stopped actionable state.      |
| Schema rollback                            | Fixture releases with different migration sets prove the previous restore executable recovers the compatible backup; preserved failed DB is inspectable.              |
| Crash/concurrency                          | SIGKILL at each journal boundary, contention, stale journal, repeat install/update, and state-write failure.                                                          |
| Claude settings                            | Preview leaves settings unchanged; apply/wrap/update/recovery/uninstall preserve custom fields; externally replaced bridge is untouched.                              |
| Reinstall after uninstall                  | Same root/config reuses the retained DB after a verified backup; newer schema, in-use DB, other root, and unrecorded path are refused unopened.                       |
| Status/uninstall/dry run                   | Snapshot retained files/settings before/after; prove no status/dry-run DB/provider activity and no uninstall escape beyond owned execution paths.                     |
| Linger                                     | Unrequested state unchanged; explicit requested success/failure reported; persistence claim limited to tested state.                                                  |

Mocks prove decision/ordering logic; they do not prove systemd execution. The real
rehearsal must use detached fixture release checkouts, actual dependency/native
module installation and build, real generated units, HTTP health, timer execution,
one failed update with DB recovery, and final removal. Prove boot/logout separately
if claiming it was exercised. No live provider account is required; fake CLI/HTTP
sources must be identifiable as fixtures.

For browser-visible installation claims, use a named `agent-browser` session
against the disposable dashboard, capture the dashboard and Settings entry point,
and close it. Do not save a real key or trigger a real Claude probe. Reuse the
existing Playwright suite if user-facing code changes; source-only snapshots do
not prove the browser claim.

### Completion gates

```bash
pnpm run verify
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
git diff --check
```

For writing this brief only: run the OKF validator, formatting checks on modified
Markdown, and `git diff --check`. Runtime tests/rehearsal above belong to future
implementation. Record performed checks and remaining release/live/hardware
verification separately; do not convert historical evidence into current proof.

## Open Questions
