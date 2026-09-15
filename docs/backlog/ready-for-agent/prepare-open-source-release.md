# Prepare the repository for an open-source release

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The GitHub repository can be made public. It carries an MIT license, no tracked file names the
maintainer's machine or account, the README states the supported platform and that the project is
not affiliated with any provider, and an outside user or contributor finds the minimum surface
they need: CI, a contributing guide, and a security policy. Runtime behavior and the security
posture do not change, apart from the timezone default, which follows the system timezone.

## Context

An open-source readiness assessment on 2026-09-15, at `e1d6923`, found the code itself ready. It
was re-run the same day against `e2d553c`, after provider keys moved into the database (#9), and
the findings below reflect that head:

- `npm run verify` passes (34 test files, 495 tests), and `npm audit` reports 0 vulnerabilities.
- A fresh clone with an empty `HOME` and data directory completes `npm ci`, `npm run db:migrate`,
  `npm run collect`, and `next build`. Every provider is recorded: DeepSeek and OpenRouter as
  `unavailable` (`not_configured`, since no key is saved in Settings), Claude as `unavailable`
  (`no_event_yet`), and an unauthenticated Codex as a provider error. The run completes, and
  `npm run collect` exits `1` by design whenever any provider records an error.
- These checks ran with npm. The pnpm migration lands before this brief is worked (see Dependencies
  and Gates), so the checks under Testing run with pnpm.
- A scan of the full git history for key shapes (`sk-`, `sk-or-v1-`, `AKIA`, `ghp_`, private-key
  blocks) matched only fake values in tests, including those added with #9. No environment,
  database, or credential file was ever tracked, and `tests/fixtures/` holds no email, UUID, or
  home path.

Publishing the source does not touch the plan's non-goal "Public or multi-user access"
([plan](../../plan/ai-usage-dashboard-implementation-plan.md) §10). The dashboard stays a
loopback-only, single-user application; only its code becomes public.

The assessment found these gaps:

1. **No license.** There is no `LICENSE` file, and `package.json` has no `license`, `repository`,
   `bugs`, or `homepage` field. `"private": true` only blocks npm publication and can stay. The
   provider marks in `src/components/provider-logo.tsx` come from Lobe Icons (MIT, © LobeHub).
   MIT requires its notice to ship with copies, and today it lives only in a code comment.
2. **Maintainer-specific detail in tracked files.**
   - The maintainer's absolute home path to the production checkout appears in two 2026-09-14
     entries of [log](../../log.md) and in the archived briefs
     [separate-production-checkout](../archive/separate-production-checkout.md) and
     [store-provider-keys-in-settings](../archive/store-provider-keys-in-settings.md).
   - [Setup](../../operations/setup.md) §6 clones over SSH, which needs a GitHub SSH key that
     outside users will not have for this repository.
   - `loadConfig` in `src/lib/config.ts` defaults `AUD_TIMEZONE` to `Asia/Jakarta`, and Setup §7
     and `.env.example` document that default. Plan §3.2 now requires the system timezone instead
     (see Dependencies and Gates). The dated `Asia/Jakarta` baselines in the plan and in
     [M0 Discovery](../../discovery/m0-discovery.md) are observations and stay.
3. **Affiliation and interface stability are unstated.** The README names Codex, Claude Code,
   DeepSeek, and OpenRouter and the dashboard renders their marks, with no statement that the
   project is unaffiliated. Codex is read through `codex app-server` JSON-RPC and Claude through
   the status-line bridge. The README lists the live-verified versions but does not say these
   interfaces may change without notice.
4. **Maintainer-only content.** Much of the tracked tree serves the maintainer's machine and agent
   workflow rather than a user:
   - `docs/log.md`, [the implementation prompt](../../plan/ai-usage-dashboard-implementation-prompt.md),
     and [access-dashboard-over-tailscale](../ready-for-human/access-dashboard-over-tailscale.md);
   - the production-checkout deploy and rollback runbook in Setup §6;
   - the Setup §4 "Upgrading from keys in `collector.env`" steps, which only an install that predates
     the Settings dialog needs;
   - `AGENTS.md`, which assumes code-review-graph, `agent-browser`, and a machine-specific sysctl
     file, together with `.mcp.json`, `.claude/`, and `.agents/`.
5. **No contributor surface.** There is no `.github/` (no CI workflow, no issue templates), no
   `CONTRIBUTING.md`, no `SECURITY.md`, no changelog, and no release tag. A security policy
   matters here because the application stores the DeepSeek API key and the OpenRouter Management
   key in plaintext in its owner-only (`0600`) SQLite database, `pnpm run db:backup` files contain
   them, and same-origin settings routes save and remove them.
6. **Platform scope is undocumented.** Scheduling relies on user systemd, and the restore guard in
   `src/lib/db/backup.ts` relies on `/proc`. Neither the README nor Setup says the project
   supports Linux only.
7. **Smaller items.**
   - The README credits "Node 24's JSON source-text access", while `engines.node` in
     `package.json` is `>=22.12.0` and there is no `.nvmrc`. The plan and M0 verified only Node
     24.19.0, so whether 22.12 works is unverified.
   - `.husky/pre-commit` and `.husky/commit-msg` prepend an nvm-specific `PATH`.
   - The README has no screenshot. `pnpm run seed:demo` can fill a database that shows no real
     account data.
   - Adding a provider means editing hard-coded lists, such as `PROVIDER_PATTERN` in
     `src/lib/config.ts`, and no guide describes the path.
   - Every commit carries the maintainer's author email, which becomes public with the repository.
     The user accepted this.

## Dependencies and Gates

The user closed every gate on 2026-09-15, recorded as a `Decision` in [log](../../log.md):

- **License:** MIT.
- **Timezone default:** with `AUD_TIMEZONE` unset, the system timezone as Node resolves it, falling
  back to `UTC` when none resolves. [Plan](../../plan/ai-usage-dashboard-implementation-plan.md)
  §3.2 already states this. The development machine and production both resolve `Asia/Jakarta` and
  production sets no `AUD_TIMEZONE`, so production's day boundary does not move.
- **Maintainer-only content**, per Context 4 item:
  - `docs/log.md` stays; only the path redaction applies.
  - The implementation prompt stays, with a note at its top that it is a historical record.
  - The Tailscale brief stays in `ready-for-human/`.
  - The production-checkout deploy and rollback runbook moves out of Setup §6 into a new
    maintainer document, `docs/operations/production-checkout.md`.
  - The Setup §4 "Upgrading from keys in `collector.env`" steps stay, with a note that only an
    install predating the Settings dialog needs them.
  - `AGENTS.md`, `.mcp.json`, `.claude/`, and `.agents/` stay; `CONTRIBUTING.md` marks them
    optional.
- **Commit author email:** kept. History is not rewritten.
- **CI:** `pnpm run verify` only; `pnpm run test:e2e` stays a local check.
- **Package manager:** pnpm, provided through corepack, as the
  [npm to pnpm migration brief](https://github.com/baktiaditya/ai-usage-dashboard/pull/10) decides.
  That migration is a preceding change and lands first. Before starting, confirm that `main` has
  `pnpm-lock.yaml` and no `package-lock.json`; otherwise stop and report that the migration has not
  landed.

After delivery, outside agent scope: the user changes the repository's visibility to public. The
effect is hard to reverse once forks, caches, or indexes exist.

## Scope

### In scope

- An MIT `LICENSE`, a third-party notice for Lobe Icons, and `package.json` metadata.
- Replacing maintainer paths in tracked docs with placeholders, and an HTTPS clone URL in the
  runbook.
- The timezone default following the system timezone with a `UTC` fallback, across code, tests,
  Setup §7, and `.env.example`, and removing the pending note from plan §3.2.
- README additions: supported platform, a Node version consistent with `engines` and `.nvmrc`, a
  non-affiliation and interface-stability note, a screenshot from demo data, and links to the
  license, contributing guide, and security policy.
- `CONTRIBUTING.md`: enabling pnpm through corepack, the `pnpm run verify` gate, conventional
  commits, how to add a provider, and the agent tooling marked optional. `SECURITY.md`: private
  reporting through GitHub security advisories, and how saved keys are stored, backed up, and
  exposed. GitHub issue templates.
- A GitHub Actions workflow running `corepack enable pnpm`, `pnpm install --frozen-lockfile`, and
  `pnpm run verify` on pull requests and on pushes to `main`.
- Moving the production-checkout runbook into `docs/operations/production-checkout.md`, and adding
  the notes to the implementation prompt and the Setup §4 upgrade steps.
- A portable `PATH` line in `.husky/pre-commit` and `.husky/commit-msg`.
- A `CHANGELOG.md` and a first release tag.

### Out of scope

- macOS, Windows, or any scheduler other than user systemd.
- Publishing to npm.
- Any change to the bind policy, authentication, or public or multi-user access, which the plan
  excludes.
- Rewriting git history or changing the commit author email.
- Running `pnpm run test:e2e` in CI.
- The npm to pnpm migration itself, which lands before this brief.
- Removing the Setup §4 upgrade steps.
- The Tailscale brief itself.
- Changing the repository's visibility.

## Approach

1. Legal: add `LICENSE` with the MIT text, its copyright line naming the git author name, and
   `THIRD_PARTY_NOTICES.md` with the Lobe Icons MIT notice. Set `license` to `MIT` and
   `repository`, `bugs`, and `homepage` to the GitHub repository in `package.json`.
2. Timezone:
   - In `loadConfig`, when `AUD_TIMEZONE` is unset or empty, use
     `Intl.DateTimeFormat().resolvedOptions().timeZone`; if that is empty or fails
     `validateTimezone`, use `UTC`. An explicit invalid `AUD_TIMEZONE` still throws `ConfigError`.
   - Make the default assertion in `tests/unit/config-time.test.ts` independent of the host: stub
     the resolved zone for a valid zone, an empty one, and an invalid one. Tests that set
     `AUD_TIMEZONE` or pass `Asia/Jakarta` explicitly (`tests/helpers/db.ts`,
     `playwright.config.ts`, `tests/unit/env-file.test.ts`, `tests/unit/provider-card.test.tsx`,
     and the `startOfLocalDayUtc` cases) keep it, because they pin a value rather than the default.
   - Describe the new default in the Setup §7 row and the `.env.example` comment, and remove the
     pending note from plan §3.2.
3. Hygiene: replace maintainer paths in `docs/log.md` and the two archived briefs with a
   placeholder such as `~/Workspace/ai-usage-dashboard-prod`, logged as a redaction rather than a
   decision change.
4. Node version: run the suite under Node 22.12. If it passes, add both versions to the CI matrix.
   Otherwise raise `engines.node` to `>=24`. Then add `.nvmrc` and correct the README sentence.
5. README: platform line, non-affiliation and interface-stability note, and a screenshot captured
   from `pnpm run seed:demo` data.
6. Contributor surface: `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, and
   `.github/workflows/ci.yml` running `corepack enable pnpm`, `pnpm install --frozen-lockfile`, and
   `pnpm run verify`. `package.json` already pins `packageManager`, so corepack selects that pnpm
   version.
7. Maintainer content:
   - Create `docs/operations/production-checkout.md` with concept frontmatter, move the Setup §6
     "Production checkout: deploy and rollback" subsection into it, and switch its clone URL to
     HTTPS. Leave a one-line pointer in Setup §6.
   - Repoint the Setup references that send the reader to §6 for the production checkout, link the
     new document from `docs/operations/index.md`, and add it to
     `.agents/skills/okf-sync/references/repo-sync-map.md`. Dated log entries and archived briefs
     keep their wording.
   - Add the historical-record note to the implementation prompt and the install-predates-Settings
     note to the Setup §4 upgrade steps.
8. Portability: remove the nvm assumption from `.husky/pre-commit` and `.husky/commit-msg`. The
   hooks must still find `node` and corepack's `pnpm` shim without an nvm-specific path.
9. Release: add `CHANGELOG.md`, record the delivery in `docs/log.md`, `git mv` this brief to
   `archive/`, and tag after the checks below pass.

## Files Touched

| Path                                                          | Change                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `LICENSE`, `THIRD_PARTY_NOTICES.md`                           | New                                                  |
| `package.json`, `.nvmrc`                                      | License and repository metadata; Node version        |
| `README.md`                                                   | Platform, Node, disclaimer, screenshot, policy links |
| `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`              | New                                                  |
| `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/`         | New                                                  |
| `.husky/pre-commit`, `.husky/commit-msg`                      | Portable `PATH`                                      |
| `src/lib/config.ts`, `tests/unit/config-time.test.ts`         | System timezone default with `UTC` fallback          |
| `.env.example`                                                | Timezone comment                                     |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`         | Remove the §3.2 pending note                         |
| `docs/plan/ai-usage-dashboard-implementation-prompt.md`       | Historical-record note                               |
| `docs/operations/setup.md`                                    | §4 upgrade note; §6 runbook pointer; §7 timezone row |
| `docs/operations/production-checkout.md`                      | New; runbook moved from Setup §6, HTTPS clone URL    |
| `docs/operations/index.md`                                    | Link the runbook                                     |
| `.agents/skills/okf-sync/references/repo-sync-map.md`         | Add the runbook                                      |
| `docs/log.md`                                                 | Path redaction; delivery entry                       |
| `docs/backlog/archive/separate-production-checkout.md`        | Path redaction                                       |
| `docs/backlog/archive/store-provider-keys-in-settings.md`     | Path redaction                                       |
| `docs/backlog/ready-for-agent/prepare-open-source-release.md` | `git mv` to `archive/` on delivery                   |

## Acceptance Criteria

- [ ] `LICENSE` holds the MIT text, `package.json` `license` is `MIT`, and GitHub detects the
      license.
- [ ] The Lobe Icons MIT notice ships in `THIRD_PARTY_NOTICES.md`.
- [ ] No tracked file names the maintainer's home directory, username, or SSH remote. Generic
      placeholders such as `/home/you` remain.
- [ ] With `AUD_TIMEZONE` unset, the configured timezone is the zone Node resolves, or `UTC` when
      that is empty or invalid; an invalid explicit `AUD_TIMEZONE` still fails. Plan §3.2, Setup §7,
      and `.env.example` describe the same default, and plan §3.2 carries no pending note.
- [ ] The README states the supported platform, a Node version matching `engines` and `.nvmrc`,
      non-affiliation, and the interface-stability caveat, and shows a screenshot free of real
      account data.
- [ ] `CONTRIBUTING.md` and `SECURITY.md` exist and are linked from the README; `SECURITY.md`
      covers how saved keys are stored and backed up.
- [ ] The CI workflow installs with `pnpm install --frozen-lockfile` through corepack and runs
      `pnpm run verify`, and no end-to-end suite, on a pull request and passes.
- [ ] The production-checkout runbook lives in `docs/operations/production-checkout.md`, is linked
      from the operations index and Setup §6, and no current document points to its old location.
- [ ] The implementation prompt and the Setup §4 upgrade steps carry their notes.
- [ ] A fresh clone with an empty `HOME`, following only the README, completes install, migrate,
      collect, build, and start.
- [ ] A full-history secret scan at the release head matches only test fakes.
- [ ] `pnpm run verify` and the OKF validator pass.

## Testing

- Focused: `pnpm exec vitest run tests/unit/config-time.test.ts`, then the same run under `TZ=UTC` and
  `TZ=America/New_York` to prove the default follows the host.
- Hygiene: `git grep -nE '/home/[a-z]+|/Users/[a-z]+|git@github\.com'` reviewed by hand, plus the
  full-history key scan from Context.
- Links: the OKF validator, and `git grep -n 'Production checkout: deploy and rollback'` matching
  only the new document and dated history.
- Fresh clone in a scratch directory with `HOME` and `AUD_DATA_DIR` pointed there:
  `corepack enable pnpm`, `pnpm install --frozen-lockfile`, `pnpm run db:migrate`,
  `pnpm run collect`, `pnpm run build`, `pnpm run start`.
- `pnpm run test:e2e` in the development checkout, never the production checkout, because the
  configuration default feeds the web server.
- CI: the workflow run on the pull request that adds it.
- `pnpm run verify` is the final gate. Changing repository visibility is done by the user and is
  not verified by an agent.

## Open Questions
