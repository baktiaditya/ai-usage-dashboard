---
type: Backlog Brief
title: Support database restore on macOS
---

# Support database restore on macOS

## Status

Archived

Delivered on 2026-10-03 on branch `feat/macos-restore-guard`; the delivery is recorded in the
[log](../../log.md). The contract lives in [Setup](../../operations/setup.md) §1 "Backup and
restore" and the [README](../../../README.md). This brief is not updated further.

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#28](https://github.com/baktiaditya/ai-usage-dashboard/issues/28)

## Objective

`pnpm run db:restore` works on macOS with the same safety guarantee it has on Linux: it refuses,
and changes nothing, while any process holds the database or one of its sidecars open. The Husky
hooks find a Homebrew-installed Node and pnpm on Apple Silicon. Linux behavior is unchanged.

## Context

A macOS-support assessment on 2026-10-03, against `c7b6c05`, found two Linux-only couplings. The
README states both: scheduling uses user `systemd`, and the restore guard reads `/proc`. This brief
removes the second, which is small and needs no scope decision. The scheduler is filed separately in
[schedule-collection-with-launchd-on-macos](../ready-for-agent/schedule-collection-with-launchd-on-macos.md).

`processesHolding()` in `src/lib/db/backup.ts` lists `/proc`, then reads `/proc/<pid>/fd/*` links to
find holders of the database, its `-wal`, and its `-shm`. macOS has no `/proc`, so the function
throws `BackupError('cannot tell whether the database is in use: /proc is unavailable on this
platform')`. `restoreDatabase()` calls `assertNotInUse()` twice, before staging and again at the
swap, so a restore on macOS always fails closed. `backupDatabase()` does not call the guard, so
`pnpm run db:backup` already works there.

`lsof` ships with macOS and is the standard way to ask the same question. Failing closed is the
existing contract ([Setup](../../operations/setup.md) §1 "Backup and restore"): the restore refuses
"while a process still holds the database open", so any doubt about holders must refuse, not pass.

