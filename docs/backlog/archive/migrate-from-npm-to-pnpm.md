# Migrate the package manager from npm to pnpm

## Status

Archived

Delivered on 2026-09-15 in [PR #11](https://github.com/baktiaditya/ai-usage-dashboard/pull/11),
merged as `820d873` and deployed to the production checkout. The contract lives in
[plan §4.1](../../plan/ai-usage-dashboard-implementation-plan.md) and
[Setup](../../operations/setup.md) §1 and §6; the delivery is recorded in the [log](../../log.md).

Delivery goes beyond the Implementation Contract below, by decisions during implementation and
review. The Setup §6 deploy preflight also requires `pnpm-lock.yaml` and a
`pnpm@<version>+sha512.<hash>` pin, and the rollback preflight refuses a pin without that hash.
`pnpm-workspace.yaml` also sets `pmOnFail: ignore`, so `pnpm-lock.yaml` stays a single YAML
document. Setup is the canonical statement of these rules; this brief is not updated further.

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The repository installs, runs, tests, and deploys with pnpm instead of npm, on Node 24.15 or a later
Node 24 release. A fresh clone needs corepack and `pnpm install --frozen-lockfile`, and corepack
runs the exact, integrity-checked pnpm version that `package.json` pins. The native build allowlist
keeps its exact package versions, so no install prompts for approval and no future version runs an
install script without review. Every command in the README, Setup, `AGENTS.md`, the git hooks, and
user-visible messages names pnpm. The production checkout confirms pnpm is ready before any unit
stops, and deploys and rolls back with the tool that matches the lockfile of the commit it checks
out. Runtime behavior does not change.

## Context

The user asked on 2026-09-15 whether pnpm suits this repository. A trial the same day, at `e2d553c`,
in a throwaway clone with pnpm 12.4.2 and Node 24.19.0, found no blocker:

- `pnpm import` converted `package-lock.json` into `pnpm-lock.yaml` with the same resolved versions.
- The first `pnpm install --frozen-lockfile` failed with `ERR_PNPM_IGNORED_BUILDS` for
  `@tailwindcss/oxide`, `better-sqlite3`, `esbuild`, and `unrs-resolver`. The `allowScripts` field
  in `package.json` is read only by npm. After `pnpm approve-builds` wrote those four packages to
  `allowBuilds` in `pnpm-workspace.yaml`, the install compiled `better_sqlite3.node`.
- `pnpm audit` found no known vulnerabilities.
- The four `verify` steps passed through pnpm (34 test files, 495 tests), once `pnpm-lock.yaml` was
  added to `.prettierignore`. `pnpm run build` succeeded, and `pnpm run test:e2e` passed 60 tests.
- No source, script, or test imports a package missing from `package.json`, so pnpm's strict
  `node_modules` layout broke nothing.
- Husky's `prepare` still set `core.hooksPath` to `.husky/_`.
- `node_modules/tsx/dist/cli.mjs`, the path the installer renders into both systemd units, resolves
  through pnpm's symlink into `node_modules/.pnpm/`, which stays inside the checkout. The units only
  read it, so `ProtectHome=read-only` is unaffected. The pnpm store is on the same filesystem as
  the checkouts, so both the development repository and the production checkout hard-link from one
  store.

The trial also found differences that the migration must handle:

1. **pnpm forwards `--` to the script.** With pnpm 12.4.2, `pnpm run x -- --apply` gives the script
   `["--", "--apply"]`, while `npm run x -- --apply` gives `["--apply"]`. `pnpm run x --apply` gives
   `["--apply"]`. The documented `npm run db:backup -- <file>` and `npm run db:restore -- <file>`
   would therefore exit `2` with a usage error: `scripts/db-backup.ts` rejects any argument starting
   with `-`, and `scripts/db-restore.ts` requires exactly one argument.
   `scripts/install-claude-statusline.ts` and `scripts/collect.ts` look flags up with `includes` and
   `find`, so a stray `--` does not break them. Setup §3 and §6 currently tell the reader to keep the
   `--` because npm otherwise consumes `--apply`; with pnpm the advice reverses.
2. **The build allowlist must stay version-qualified.** `allowScripts` in `package.json` allows
   `better-sqlite3@12.4.1`, `@tailwindcss/oxide@4.1.13`, `esbuild@0.25.12`, `esbuild@0.28.2`, and
   `unrs-resolver@1.12.2`. `pnpm approve-builds` wrote bare package names, which would let any
   future version of those packages run install scripts without review. `allowBuilds` accepts
   `name@version` keys: on 2026-09-15, with pnpm 12.4.2, an `esbuild@0.25.12` entry let
   `esbuild@0.25.12` build, and an `esbuild@0.25.11` entry left it blocked with
   `ERR_PNPM_IGNORED_BUILDS`. The `esbuild@0.28.2` entry matches nothing in the current lockfile,
   which resolves only `esbuild@0.25.12`.
3. **Corepack limits the supported Node lines.** On the development machine, `pnpm` is corepack's
   shim inside the nvm-managed Node 24.19.0, and corepack's cache already holds pnpm 12.4.2.
   Corepack 0.35.0 declares `engines.node` as `^22.22.2 || ^24.15.0 || >=26.0.0`. Node 25 no longer
   bundles corepack and is outside that range, and `engines.node` in `package.json` is `>=22.12.0`,
   which admits both Node 25 and Node 22 releases before 22.22.2. The trial ran only on Node 24.19.0.
4. **Corepack downloads on a cold cache.** On 2026-09-15, with an empty `COREPACK_HOME` and standard
   input closed, `pnpm --version` in a directory pinning `pnpm@12.4.2` printed a download notice,
   fetched pnpm from the registry, and printed `12.4.2` without prompting. `corepack install` in the
   same directory filled the cache without running pnpm. A deploy that first calls pnpm after the
   units stop therefore depends on the registry during downtime unless the pinned version is cached
   first.
5. **Deploying across the migration boundary.** The production deploy in
   [Setup](../../operations/setup.md) §6 runs `npm ci`. The first pnpm deploy meets a
   `node_modules` that npm laid out. The trial did not check whether pnpm replaces it without a
   terminal, as the runbook runs. Rolling back to a commit from before the migration needs `npm ci`
   again, because that commit has no `pnpm-lock.yaml`.
6. **Command text is widespread.** `npm` or `npx` appears in `package.json` (`verify`),
   `playwright.config.ts` (`webServer.command`), `.husky/pre-commit` and `.husky/commit-msg`,
   `.env.example`, `scripts/install-systemd.sh`, the usage lines of `scripts/db-backup.ts` and
   `scripts/db-restore.ts`, the header and printed hints of `scripts/install-claude-statusline.ts`,
   a comment in `systemd/ai-usage-dashboard-web.service.template`, user-visible messages in
   `src/app/page.tsx`, `src/app/api/providers/[provider]/refresh/route.ts`,
   `src/lib/db/backup.ts`, and `src/lib/ingestors/claude-statusline.ts`, code comments, and the
   Acceptance Criteria and Testing of the
   [Tailscale brief](../ready-for-human/access-dashboard-over-tailscale.md). In the documents, it
   appears 18 times in `README.md`, 4 in `AGENTS.md`, and 58 in Setup (§1, §2, §3, §4, §6, §7, §9,
   §10).
7. **The plan pins npm.** [Plan](../../plan/ai-usage-dashboard-implementation-plan.md) §4.1 names
   "npm + `package-lock.json`" as the repository-pinned package manager, and its dated §0 baseline
   row recommends the same. §3.3, §3.4, and §3.5 give `npm run` commands as part of the contract.
   The 2026-09-15 `Decision` in [log](../../log.md) supersedes that pin; the plan text changes on
   delivery. The [implementation prompt](../../plan/ai-usage-dashboard-implementation-prompt.md) also
   says to initialize with npm; it is a historical record and keeps that wording.

The benefit for a single-package application is moderate: faster installs, one store shared by the
development repository and the production checkout, build scripts blocked unless approved, and a
strict `node_modules`. Most of the cost is text, plus the deploy and rollback procedure.

The [open-source release brief](https://github.com/baktiaditya/ai-usage-dashboard/pull/7), open in
PR #7 and not yet on `main`, rewrites the README, moves the Setup §6 runbook into
`docs/operations/production-checkout.md`, and adds `CONTRIBUTING.md` and a CI workflow. It already
names pnpm: its CI installs through corepack and runs `pnpm run verify`, and it treats this
migration as a preceding change that must land first. Its Node version step, which tests Node 22.12,
predates the `^24.15.0` range below and is corrected in that brief. Both briefs touch the same
commands and files.

## Dependencies and Gates

The user closed every gate on 2026-09-15, recorded as a `Decision` in [log](../../log.md):

- **Package manager:** pnpm and `pnpm-lock.yaml` replace npm and `package-lock.json`, superseding
  [plan](../../plan/ai-usage-dashboard-implementation-plan.md) §4.1.
- **Order:** this migration lands before the open-source release is implemented. The first public
  README, contributing guide, and CI therefore use pnpm, and the open-source release brief adopts
  pnpm commands when it is worked.
- **Installing pnpm:** corepack, pinned with `packageManager` set to `pnpm@12.4.2` plus its sha512
  integrity hash. Setup §1 and the README run `corepack enable pnpm` before installing.
- **Supported Node:** `engines.node` becomes `^24.15.0`, the only line verified here and inside
  corepack 0.35.0's range. Node 25 is unsupported. Widening to Node 22.22.2 or later, or to Node 26,
  waits for CI in the open-source release.
- **Production deploy:** the agent deploys the first pnpm commit to the production checkout with
  the updated Setup §6 procedure, once the rehearsal in Approach step 8 passes. The deploy stops
  both units briefly. If it fails, the agent rolls back to the recorded previous commit and reports
  it.

## Scope

### In scope

- Converting the lockfile, the version-qualified build allowlist, the pinned and hashed
  `packageManager`, `engines.node`, and `.prettierignore`.
- Every command reference in scripts, hooks, Playwright, the systemd web template, user-visible
  messages, code comments, `.env.example`, `README.md`, `AGENTS.md`, Setup, the backlog template,
  the Tailscale brief, and the plan: its package-manager decision (§4.1) and current commands
  (§3.3, §3.4, §3.5).
- Accepting a leading `--` in `scripts/db-backup.ts` and `scripts/db-restore.ts`, so old and new
  command forms both work.
- The Setup §6 deploy and rollback procedure, including a pnpm preflight before the units stop and
  the migration boundary, the first production deploy, an `Update` in `docs/log.md`, and archiving
  this brief.

### Out of scope

- Dependency upgrades or new dependencies.
- Supporting Node 22, 25, or 26, or a `.nvmrc`; the open-source release owns widening the range.
- A pnpm workspace or monorepo layout; `pnpm-workspace.yaml` holds only settings.
- Rewriting history: dated `docs/log.md` entries, archived briefs, the plan §0 machine baseline and
  its dated recommendation, the plan's M1 and §11 execution history, the implementation prompt, and
  the [M0 Discovery](../../discovery/m0-discovery.md) baseline and gate evidence keep `npm`.
- `.mcp.json`, whose `npx` launches external MCP servers rather than project dependencies.
- Anything the open-source release brief owns, beyond the command text it contains.

## Approach

1. On a branch from `main`, run `pnpm import` and delete `package-lock.json`. Create
   `pnpm-workspace.yaml` with `allowBuilds` keyed by exact version: `@tailwindcss/oxide@4.1.13`,
   `better-sqlite3@12.4.1`, `esbuild@0.25.12`, and `unrs-resolver@1.12.2`. If the imported lockfile
   resolves a different version of any of them, stop and report instead of widening an entry.
   Remove `allowScripts` from `package.json`, dropping the unused `esbuild@0.28.2`.
2. `package.json`:
   - `packageManager` is `pnpm@12.4.2+sha512.<hash>`. Take the hash from `corepack use pnpm@12.4.2`,
     run after step 1 so its install can build the allowlisted packages. On the development machine
     it matches the `pnpm` entry in `~/.cache/node/corepack/lastKnownGood.json`, which begins
     `12.4.2+sha512.08adc661`; stop and report if they differ.
   - `engines.node` is `^24.15.0`.
   - Each `npm run` in `verify` becomes `pnpm run`.
3. `.prettierignore`: replace `package-lock.json` with `pnpm-lock.yaml`. `playwright.config.ts`:
   `webServer.command` becomes `pnpm run build && pnpm run seed:demo && pnpm run start`.
4. `.husky/pre-commit` and `.husky/commit-msg`: `npx` becomes `pnpm exec`, and `npm run` becomes
   `pnpm run`. Keep the nvm `PATH` line: corepack's `pnpm` shim lives in the nvm Node `bin`
   directory it adds. The open-source release later replaces that line with a portable one that
   still finds the shim.
5. `scripts/db-backup.ts` and `scripts/db-restore.ts`: drop one leading `--` from the arguments
   before validating them, and change the usage lines to `pnpm run db:backup [<file>]` and
   `pnpm run db:restore <backup file>`. Cover both forms in `tests/integration/db-backup.test.ts`,
   and update its `usage: npm run db:restore` expectation.
6. Command text in code:
   - `scripts/install-claude-statusline.ts`: the header examples and the printed
     `--wrap-existing` and `--print` hints become `pnpm run claude:install-statusline` without
     `--`.
   - `src/app/page.tsx`, `src/app/api/providers/[provider]/refresh/route.ts`,
     `src/lib/db/backup.ts`, `src/lib/ingestors/claude-statusline.ts`,
     `scripts/install-systemd.sh`, the `systemd/ai-usage-dashboard-web.service.template` comment,
     `.env.example`, and code comments.
   - `src/lib/db/migrations.generated.ts` takes its header from `scripts/build-migrations.ts`:
     change the generator, then run `pnpm run db:build-migrations`, so the byte-for-byte guard in
     `tests/unit/migrations-sync.test.ts` still holds.
   - Rename the `describe` titles that quote `npm run` in
     `tests/integration/collect-script.test.ts` and `tests/integration/next-wrapper.test.ts`.
7. Documents:
   - `README.md` and `AGENTS.md`: every command, Node 24.15 or a later Node 24 release and
     `corepack enable pnpm` in the README quick start, and "npm single-package repo".
   - Setup §1: the Node requirement, `corepack enable pnpm`, then `pnpm install` and its approval
     text.
   - Setup §3 and §6: every `claude:install-statusline` command without `--`, including the §3
     "Re-running `-- --apply`" sentence, and no advice to keep the `--`.
   - Setup §10's install-script entry for `pnpm approve-builds`, noting that approvals stay pinned
     to exact versions.
   - Setup §6 deploy:
     - The preflight, before any unit stops, reads the candidate's `package.json` with
       `git show "$CANDIDATE:package.json"` into a temporary directory. When it pins a
       `packageManager`, the preflight runs `corepack install` there and requires `pnpm --version`
       there to print the pinned version. Any failure clears `CANDIDATE`, so no unit stops.
     - Step 3 installs with `pnpm install --frozen-lockfile`.
   - Setup §6 rollback: check out the target, then run `pnpm install --frozen-lockfile` when it has
     `pnpm-lock.yaml`, or `npm ci` when it has only `package-lock.json`. If step 8 shows that pnpm
     refuses an npm-built `node_modules` without a terminal, remove `node_modules` before installing.
   - Plan §4.1 names pnpm and `pnpm-lock.yaml`, and §3.3, §3.4, and §3.5 give pnpm commands.
   - `docs/backlog/template.md` Testing section, and the Acceptance Criteria and Testing of the
     Tailscale brief.
8. Rehearse the deploy in a throwaway clone with its own empty `COREPACK_HOME` and standard input
   closed:
   - Install with `npm ci`, then run the §6 preflight against the pnpm commit and confirm it caches
     pnpm 12.4.2.
   - Check out the pnpm commit and run the §6 install command.
   - Check out a pre-migration commit and run `npm ci` to rehearse the rollback.
   - Fix the runbook from what happened.
9. Deploy to the production checkout with the updated §6 procedure, which records the previous and
   candidate commits. If any step fails, roll back to the previous commit with the §6 rollback
   procedure and report it.
10. Record the delivery as an `Update` in `docs/log.md` that names the corepack step and the Node
    range for existing installs. Then `git mv` this brief to `docs/backlog/archive/`, set its status
    to `Archived`, and repoint every link to it, including the 2026-09-15 `Decision` and `Proposed`
    entries in `docs/log.md`.

## Files Touched

| Path                                                                    | Change                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `package.json`                                                          | Remove `allowScripts`; hashed `packageManager`; `engines.node` `^24.15.0`; `verify` uses pnpm |
| `pnpm-workspace.yaml`                                                   | Added: `allowBuilds` for the four native packages at exact versions                           |
| `pnpm-lock.yaml`, `package-lock.json`                                   | Added from `pnpm import`; removed                                                             |
| `.prettierignore`                                                       | Ignore `pnpm-lock.yaml` instead of `package-lock.json`                                        |
| `playwright.config.ts`                                                  | `webServer.command` uses pnpm                                                                 |
| `.husky/pre-commit`, `.husky/commit-msg`                                | `pnpm exec` and `pnpm run`                                                                    |
| `scripts/db-backup.ts`, `scripts/db-restore.ts`                         | Accept a leading `--`; pnpm usage lines                                                       |
| `scripts/install-claude-statusline.ts`                                  | Header examples and printed hints use pnpm without `--`                                       |
| `scripts/build-migrations.ts`, `src/lib/db/migrations.generated.ts`     | Header command text; regenerated                                                              |
| `scripts/install-systemd.sh`, `scripts/next.ts`, `scripts/seed-demo.ts` | Messages and comments                                                                         |
| `systemd/ai-usage-dashboard-web.service.template`                       | Build comment uses pnpm                                                                       |
| `src/app/page.tsx`, `src/app/api/providers/[provider]/refresh/route.ts` | User-visible command text                                                                     |
| `src/lib/db/backup.ts`, `src/lib/ingestors/claude-statusline.ts`        | User-visible command text                                                                     |
| `src/lib/config.ts`, `src/lib/env-file.ts`, `src/lib/paths.ts`          | Comments                                                                                      |
| `src/lib/dev-environment.ts`                                            | Comments                                                                                      |
| `tests/integration/db-backup.test.ts`                                   | Usage expectation; both argument forms                                                        |
| `tests/integration/collect-script.test.ts`, `next-wrapper.test.ts`      | `describe` titles                                                                             |
| `tests/live/live-smoke.test.ts`, `vitest.live.config.ts`                | Comments                                                                                      |
| `.env.example`                                                          | Comments                                                                                      |
| `README.md`, `AGENTS.md`                                                | Commands, Node requirement, corepack step, and repository description                         |
| `docs/operations/setup.md`                                              | §1, §2, §3, §4, §6 (preflight, deploy, rollback, boundary), §7, §9, §10                       |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`                   | §4.1 package-manager decision; §3.3, §3.4, and §3.5 commands                                  |
| `docs/backlog/template.md`                                              | Testing section commands                                                                      |
| `docs/backlog/ready-for-human/access-dashboard-over-tailscale.md`       | Acceptance Criteria and Testing commands                                                      |
| `docs/log.md`                                                           | `Update` entry; links repointed to the archived brief                                         |
| `docs/backlog/ready-for-agent/migrate-from-npm-to-pnpm.md`              | `git mv` to `archive/` on delivery                                                            |

`CONTRIBUTING.md`, `.github/`, and `docs/operations/production-checkout.md` do not exist yet. The
open-source release creates them after this migration, with pnpm commands.

## Acceptance Criteria

- [ ] `package-lock.json` is gone, and on Node 24.19.0 a fresh clone completes
      `pnpm install --frozen-lockfile` without `ERR_PNPM_IGNORED_BUILDS` or an approval prompt,
      producing `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
- [ ] `pnpm-workspace.yaml` allows builds only for `@tailwindcss/oxide@4.1.13`,
      `better-sqlite3@12.4.1`, `esbuild@0.25.12`, and `unrs-resolver@1.12.2`, with no bare package
      name.
- [ ] `package.json` pins `packageManager` to `pnpm@12.4.2` with its sha512 hash and sets
      `engines.node` to `^24.15.0`. With an empty `COREPACK_HOME`, `pnpm --version` in the checkout
      prints `12.4.2`.
- [ ] `pnpm run verify`, `pnpm run build`, and `pnpm run test:e2e` pass, and `pnpm audit` reports no
      known vulnerabilities.
- [ ] `pnpm run db:backup <file>`, `pnpm run db:backup -- <file>`, `pnpm run db:restore <file>`, and
      `pnpm run db:restore -- <file>` behave identically, proven by integration tests.
- [ ] A commit touching a `.ts` file runs lint-staged, the typecheck, and `vitest related` through
      pnpm in the pre-commit hook.
- [ ] Plan §4.1 names pnpm and `pnpm-lock.yaml`, and the README and Setup §1 state the Node
      requirement and enable pnpm through corepack.
- [ ] Outside `docs/log.md`, `docs/backlog/archive/`, the plan's §0 baseline, M1, and §11, the
      implementation prompt, M0 Discovery, and `.mcp.json`, no tracked file tells the reader to run
      `npm` or `npx`, except the Setup §6 rollback to a commit that has only `package-lock.json`.
- [ ] The rehearsal from Approach step 8 succeeds with an empty `COREPACK_HOME` and standard input
      closed: the preflight caches pnpm 12.4.2 before any install step, and Setup §6 describes
      exactly what was run.
- [ ] In the production deploy, the preflight passes before any unit stops. Afterwards both units
      are active, the dashboard answers on its configured URL, and the next collector run succeeds.
- [ ] This brief is in `docs/backlog/archive/` with status `Archived`, and the OKF validator passes.

## Testing

- Focused: `pnpm exec vitest run tests/integration/db-backup.test.ts` and
  `pnpm exec vitest run tests/unit/migrations-sync.test.ts`.
- Fresh clone: `pnpm install --frozen-lockfile`, `pnpm run db:migrate`, and `pnpm run build`.
- Allowlist: remove one entry in a scratch copy and confirm `pnpm install --frozen-lockfile` fails
  with `ERR_PNPM_IGNORED_BUILDS` naming that package.
- Cold corepack cache: `COREPACK_HOME="$(mktemp -d)" pnpm --version </dev/null` in the checkout.
- The pre-commit hook, exercised by a throwaway commit that is then reset.
- The deploy and rollback rehearsal from Approach step 8, in a throwaway clone.
- `pnpm run test:e2e`, because `playwright.config.ts` changes.
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`.
- `pnpm run verify` is the final gate.
- Not verified: any Node release other than 24.19.0.
- Live, by the agent once the rehearsal passes: the production deploy and its checks. Report which
  were performed.

## Open Questions
