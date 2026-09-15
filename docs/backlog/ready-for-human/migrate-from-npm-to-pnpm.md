# Migrate the package manager from npm to pnpm

## Status

Ready for human

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The repository installs, runs, tests, and deploys with pnpm instead of npm. A fresh clone needs one
pinned pnpm version and `pnpm install --frozen-lockfile`. The native build allowlist carries over,
so no install prompts for approval. Every command in the README, Setup, `AGENTS.md`, the git hooks,
and user-visible messages names pnpm. The production checkout deploys and rolls back with the tool
that matches the lockfile of the commit it checks out. Runtime behavior does not change.

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
2. **The build allowlist moves.** `allowScripts` in `package.json` becomes `allowBuilds` in
   `pnpm-workspace.yaml`. Its `esbuild@0.28.2` entry matches nothing in the current lockfile, which
   resolves only `esbuild@0.25.12`.
3. **How pnpm is provided.** On the development machine, `pnpm` is corepack's shim inside the
   nvm-managed Node 24. Node 25 and later no longer bundle corepack, so a pinned
   `packageManager` field alone does not guarantee pnpm on a future Node.
4. **Deploying across the migration boundary.** The production deploy in
   [Setup](../../operations/setup.md) §6 runs `npm ci`. The first pnpm deploy meets a
   `node_modules` that npm laid out. The trial did not check whether pnpm replaces it without a
   terminal, as the runbook runs. Rolling back to a commit from before the migration needs `npm ci`
   again, because that commit has no `pnpm-lock.yaml`.
5. **Command text is widespread.** `npm` or `npx` appears in `package.json` (`verify`),
   `playwright.config.ts` (`webServer.command`), `.husky/pre-commit` and `.husky/commit-msg`,
   `.env.example`, `scripts/install-systemd.sh`, the usage lines of `scripts/db-backup.ts` and
   `scripts/db-restore.ts`, user-visible messages in `src/app/page.tsx`,
   `src/app/api/providers/[provider]/refresh/route.ts`, `src/lib/db/backup.ts`, and
   `src/lib/ingestors/claude-statusline.ts`, and code comments. In the documents, it appears 18
   times in `README.md`, 4 in `AGENTS.md`, and 58 in Setup (§1, §2, §3, §4, §6, §7, §9, §10).
6. **The plan pins npm.** [Plan](../../plan/ai-usage-dashboard-implementation-plan.md) §4.1 names
   "npm + `package-lock.json`" as the repository-pinned package manager, and its dated §0 baseline
   row recommends the same. §3.3, §3.4, and §3.5 give `npm run` commands as part of the contract.
   The plan wins over this brief until a logged `Decision` changes §4.1.

The benefit for a single-package application is moderate: faster installs, one store shared by the
development repository and the production checkout, build scripts blocked unless approved, and a
strict `node_modules`. Most of the cost is text, plus the deploy and rollback procedure.