`.husky/pre-commit` and `.husky/commit-msg` fall back, when `node` or `pnpm` is missing from `PATH`,
to nvm, `~/.local/bin`, `/usr/local/bin`, and `/usr/bin`. Homebrew on Apple Silicon installs to
`/opt/homebrew/bin`, which a Git GUI's minimal `PATH` lacks. `sort -V` in the nvm lookup is
supported by macOS's FreeBSD-derived `sort` (`sort --version` prints `2.3-Apple`; `sort(1)` lists
`-V` among its extensions). Node 24 requires macOS 13.5 or later (Node's `BUILDING.md`), so that
line needs no change.

## Dependencies and Gates

None. No real Mac is required to finish: the `lsof` path is exercised on Linux, where `lsof` is
installed on this machine and on GitHub's `ubuntu-latest` runners. A run on real macOS is recorded
as unperformed verification (see Testing).

## Scope

### In scope

- An `lsof`-based holder check used when `/proc` cannot be read.
- Fail-closed handling of every `lsof` outcome that is not a clear answer.
- A stop hint in the refusal message that does not name systemd units on a platform without them.
- `/opt/homebrew/bin` in both Husky hooks' fallback `PATH`.
- README and Setup wording for the restore guard.

### Out of scope

- Any scheduler other than user systemd, launchd plists, or installer changes.
- Changing data or config default paths on macOS. The XDG fallbacks (`~/.local/share`,
  `~/.config`) already resolve there.
- A macOS CI job.
- Windows.
- Any change to `backupDatabase()`, the restore's schema checks, or the Linux `/proc` scan.

## Approach

1. In `src/lib/db/backup.ts`, keep the `/proc` scan as it is and make it the first strategy. When
   `readdirSync('/proc')` fails, call a new exported
   `processesHoldingViaLsof(paths, run = defaultRun)` instead of throwing. `run` wraps
   `execFileSync` and is injectable for unit tests.
2. `processesHoldingViaLsof` receives the existing, `realpathSync`-resolved paths (it returns `[]`
   when none exist, as today) and runs `lsof -w -t -- <paths…>` with a 10-second timeout and a
   bounded `maxBuffer`. (`-t` already implies `-w`; keep `-w` explicit anyway.) `lsof(8)`, under
   DIAGNOSTICS, returns 1 when it fails to find any one of the files it was asked about. It
   returns 0 only when it found something for every argument. A database held open without its
   `-shm`, or with no `-wal`, therefore exits 1 while still printing the holder's PID. Interpret
   the result like this:
   - exit 0 or 1 with non-empty stdout: every non-empty stdout line must be a positive integer PID.
     Return them deduplicated and sorted; these are holders, and the restore refuses. A
     non-numeric line throws, because output that cannot be parsed is not a "no".
   - exit 1 with empty stdout and empty stderr: no holder, return `[]`. This is how `lsof` reports
     that none of the files is open.
   - exit 1 with empty stdout and stderr output, any other exit, a timeout, or a signal: throw
     `BackupError` reading
     `cannot tell whether the database is in use: lsof failed: <first stderr line, redacted>`.
   - `ENOENT` spawning `lsof`: throw `BackupError` reading
     `cannot tell whether the database is in use: /proc is unavailable and lsof was not found`.
3. Make the refusal message in `assertNotInUse()` platform-aware with a small helper that takes
   `platform = process.platform`. On `linux`, keep today's text, which names
   `ai-usage-dashboard-web.service` and `ai-usage-dashboard-collector.timer`. Elsewhere, say:
   `Stop the scheduled collector, the dashboard server, and any pnpm run dev or pnpm run start, then
retry`. The integration test's `open in process .*\b<pid>\b` pattern must still match on both.
4. In `.husky/pre-commit` and `.husky/commit-msg`, change the fallback to
   `PATH="${nvm_bin:+$nvm_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"`.
   Keep both hooks identical in that block, and keep the comment accurate.
5. In `README.md`, the Quick start note becomes "Scheduled collection runs on Linux only: it uses
   user `systemd`." Drop the `/proc` clause.
6. In `docs/operations/setup.md` §1 "Backup and restore", add one sentence after the refusal list:
   the in-use check reads `/proc` on Linux and asks `lsof` elsewhere, and refuses when neither can
   answer. Also say that without the systemd units you stop the collector and dashboard processes
   yourself before restoring.
7. Record the delivery in `docs/log.md` as an `Update`, move this brief to `docs/backlog/archive/`
   with `git mv`, set its status to `Archived`, and repoint links to it, including the link from
   the launchd brief.

## Files Touched

| Path                                          | Change                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `src/lib/db/backup.ts`                        | `lsof` fallback when `/proc` is unreadable; platform-aware stop hint       |
| `tests/unit/backup-lsof.test.ts`              | New: `processesHoldingViaLsof` against an injected runner                  |
| `tests/integration/db-backup.test.ts`         | The held-open refusal also proven through real `lsof` when it is installed |
| `.husky/pre-commit`                           | `/opt/homebrew/bin` in the fallback `PATH`                                 |
| `.husky/commit-msg`                           | Same                                                                       |
| `README.md`                                   | Platform note names only the scheduler                                     |
| `docs/operations/setup.md`                    | §1 "Backup and restore": how the in-use check works off Linux              |
| `docs/log.md`                                 | Delivery entry                                                             |
| `docs/backlog/ready-for-agent/…` → `archive/` | This brief, archived on delivery                                           |

## Acceptance Criteria

- [ ] On Linux, `processesHolding()` still uses `/proc`, and every existing test in
      `tests/integration/db-backup.test.ts` passes unchanged.
- [ ] `processesHoldingViaLsof` returns the deduplicated PIDs `lsof -t` prints, both for exit 0
      and for exit 1 with PIDs on stdout (some, not all, of the paths held). It returns `[]` for
      exit 1 with no output.
- [ ] It throws `BackupError` for: exit 1 with stderr and no PIDs, any other non-zero exit, a
      timeout, a non-numeric stdout line, and a missing `lsof` binary. Each message starts with
      `cannot tell whether the database is in use`.
- [ ] With real `lsof`, a restore refuses while this process holds the target database open,
      names this PID, and leaves the current database untouched. The test is skipped, not failed,
      where `lsof` is absent.
- [ ] The refusal names the systemd units only when `platform` is `linux`.
- [ ] Both Husky hooks list `/opt/homebrew/bin` in the fallback `PATH` and pass `sh -n`.
- [ ] README and Setup no longer say the restore guard needs `/proc`. README still says scheduling
      is Linux-only.
- [ ] `pnpm run verify` and the OKF validator pass.

## Testing

While iterating:

```bash
pnpm exec vitest run tests/unit/backup-lsof.test.ts tests/integration/db-backup.test.ts
sh -n .husky/pre-commit && sh -n .husky/commit-msg
```

To prove the real `lsof` path on Linux, the new integration case calls `processesHoldingViaLsof`
directly. It must not rely on `/proc` being unreadable.

Final gates:

```bash
pnpm run verify
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
```

Unperformed verification, to state in the delivery entry: no run on real macOS. `lsof` flags and
exit codes are the same BSD-derived tool on both platforms, but `pnpm run db:restore` refusing and
succeeding on a Mac stays unproven until someone runs it there.

## Open Questions
