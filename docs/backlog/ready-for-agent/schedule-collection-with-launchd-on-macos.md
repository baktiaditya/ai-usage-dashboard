# Schedule collection with launchd on macOS

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#29](https://github.com/baktiaditya/ai-usage-dashboard/issues/29)

## Objective

On macOS, one installer command renders, installs, enables, inspects, and disables per-user
LaunchAgents. They run the collector every `AUD_COLLECT_INTERVAL_MINUTES` and, optionally, keep the
loopback dashboard running. They have the same data directory, environment file, `PATH`, and
`CODEX_HOME` contract as the systemd units. The Linux systemd path is unchanged.

## Context

A macOS-support assessment on 2026-10-03, against `c7b6c05`, found the application portable apart
from two couplings. The restore guard's `/proc` dependency is handled by
[support-database-restore-on-macos](../archive/support-database-restore-on-macos.md). This
brief covers the other coupling, the scheduler. The user accepted its scope and verification plan
on 2026-10-07.

What exists today:

- `systemd/*.template`: the collector oneshot service, its timer, and the web service.
- `src/lib/systemd-unit.ts`: literal `__NAME__` substitution, escaped for systemd, which refuses
  values a unit cannot carry.
- `scripts/render-systemd-units.ts`: resolves the data directory, env file, interval, host, and port
  through `getConfig()`.
- `scripts/install-systemd.sh`: resolves absolute `node`, `tsx`, and `codex` paths into a baked
  `PATH`, then drives `systemctl --user` and `journalctl --user`.

The [plan](../../plan/ai-usage-dashboard-implementation-plan.md) §3.3 and §5 now allow user systemd
on Linux and per-user launchd on macOS, following the
[2026-10-07 decision](../../log.md#2026-10-07). The archived
[prepare-open-source-release](../archive/prepare-open-source-release.md) brief listed "macOS,
Windows, or any scheduler other than user systemd" as out of scope for that release. Adding launchd
is an accepted scope change for manual macOS installation. The managed installer and
production-checkout runbook remain Linux/systemd-only. Implementation and real-Mac lifecycle
verification are still pending.

The assessment identified these components as portable; this is not evidence of a completed
end-to-end Mac run:

- Next.js and SQLite, with `better-sqlite3` prebuilds for darwin arm64 and x64.
- Every HTTP adapter, using keys stored in the database.
- The Codex adapter, which spawns `codex app-server`.
- The Claude status-line bridge, which uses `/bin/sh` and `~/.claude/settings.json`.
- File modes, and the XDG fallback paths.

Sources checked on 2026-10-03 for the launchd details below:

- `launchd.plist(5)` and `launchctl(1)`, Apple's manuals (mirrored at
  `https://keith.github.io/xcode-man-pages/`).
- `systemd.timer(5)`.
- Codex's [authentication docs](https://developers.openai.com/codex/auth).
- Node's `BUILDING.md`.
- Field reports, which are not normative:
  - TCC denying LaunchAgents access to `~/Documents`;
  - exit 78 from a missing log directory;
  - the async `bootout` race;
  - error 5 from bootstrapping a disabled label;
  - macOS 13 Background Task Management.

## Dependencies and Gates

1. **Scope resolved.** Plan §3.3 and §5 and the 2026-10-07 log decision authorize per-user launchd
   for macOS alongside unchanged Linux systemd behavior. Keep the default five-minute interval,
   a 120-second collector deadline, and an optional web agent.
2. **Security posture accepted.** Run as the user without systemd's filesystem/syscall sandbox.
   Retain loopback binding, private file modes, credential handling, and the protected-location
   refusals. Do not introduce `sandbox-exec` or a root LaunchDaemon.
3. **Verification ownership resolved.** The implementation agent performs technical lifecycle
   checks on the available Mac; the user assists with sleep/wake, logout/login, and Login Items
   after implementation. Use separate test labels, data, logs, and a free loopback port. These are
   delivery verification steps, not prerequisites for starting implementation. Mark every
   unperformed step explicitly; partial evidence cannot justify an unqualified macOS support claim.
4. **CI and labels resolved.** Add `macos-15` ARM64 CI running `pnpm run verify` alongside Linux.
   Use `io.github.baktiaditya.ai-usage-dashboard.collector` and
   `io.github.baktiaditya.ai-usage-dashboard.web` as production labels.

## Target Machine and Verification Isolation

