# Schedule collection with launchd on macOS

## Status

Ready for human

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
[support-database-restore-on-macos](../ready-for-agent/support-database-restore-on-macos.md). This
brief covers the other coupling, the scheduler. It is the larger of the two and needs user decisions.

What exists today:

- `systemd/*.template`: the collector oneshot service, its timer, and the web service.
- `src/lib/systemd-unit.ts`: literal `__NAME__` substitution, escaped for systemd, which refuses
  values a unit cannot carry.
- `scripts/render-systemd-units.ts`: resolves the data directory, env file, interval, host, and port
  through `getConfig()`.
- `scripts/install-systemd.sh`: resolves absolute `node`, `tsx`, and `codex` paths into a baked
  `PATH`, then drives `systemctl --user` and `journalctl --user`.

The [plan](../../plan/ai-usage-dashboard-implementation-plan.md) fixes the scheduler as user
systemd. §3.3 says "Run that command every 5 minutes via a user-level `systemd` service + timer",
and §5 sets the unit hardening rules. The archived
[prepare-open-source-release](../archive/prepare-open-source-release.md) brief listed "macOS,
Windows, or any scheduler other than user systemd" as out of scope for that release. Adding launchd
is therefore a scope change. It must land in the plan through a `docs/log.md` decision before this
brief can move to `ready-for-agent/`.

Everything else already runs on macOS without change:

- Next.js and SQLite, with `better-sqlite3` prebuilds for darwin arm64 and x64.
- Every HTTP adapter, using keys stored in the database.
- The Codex adapter, which spawns `codex app-server`.
- The Claude status-line bridge, which uses `/bin/sh` and `~/.claude/settings.json`.
- File modes, and the XDG fallback paths.

## Dependencies and Gates

1. **Scope decision (user).** Amend plan §3.3 and §5 so the scheduler reads "user systemd on Linux,
   a per-user launchd LaunchAgent on macOS", and record a `Decision` in `docs/log.md`.
2. **Accepted security posture (user).** See Open Questions.
3. **Verification on a real Mac (user).** `launchctl` behavior cannot be proven on Linux. Someone
   with a Mac must run the installer end to end, or the delivery must ship with that verification
   explicitly marked as unperformed. See Open Questions.

## Scope

### In scope

- LaunchAgent templates and a renderer for them, with plist-safe escaping.
- A macOS installer with the same flags as `scripts/install-systemd.sh`: render only (default),
  `--install`, `--enable`, `--with-web`, `--status`, and `--disable [--with-web]`.
- A whole-run deadline in the collector, because launchd has no `TimeoutStartSec`.
- The macOS stop hint in the restore refusal, naming the launchd labels.
- Setup, README, plan, and log updates.

### Out of scope

- Windows, or any other scheduler (cron, `pm2`).
- Moving default data or config paths to `~/Library/Application Support`.
- Running collection while the user is logged out. LaunchAgents in the `gui/<uid>` domain run only
  during a login session. A LaunchDaemon would need root and a different trust model.
- Changing loopback binding, authentication, credential storage, or collection semantics.

## Approach

Provisional until the gates close.