The [open-source release brief](https://github.com/baktiaditya/ai-usage-dashboard/pull/7), open in
PR #7 and not yet on `main`, rewrites the README, moves the Setup §6 runbook into
`docs/operations/production-checkout.md`, and adds `CONTRIBUTING.md` and a CI workflow that runs
`npm run verify`. Both changes touch the same commands and files.

## Dependencies and Gates

- **A `Decision` superseding plan §4.1**, recorded in `docs/log.md`, that pnpm and
  `pnpm-lock.yaml` replace npm and `package-lock.json`. Owner: user.
- **Order relative to the open-source release.** Migrate before the release, so the first public
  README, contributing guide, and CI already use pnpm, or after it, and rewrite those surfaces a
  second time. Owner: user.
- **How pnpm is installed** on the development machine and for the production checkout: corepack
  (bundled with Node 24 only), pnpm's standalone installer, or `npm install -g pnpm` inside nvm.
  The choice decides the Setup §1 install step and whether `packageManager` is enforced. Owner:
  user.
- **Authorization to deploy** the first pnpm commit to the production checkout and to rehearse a
  rollback across the boundary. This stops both units. Owner: user.

## Scope

### In scope

- Converting the lockfile, the build allowlist, a pinned `packageManager`, and `.prettierignore`.
- Every command reference in scripts, hooks, Playwright, user-visible messages, code comments,
  `.env.example`, `README.md`, `AGENTS.md`, Setup, the backlog template, and the plan: its
  package-manager decision (§4.1) and current commands (§3.3, §3.4, §3.5).
- Accepting a leading `--` in `scripts/db-backup.ts` and `scripts/db-restore.ts`, so old and new
  command forms both work.
- The Setup §6 deploy and rollback procedure, including the migration boundary, and a `Decision`
  plus `Update` in `docs/log.md`.

### Out of scope

- Dependency upgrades, version changes, or new dependencies.
- A pnpm workspace or monorepo layout; `pnpm-workspace.yaml` holds only settings.
- Rewriting history: dated `docs/log.md` entries, archived briefs, the plan §0 machine baseline and
  its dated recommendation, the plan's M1 and §11 execution history, and the
  [M0 Discovery](../../discovery/m0-discovery.md) baseline and gate evidence keep `npm`.
- `.mcp.json`, whose `npx` launches external MCP servers rather than project dependencies.
- Anything the open-source release brief owns, beyond the command text it contains.

## Approach

1. On a branch from `main`, run `pnpm import`, delete `package-lock.json`, and create
   `pnpm-workspace.yaml` with `allowBuilds` for `@tailwindcss/oxide`, `better-sqlite3`, `esbuild`,
   and `unrs-resolver`. Remove `allowScripts` from `package.json` and add
   `"packageManager": "pnpm@<version>"` for the version the gate chose. In `.prettierignore`, replace
   `package-lock.json` with `pnpm-lock.yaml`.
2. `package.json`: each `npm run` in `verify` becomes `pnpm run`. `playwright.config.ts`:
   `webServer.command` becomes `pnpm run build && pnpm run seed:demo && pnpm run start`.
3. `.husky/pre-commit` and `.husky/commit-msg`: `npx` becomes `pnpm exec`, and `npm run` becomes
   `pnpm run`. Keep the nvm `PATH` line, unless the install gate puts pnpm elsewhere.
4. `scripts/db-backup.ts` and `scripts/db-restore.ts`: drop one leading `--` from the arguments
   before validating them, and change the usage lines to `pnpm run db:backup [<file>]` and
   `pnpm run db:restore <backup file>`. Cover both forms in `tests/integration/db-backup.test.ts`,
   and update its `usage: npm run db:restore` expectation.
5. Replace the command text in `src/app/page.tsx`, `src/app/api/providers/[provider]/refresh/route.ts`,
   `src/lib/db/backup.ts`, `src/lib/ingestors/claude-statusline.ts`, `scripts/install-systemd.sh`,
   `.env.example`, and code comments. `src/lib/db/migrations.generated.ts` takes its header from
   `scripts/build-migrations.ts`: change the generator, then run `pnpm run db:build-migrations`, so
   the byte-for-byte guard in `tests/unit/migrations-sync.test.ts` still holds. Rename the
   `describe` titles that quote `npm run` in `tests/integration/collect-script.test.ts` and
   `tests/integration/next-wrapper.test.ts`.
6. Documents:
   - `README.md` and `AGENTS.md`: every command, and "npm single-package repo".
   - Setup: §1 install and approval text, §3 `claude:install-statusline` without `--`, §10's
     install-script entry for `pnpm approve-builds`, and §6's deploy with
     `pnpm install --frozen-lockfile`.
   - Setup §6 rollback: check out the target, then run `pnpm install --frozen-lockfile` when it has
     `pnpm-lock.yaml`, or `npm ci` when it has only `package-lock.json`. If step 7 shows that pnpm
     refuses an npm-built `node_modules` without a terminal, remove `node_modules` before installing.
   - Plan §4.1 names pnpm and `pnpm-lock.yaml`, and §3.3, §3.4, and §3.5 give pnpm commands.
   - `docs/backlog/template.md` Testing section.
   - `docs/log.md`: a `Decision` for the switch and an `Update` for existing installs.
7. Rehearse the deploy in a throwaway clone: install with `npm ci`, check out the pnpm commit, and run
   the §6 install command with standard input closed. Then check out a pre-migration commit and run
   `npm ci` to rehearse the rollback. Fix the runbook from what happened.
8. With the deploy gate closed, deploy to the production checkout with the updated §6 procedure.

## Files Touched

| Path                                                                    | Change                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `package.json`                                                          | Remove `allowScripts`; add `packageManager`; `verify` uses pnpm        |
| `pnpm-workspace.yaml`                                                   | Added: `allowBuilds` for the four native packages                      |
| `pnpm-lock.yaml`, `package-lock.json`                                   | Added from `pnpm import`; removed                                      |
| `.prettierignore`                                                       | Ignore `pnpm-lock.yaml` instead of `package-lock.json`                 |
| `playwright.config.ts`                                                  | `webServer.command` uses pnpm                                          |
| `.husky/pre-commit`, `.husky/commit-msg`                                | `pnpm exec` and `pnpm run`                                             |
| `scripts/db-backup.ts`, `scripts/db-restore.ts`                         | Accept a leading `--`; pnpm usage lines                                |
| `scripts/build-migrations.ts`, `src/lib/db/migrations.generated.ts`     | Header command text; regenerated                                       |
| `scripts/install-systemd.sh`, `scripts/next.ts`, `scripts/seed-demo.ts` | Messages and comments                                                  |
| `src/app/page.tsx`, `src/app/api/providers/[provider]/refresh/route.ts` | User-visible command text                                              |
| `src/lib/db/backup.ts`, `src/lib/ingestors/claude-statusline.ts`        | User-visible command text                                              |
| `src/lib/config.ts`, `src/lib/env-file.ts`, `src/lib/paths.ts`          | Comments                                                               |
| `src/lib/dev-environment.ts`                                            | Comments                                                               |
| `tests/integration/db-backup.test.ts`                                   | Usage expectation; both argument forms                                 |
| `tests/integration/collect-script.test.ts`, `next-wrapper.test.ts`      | `describe` titles                                                      |
| `tests/live/live-smoke.test.ts`, `vitest.live.config.ts`                | Comments                                                               |
| `.env.example`                                                          | Comments                                                               |
| `README.md`, `AGENTS.md`                                                | Commands and repository description                                    |
| `docs/operations/setup.md`                                              | §1, §2, §3, §4, §6 (deploy, rollback, migration boundary), §7, §9, §10 |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`                   | §4.1 package-manager decision; §3.3, §3.4, and §3.5 commands           |
| `docs/backlog/template.md`                                              | Testing section commands                                               |
| `docs/log.md`                                                           | `Decision` and `Update` entries                                        |

If the open-source release lands first, add `CONTRIBUTING.md`, the CI workflow under `.github/`, and
`docs/operations/production-checkout.md`, and drop the Setup §6 rows that moved there.

## Acceptance Criteria

- [ ] `package-lock.json` is gone, and a fresh clone completes `pnpm install --frozen-lockfile`
      without `ERR_PNPM_IGNORED_BUILDS` or an approval prompt, producing
      `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.
- [ ] `pnpm run verify`, `pnpm run build`, and `pnpm run test:e2e` pass, and `pnpm audit` reports no
      known vulnerabilities.
- [ ] `pnpm run db:backup <file>`, `pnpm run db:backup -- <file>`, `pnpm run db:restore <file>`, and
      `pnpm run db:restore -- <file>` behave identically, proven by integration tests.
- [ ] A commit touching a `.ts` file runs lint-staged, the typecheck, and `vitest related` through
      pnpm in the pre-commit hook.
- [ ] Plan §4.1 names pnpm, and a `Decision` in `docs/log.md` records the change.
- [ ] Outside `docs/log.md`, `docs/backlog/archive/`, the plan's §0 baseline, M1, and §11, M0
      Discovery, and `.mcp.json`, no tracked file tells the reader to run `npm` or `npx`.
- [ ] The deploy and rollback rehearsal from Approach step 7 succeeds with standard input closed,
      and Setup §6 describes exactly what was run.
- [ ] After the gated production deploy, both units are active, the dashboard answers on its
      configured URL, and the next collector run succeeds.
- [ ] The OKF validator passes.

## Testing

- Focused: `pnpm exec vitest run tests/integration/db-backup.test.ts` and
  `pnpm exec vitest run tests/unit/migrations-sync.test.ts`.
- Fresh clone: `pnpm install --frozen-lockfile`, `pnpm run db:migrate`, and `pnpm run build`.
- The pre-commit hook, exercised by a throwaway commit that is then reset.
- The deploy and rollback rehearsal from Approach step 7, in a throwaway clone.
- `pnpm run test:e2e`, because `playwright.config.ts` changes.
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`.
- `pnpm run verify` is the final gate.
- Live, gated on the user: the production deploy and its checks. Report which were performed.

## Open Questions

- Does pnpm replace npm as the pinned package manager in plan §4.1? Owner: user.
- Should the migration land before or after the open-source release in PR #7? Owner: user.
- Which install method provides pnpm on the development machine and for the production checkout,
  given that Node 25 and later drop corepack? Owner: user.