Read-only probes on 2026-10-07 found a MacBook Pro with Apple M1 Pro (10 CPU cores), 32 GB RAM,
macOS 15.7.3 ARM64, Node 24.16.0, pnpm 12.4.2, and available `launchctl`/`plutil`. The two production
labels were not loaded. Node and Codex resolve under `~/.nvm/versions/node/v24.16.0/bin/`.
This is a dated test-host observation, not a hardcoded runtime path or a claim of scheduler proof.

- Resolve the active absolute Node/tsx/Codex paths at installation and bake an explicit `PATH`.
  LaunchAgents must not depend on `.zshrc`, nvm shell initialization, or the pnpm shell plugin.
  Document reinstalling after moving/removing the baked runtime. Merely selecting another nvm
  version does not rewrite an installed agent's paths.
- Give the renderer injectable label values, with the production labels above as defaults, so
  technical lifecycle tests can render disposable labels ending in `.test.<run-id>` without
  installing or disabling production labels. Validate labels and use the same test labels for all
  lifecycle operations; an internal test harness may drive `launchctl` directly on these plists.
- Put test data, environment files, and logs in an isolated, non-protected temporary directory and
  select a free loopback port outside the production/development defaults. Restore checks use only
  that disposable database. Clean up only test agents and their owned files after verification;
  preserve an isolated fixture across login cycles until the user's manual checks finish.

## Scope

### In scope

- LaunchAgent templates and a renderer for them, with plist-safe escaping.
- A macOS installer with the same flags as `scripts/install-systemd.sh`: render only (default),
  `--install`, `--enable`, `--with-web`, `--status`, and `--disable [--with-web]`.
- A whole-run deadline in the collector, because launchd has no `TimeoutStartSec`.
- The macOS stop hint in the restore refusal, naming the launchd labels.
- Setup, README, plan, and log updates.
- macOS 15 ARM64 verification CI alongside existing Linux checks.

### Out of scope

- Windows, or any other scheduler (cron, `pm2`).
- Extending the managed Linux installer or production-checkout runbook to macOS.
- Moving default data or config paths to `~/Library/Application Support`.
- Running collection while the user is logged out. LaunchAgents in the `gui/<uid>` domain run only
  during a login session. A LaunchDaemon would need root and a different trust model.
- Changing loopback binding, authentication, credential storage, or collection semantics.

## Approach

Accepted approach; implement only this brief's scope.

1. **Templates.** Add `launchd/<label>.collector.plist.template` and
   `launchd/<label>.web.plist.template`, with default labels
   `io.github.baktiaditya.ai-usage-dashboard.collector` and
   `io.github.baktiaditya.ai-usage-dashboard.web`. They reuse the systemd
   placeholder names (`__WORKDIR__`, `__NODE__`, `__TSX__`, `__PATH__`, `__CODEXHOME__`,
   `__ENVFILE__`, `__DATADIR__`, `__INTERVAL__`, `__HOST__`, `__PORT__`), plus a new
   `__LOGDIR__`.
   - Both templates set: `ProgramArguments` (node, tsx, script), `WorkingDirectory`, and
     `EnvironmentVariables` matching the systemd `Environment=` lines. They also set `Umask` to
     the integer `63`. `launchd.plist(5)` reads an integer `Umask` as decimal, because plists
     cannot encode octal, and 63 is `0077`. `StandardOutPath` and `StandardErrorPath` point under
     `__LOGDIR__`, which renders to an absolute path such as
     `/Users/<you>/Library/Logs/ai-usage-dashboard`. launchd does not expand `~`.
   - Neither template sets `AbandonProcessGroup`. With its default, launchd kills processes left
     in the job's process group when the job exits, which reaps a stray `codex app-server` child.
   - Collector: `StartInterval` = interval × 60, `RunAtLoad` true, `ProcessType` `Background`,
     `LowPriorityIO` true. Per `launchd.plist(5)`, a `StartInterval` firing that falls while the
     Mac is asleep is missed, not coalesced. Wake-time coalescing applies only to
     `StartCalendarInterval`, which cannot express an arbitrary minute interval. Collection
     therefore resumes at a later interval firing after wake, and no catch-up run is promised.
     This is not a regression from Linux: `systemd.timer(5)` limits `Persistent=` to
     `OnCalendar=` timers, so it has no effect on the collector timer's `OnUnitActiveSec=`
     trigger. Manual refresh covers an immediate reading after wake.
   - Collector, at login: launchd has no `network-online.target` equivalent. The `RunAtLoad` run
     may start before the network is up and record a transport-error attempt. The next interval
     run recovers, so this is documented rather than worked around.
   - Web: `RunAtLoad` true, `KeepAlive` `{ SuccessfulExit: false }`, plus `NODE_ENV=production`
     and `NEXT_TELEMETRY_DISABLED=1`. `ThrottleInterval` is left at its default, which per
     `launchd.plist(5)` is at most one spawn every 10 seconds. launchd has no equivalent of
     `StartLimitBurst=5`/`StartLimitIntervalSec=300`. A web server that crashes on every start is
     therefore respawned every 10 seconds indefinitely instead of being given up on. Setup says
     so, and `--status` shows the run count and last exit code from `launchctl print`.