1. **Templates.** Add `launchd/<label>.collector.plist.template` and
   `launchd/<label>.web.plist.template`, with proposed labels
   `io.github.baktiaditya.ai-usage-dashboard.collector` and `….web`. They reuse the systemd
   placeholder names (`__WORKDIR__`, `__NODE__`, `__TSX__`, `__PATH__`, `__CODEXHOME__`,
   `__ENVFILE__`, `__DATADIR__`, `__INTERVAL__`, `__HOST__`, `__PORT__`).
   - Both templates set: `ProgramArguments` (node, tsx, script), `WorkingDirectory`, and
     `EnvironmentVariables` matching the systemd `Environment=` lines. They also set `Umask` to
     `63` (`0077`), and `StandardOutPath` and `StandardErrorPath` under
     `~/Library/Logs/ai-usage-dashboard/`.
   - Collector: `StartInterval` = interval × 60, `RunAtLoad` true, `ProcessType` `Background`,
     `LowPriorityIO` true. launchd coalesces intervals missed during sleep into one run on wake,
     which stands in for `Persistent=true`.
   - Web: `RunAtLoad` true, `KeepAlive` `{ SuccessfulExit: false }`, `ThrottleInterval` 5, plus
     `NODE_ENV=production` and `NEXT_TELEMETRY_DISABLED=1`.
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
   - Install into `~/Library/LaunchAgents/` with mode `0600`.
   - Enable with `launchctl bootout gui/$(id -u)/<label>` (ignore "not loaded"), then
     `launchctl bootstrap gui/$(id -u) <plist>`.
   - Restart the web agent with `launchctl kickstart -k`.
   - `--status`: `launchctl print gui/$(id -u)/<label>` plus a tail of the log files.
   - `--disable`: `bootout`, keeping the plist files.
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
     `~/Library/Logs/ai-usage-dashboard/` with no automatic rotation (truncate them by hand).
   - README's platform note names both schedulers.
   - Plan §3.3 and §5, per gate 1.
   - The `docs/log.md` decision and delivery entries.
   - [production-checkout](../../operations/production-checkout.md) stays systemd-only unless the
     user decides otherwise.

## Files Touched

Provisional.

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
| `tests/unit/launchd-plist.test.ts`                    | New: escaping, refusals, placeholder coverage             |
| `tests/integration/render-launchd-agents.test.ts`     | New: rendered files parse as plist XML with expected keys |
| `docs/operations/setup.md`                            | §5 macOS subsection; restore commands                     |
| `docs/plan/ai-usage-dashboard-implementation-plan.md` | §3.3 and §5 scheduler wording (gate 1)                    |
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
- [ ] The systemd templates, rendered units, and `install-systemd.sh` behavior are unchanged.
- [ ] On a real Mac: `--install --enable` loads the collector. A run appears in the dashboard
      within one interval, and runs continue after sleep and wake. `--with-web` serves
      `127.0.0.1:<port>`, and `--status` and `--disable` behave as documented. Otherwise the
      delivery entry marks this criterion unperformed, per Open Questions.
- [ ] `pnpm run verify` and the OKF validator pass.

## Testing

Focused:

```bash
pnpm exec vitest run tests/unit/launchd-plist.test.ts tests/integration/render-launchd-agents.test.ts
bash -n scripts/install-launchd.sh
```

Then `pnpm run verify` and `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`.

Real-Mac checklist (manual):

- `plutil -lint` on both rendered plists;
- `--install --enable --with-web`;
- `launchctl print`;
- one collection visible in the dashboard;
- a sleep and wake cycle;
- `pnpm run db:restore` refusing while the agents run and succeeding after `--disable`;
- `--disable`.

## Open Questions

1. **Scope:** should plan §3.3 and §5 adopt launchd as the macOS scheduler? (Owner: user; closes
   gate 1.)
2. **Sandboxing:** do you accept that macOS agents run without the systemd hardening (no
   `ProtectSystem`, `ProtectHome`, `ReadWritePaths`, or syscall filter), documented as a weaker
   posture? The alternative is wrapping the job in the deprecated `sandbox-exec`, which is not
   recommended. (Owner: user.)
3. **Verification:** who runs the real-Mac checklist? If nobody can, should the work ship with that
   criterion marked unperformed and macOS labelled "untested" in the README? (Owner: user.)
4. **CI:** add a `macos-latest` job running `pnpm run verify`? It would prove the test suite and the
   `lsof` restore path on darwin, but it cannot prove `launchctl` behavior. (Owner: user.)
5. **Labels:** are `io.github.baktiaditya.ai-usage-dashboard.{collector,web}` acceptable? (Owner:
   user; default to these if there is no preference.)