2. **Renderer.** Add `src/lib/launchd-plist.ts` beside `src/lib/systemd-unit.ts`, with the same
   literal-substitution contract:
   - it requires absolute paths;
   - it refuses control characters;
   - it XML-escapes `&`, `<`, `>`, `"`, and `'`;
   - it fails when any placeholder is left unfilled.

   Share the value set with `scripts/render-systemd-units.ts`. Extract a common `resolveUnitValues()`
   rather than duplicating the `getConfig()` reads. Add `scripts/render-launchd-agents.ts`.

3. **Installer.** Add `scripts/install-launchd.sh`, kept compatible with macOS's bash 3.2.
   - Resolve `node`, `tsx`, and `codex` exactly as `install-systemd.sh` does, with
     `/opt/homebrew/bin` in the baked `PATH` before `/usr/local/bin`.
   - Refuse, installing nothing, when the checkout, data directory, env file, `CODEX_HOME`, or log
     directory resolves under `~/Desktop`, `~/Documents`, `~/Downloads`, or iCloud Drive
     (`~/Library/Mobile Documents`). macOS privacy protection (TCC) denies launchd-started
     processes access to those folders even though Terminal can read them. The agent would fail
     with `Operation not permitted` (often from `getcwd` on `WorkingDirectory`) while every manual
     check passes. The message tells the user to move the checkout, for example to
     `~/Workspace`, rather than to grant Full Disk Access to `node`. A Full Disk Access grant
     would cover every script that `node` binary runs. The check lives in
     `scripts/render-launchd-agents.ts`, not in shell, so it is unit-testable on Linux with an
     injected home directory. It compares real paths, so a symlink into a protected folder is also
     refused.
   - Create `__LOGDIR__` with `mkdir -p` and mode `0700` before bootstrapping. launchd creates a
     missing log file but not a missing directory. A job whose `StandardOutPath` directory is
     missing fails to spawn with last exit code 78 (`EX_CONFIG`) and writes no log to explain it.
   - Run without `sudo`. `launchctl(1)` requires a per-user LaunchAgent to be owned by the user
     loading it and to disallow group and world writes.
   - Install into `~/Library/LaunchAgents/` with mode `0600`. launchd loads every plist in that
     directory at the next login, so a plist there is active unless its label is disabled.
     `--install` without `--enable` therefore runs `launchctl disable gui/$(id -u)/<label>` for
     each installed label. That keeps the systemd meaning of "installed but not enabled".
   - `--enable`: `launchctl enable gui/$(id -u)/<label>` first, because a disabled service cannot
     be loaded and `bootstrap` reports that only as `Bootstrap failed: 5: Input/output error`.
     If `launchctl print gui/$(id -u)/<label>` shows the label loaded, run `launchctl bootout`
     and poll `launchctl print` until it exits non-zero, bounded at a few seconds. `bootout`
     returns once launchd accepts the request, not once the label is gone. Bootstrapping a label
     that is still being torn down fails with the same error 5, and can leave nothing loaded.
     Then run `launchctl bootstrap gui/$(id -u) <plist>`, retrying a bounded number of times on
     error 5. Finally confirm with `launchctl print` that the label is loaded. On failure, print
     launchctl's error and exit non-zero; never fall back to starting an unsupervised process.
   - Restart the web agent with `launchctl kickstart -k`.
   - `--status`: `launchctl print gui/$(id -u)/<label>`, the label's state in
     `launchctl print-disabled gui/$(id -u)`, and a tail of the log files.
   - `--disable`: `launchctl bootout` to stop the agent now, then `launchctl disable` so it stays
     unloaded across logins and reboots (`launchctl(1)`: the disabled state persists across
     boots). The plist files stay in place.
   - Refuse to install the web agent without `.next/BUILD_ID`, as the systemd installer does.
   - Add a `launchd:install` package script.
4. **Collector deadline.** Add a hard deadline to `scripts/collect.ts` that exits non-zero after
   120 seconds, matching `TimeoutStartSec=120`. launchd never starts an interval job while the
   previous run is still alive, so one hung run would otherwise stop every later collection. Under
   systemd this is redundant with the unit timeout and harmless.
5. **Restore hint.** On `darwin`, the `assertNotInUse()` refusal names the two launchd labels and
   the `install-launchd.sh --disable` command.
6. **Docs.**
   - Setup gains a macOS subsection under §5, with the restore stop/start commands for macOS. It
     also names the differences from systemd: no sandboxing, no linger, logs in
     `~/Library/Logs/ai-usage-dashboard/` with no automatic rotation (truncate them by hand), no
     restart cap for the web agent, and no catch-up run after sleep.
   - It also covers what macOS 13 and later show. Installing a LaunchAgent raises a "Background
     Items Added" notification. The agents then appear under System Settings → General → Login
     Items (& Extensions) → "Allow in the Background", where any user can switch them off. A
     switched-off agent does not run, so `--status` and Setup troubleshooting point there when a
     label is not loaded. The listed name may be the executable (`node`) rather than the label;
     the real-Mac run records what appears.
   - It also states the TCC location rule (no checkout or data under Desktop, Documents,
     Downloads, or iCloud Drive).
   - It also covers the Codex credential store. Codex defaults to `auth.json` in `CODEX_HOME`
     (`cli_auth_credentials_store = "file"`), which the agent reads like any file. With `keyring`
     or `auto` the token lives in the login Keychain. The real-Mac run must confirm an agent in
     `gui/<uid>` can read it, and Setup marks keyring storage untested until then.
   - README's platform note names both schedulers.
   - Preserve the accepted scheduler scope in plan §3.3 and §5; update implementation status only
     when delivered and verification claims only when supported by evidence.
   - The `docs/log.md` decision and delivery entries.
   - [production-checkout](../../operations/production-checkout.md) stays systemd-only.
7. **CI.** Extend `.github/workflows/ci.yml` with a `macos-15` ARM64 job using the same pinned Node
   and Corepack/pnpm setup, frozen-lockfile installation, and `pnpm run verify` gate as Linux.
   Keep the disposable-systemd rehearsal Linux-only. CI proves Darwin code/test behavior, not GUI
   login-session launchd lifecycle behavior.
   - The 2026-10-07 Mac baseline passed format, lint, and typecheck, but tests reported 39 passing
     files and 3 failing files (696 passing tests, 2 failing tests, and 66 skipped after two suite
     setup failures). The source and test files were unchanged by the promotion. Resolve these
     existing fixture portability assumptions as part of enabling the Darwin verification gate:
     `tests/integration/installation.test.ts` invokes GNU `tar -I 'xz -T0 -0'`, which BSD tar cannot
     run; `tests/unit/installation.test.ts` compares a physical path against an uncanonicalized
     `/var` path, which macOS resolves through `/private/var`; and
     `tests/integration/codex-process.test.ts` uses `/bin/false`, absent on this Mac.
   - Keep the same assertions and Linux coverage. Use portable archive fixture creation, a
     canonical expected path for the symlink test, and a real available child executable that
     deliberately exits non-zero. Do not skip these tests or change managed-installer product
     behavior just to obtain a green Mac job.

## Files Touched

Expected implementation surfaces.

| Path                                                  | Change                                                    |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `launchd/*.plist.template`                            | New: collector and web LaunchAgents                       |
| `src/lib/launchd-plist.ts`                            | New: plist renderer with XML escaping and refusals        |
| `src/lib/systemd-unit.ts` or a new shared module      | `resolveUnitValues()` shared by both renderers            |
| `scripts/render-launchd-agents.ts`                    | New                                                       |
| `scripts/render-systemd-units.ts`                     | Uses the shared value resolution                          |
| `scripts/install-launchd.sh`                          | New macOS installer                                       |
| `scripts/collect.ts`                                  | Whole-run deadline                                        |
| `src/lib/db/backup.ts`                                | macOS stop hint names the launchd labels                  |
| `package.json`                                        | `launchd:install` script                                  |
| `.gitignore`                                          | `launchd/generated/`, as for `systemd/generated/`         |
| `.github/workflows/ci.yml`                            | macOS 15 ARM64 verification job alongside Linux           |
| `tests/unit/launchd-plist.test.ts`                    | New: escaping, refusals, placeholder coverage             |
| `tests/integration/render-launchd-agents.test.ts`     | New: rendered files parse as plist XML with expected keys |
| `tests/integration/installation.test.ts`              | Portable archive fixture setup for Darwin verification    |
| `tests/unit/installation.test.ts`                     | Canonical expected physical path on macOS                 |
| `tests/integration/codex-process.test.ts`             | Portable executable for the non-zero-exit fixture         |
| `docs/operations/setup.md`                            | §5 macOS subsection; restore commands                     |
| `docs/plan/ai-usage-dashboard-implementation-plan.md` | Accepted scope; implementation status at delivery         |
| `README.md`                                           | Platform note                                             |
| `docs/log.md`                                         | Decision and delivery entries                             |

## Acceptance Criteria

- [ ] Rendered plists parse as XML property lists on Linux. On macOS they pass `plutil -lint`.
      They carry the same `PATH`, `CODEX_HOME`, `AUD_ENV_FILE`, `AUD_DATA_DIR`, and interval values
      that `render-systemd-units.ts` produces for the same environment.
- [ ] A path containing `&`, `<`, or `%` renders literally and round-trips through a plist parser.
      A relative path, or one with a control character, is refused and nothing is written.
- [ ] `scripts/collect.ts` exits non-zero within the deadline when an adapter never settles. This
      is proven with an injected hanging adapter.
- [ ] Rendering refuses, writing nothing, when the checkout, data directory, env file,
      `CODEX_HOME`, or log directory resolves, after following symlinks, under `~/Desktop`,
      `~/Documents`, `~/Downloads`, or `~/Library/Mobile Documents`.
- [ ] The rendered log paths are absolute and contain no `~`. The installer creates the log
      directory with mode `0700` before any `bootstrap`.
- [ ] `--enable` runs `enable` before `bootstrap`. It waits, bounded, for a booted-out label to
      disappear from `launchctl print` before bootstrapping. It exits non-zero, starting nothing
      unsupervised, if the label is not loaded afterwards.
- [ ] The systemd templates, rendered units, and `install-systemd.sh` behavior are unchanged.
- [ ] On a real Mac: `--install --enable` loads the collector. A run appears in the dashboard
      within one interval. After sleep and wake, runs resume without a reinstall, and the
      checklist records the observed delay to the first run after wake. `--with-web` serves
      `127.0.0.1:<port>`. After `--disable` and a logout and login, neither agent is loaded. After
      `--install` without `--enable` and a logout and login, neither agent is loaded either.
      `--enable` loads them again. The agent owns the technical checks and the user assists with
      session/UI checks. Record each result separately; if any step is unperformed, leave that
      part of this criterion unfulfilled and qualify the delivery entry and README/Setup claims.
- [ ] Test lifecycle operations use disposable labels, data, logs, and a free port; production
      agents and data remain untouched. Default labels and installer operations are covered by
      automated tests, and the isolated harness exercises the real launchd lifecycle.
- [ ] The `macos-15` ARM64 `pnpm run verify` job passes alongside Linux verification; the systemd
      rehearsal remains Linux-only.
- [ ] `pnpm run verify` and the OKF validator pass.

## Testing

Focused:

```bash
pnpm exec vitest run tests/unit/launchd-plist.test.ts tests/integration/render-launchd-agents.test.ts
bash -n scripts/install-launchd.sh
```

Then `pnpm run verify` and `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`.

Real-Mac checklist (after implementation): the agent performs technical steps with the isolated
fixture described above. The user assists with sleep/wake, logout/login, and System Settings.
This promotion does not authorize the agent to log the user out or put the Mac to sleep itself.
Record the tested OS/architecture, sanitized outputs, and passed/failed/unperformed status for each
step. Keep keyring verification explicitly unperformed if that credential mode is unavailable.

- `plutil -lint` on both rendered plists;
- `--install --enable --with-web`;
- `launchctl print`;
- one collection visible in the dashboard;
- a sleep and wake cycle, recording when the first run after wake happens;
- `pnpm run db:restore` refusing while the agents run and succeeding after `--disable`;
- `--disable`, then logout and login, then `launchctl print` showing neither label loaded;
- `--install` without `--enable`, then logout and login, then neither label loaded;
- `--enable` loading both again;
- `--enable` run twice in a row, leaving both labels loaded (the bootout race);
- the "Background Items Added" notification and the name shown under Login Items, and that
  switching it off leaves the label unloaded and `--status` saying so;
- a Codex reading with the default `file` credential store, and, if available, with `keyring`;
- the macOS version tested. A third-party report describes `bootstrap` returning error 5 on
  macOS 26 with nothing loaded, while the legacy `launchctl load -w` worked. If that reproduces,
  record it, and decide on a fallback then rather than guessing now.

## Open Questions
