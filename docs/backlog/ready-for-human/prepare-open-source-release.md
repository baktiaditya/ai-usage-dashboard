# Prepare the repository for an open-source release

## Status

Ready for human

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The GitHub repository can be made public. It carries a clear license, no tracked file names the
maintainer's machine or account, the README states the supported platform and that the project is
not affiliated with any provider, and an outside user or contributor finds the minimum surface
they need: CI, a contributing guide, and a security policy. Runtime behavior and the security
posture do not change, apart from the timezone default if the user decides to change it.

## Context

An open-source readiness assessment on 2026-09-15, at `e1d6923`, found the code itself ready:

- `npm run verify` passes (29 test files, 432 tests), and `npm audit` reports 0 vulnerabilities.
- A fresh clone with an empty `HOME` and data directory completes `npm ci`, `npm run db:migrate`,
  `npm run collect`, and `next build`. Unconfigured providers are recorded as `unavailable` or as
  a provider error, and the run does not fail.
- A scan of the full git history for key shapes (`sk-`, `sk-or-v1-`, `AKIA`, `ghp_`, private-key
  blocks) matched only fake values in tests. No environment, database, or credential file was
  ever tracked, and `tests/fixtures/` holds no email, UUID, or home path.

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
     entries of [log](../../log.md) and in
     [separate-production-checkout](../archive/separate-production-checkout.md).
   - [Setup](../../operations/setup.md) §6 clones over SSH, which needs a GitHub SSH key that
     outside users will not have for this repository.
   - `loadConfig` in `src/lib/config.ts` defaults `AUD_TIMEZONE` to `Asia/Jakarta`. The plan's
     "today" boundary rule (§3.2) fixes that default, and Setup §7 documents it. The dated
     `Asia/Jakarta` baselines in the plan and in
     [M0 Discovery](../../discovery/m0-discovery.md) are observations and can stay.
3. **Affiliation and interface stability are unstated.** The README names Codex, Claude Code,
   DeepSeek, and OpenRouter and the dashboard renders their marks, with no statement that the
   project is unaffiliated. Codex is read through `codex app-server` JSON-RPC and Claude through
   the status-line bridge. The README lists the live-verified versions but does not say these
   interfaces may change without notice.
4. **Maintainer-only content.** Much of the tracked tree serves the maintainer's machine and agent
   workflow rather than a user:
   - `docs/log.md`, [the implementation prompt](../../plan/ai-usage-dashboard-implementation-prompt.md),
     and [access-dashboard-over-tailscale](access-dashboard-over-tailscale.md);
   - the production-checkout deploy and rollback runbook in Setup §6;
   - `AGENTS.md`, which assumes code-review-graph, `agent-browser`, and a machine-specific sysctl
     file, together with `.mcp.json`, `.claude/`, and `.agents/`.
5. **No contributor surface.** There is no `.github/` (no CI workflow, no issue templates), no
   `CONTRIBUTING.md`, no `SECURITY.md`, no changelog, and no release tag. A security policy
   matters here because the application handles an OpenRouter Management key.
6. **Platform scope is undocumented.** Scheduling relies on user systemd, and the restore guard in
   `src/lib/db/backup.ts` relies on `/proc`. Neither the README nor Setup says the project
   supports Linux only.
7. **Smaller items.**
   - The README credits "Node 24's JSON source-text access", while `engines.node` in
     `package.json` is `>=22.12.0` and there is no `.nvmrc`. The plan and M0 verified only Node
     24.19.0, so whether 22.12 works is unverified.
   - `.husky/pre-commit` prepends an nvm-specific `PATH`.
   - The README has no screenshot. `npm run seed:demo` can fill a database that shows no real
     account data.
   - Adding a provider means editing hard-coded lists, such as `PROVIDER_PATTERN` in
     `src/lib/config.ts`, and no guide describes the path.
   - Every commit carries the maintainer's author email, which becomes public with the repository.
     That is a choice, not a defect.

## Dependencies and Gates

- A license choice. MIT or Apache-2.0 fits a small tool. Owner: user.
- A decision on the timezone default: keep `Asia/Jakarta`, or follow the system timezone and fall
  back to UTC. A change needs a `Decision` in `docs/log.md` and an update to the plan's "today"
  boundary rule. Owner: user.
- A decision on each maintainer-only item in Context 4: keep as-is with a note, move it to a
  maintainer area, or remove it from the tree. Owner: user.
- A decision on the commit author email: accept it, or switch future commits to a GitHub noreply
  address. Rewriting history is not recommended, because it breaks existing clones, including the
  production checkout that pulls from `origin`. Owner: user.
- Changing the repository's visibility to public on GitHub. The effect is hard to reverse once
  forks, caches, or indexes exist. Owner: user.

## Scope

### In scope

- `LICENSE`, a third-party notice for Lobe Icons, and `package.json` metadata.
- Replacing maintainer paths in tracked docs with placeholders, and an HTTPS clone URL in Setup.
- The timezone default, following the decision, across code, tests, the plan, Setup §7, and
  `.env.example`.
- README additions: supported platform, a Node version consistent with `engines` and `.nvmrc`, a
  non-affiliation and interface-stability note, a screenshot from demo data, and links to the
  license, contributing guide, and security policy.
- `CONTRIBUTING.md`: the `npm run verify` gate, conventional commits, how to add a provider, and
  the agent tooling marked optional. `SECURITY.md`: private reporting through GitHub security
  advisories. GitHub issue templates.
- A GitHub Actions workflow running `npm ci` and `npm run verify` on pull requests and on pushes
  to `main`.
- Separating the user-facing setup from the maintainer runbook, as far as the Context 4 decision
  requires.
- A portable `PATH` line in `.husky/pre-commit`.
- A `CHANGELOG.md` and a first release tag.

### Out of scope

- macOS, Windows, or any scheduler other than user systemd.
- Publishing to npm.
- Any change to the bind policy, authentication, or public or multi-user access, which the plan
  excludes.
- Rewriting git history.
- The Tailscale brief itself.

## Approach

Provisional until the gates close.

1. Record the gate decisions in `docs/log.md`, and update the plan's "today" boundary rule if the
   timezone default changes.
2. Legal: add `LICENSE` and `THIRD_PARTY_NOTICES.md`, and set `license`, `repository`, `bugs`, and
   `homepage` in `package.json`.
3. Hygiene:
   - replace maintainer paths in `docs/log.md` and the archived brief with a placeholder such as
     `~/Workspace/ai-usage-dashboard-prod`, logged as a redaction rather than a decision change;
   - switch the Setup §6 clone URL to HTTPS;
   - change the timezone default in `src/lib/config.ts` and its tests if decided.
4. Node version: run the suite under Node 22.12. If it passes, add both versions to the CI matrix.
   Otherwise raise `engines.node` to `>=24`. Then add `.nvmrc` and correct the README sentence.
5. README: platform line, non-affiliation and interface-stability note, and a screenshot captured
   from `npm run seed:demo` data.
6. Contributor surface: `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, and
   `.github/workflows/ci.yml`.
7. Maintainer content: apply the Context 4 decision, and keep every in-bundle link valid.
8. Portability: remove the nvm assumption from `.husky/pre-commit`.
9. Release: add `CHANGELOG.md`, and tag after the checks below pass. The user changes visibility.

## Files Touched

Provisional; the Context 4 decision may add or remove entries.

| Path                                                   | Change                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `LICENSE`, `THIRD_PARTY_NOTICES.md`                    | New                                                  |
| `package.json`, `.nvmrc`                               | License and repository metadata; Node version        |
| `README.md`                                            | Platform, Node, disclaimer, screenshot, policy links |
| `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`       | New                                                  |
| `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/`  | New                                                  |
| `.husky/pre-commit`                                    | Portable `PATH`                                      |
| `src/lib/config.ts`, `tests/unit/config-time.test.ts`  | Timezone default, if decided                         |
| `.env.example`                                         | Timezone comment, if decided                         |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`  | "Today" boundary rule, if decided                    |
| `docs/operations/setup.md`                             | HTTPS clone URL; §7 timezone row; runbook split      |
| `docs/log.md`                                          | Path redaction; gate decisions                       |
| `docs/backlog/archive/separate-production-checkout.md` | Path redaction                                       |
| `AGENTS.md`, `.mcp.json`, `.claude/`, `.agents/`       | Per the Context 4 decision                           |

## Acceptance Criteria

- [ ] `LICENSE` exists at the root, `package.json` `license` names the same SPDX identifier, and
      GitHub detects the license.
- [ ] The Lobe Icons MIT notice ships in `THIRD_PARTY_NOTICES.md`.
- [ ] No tracked file names the maintainer's home directory, username, or SSH remote. Generic
      placeholders such as `/home/you` remain.
- [ ] The timezone default is the same in `src/lib/config.ts`, its tests, the plan, Setup §7, and
      `.env.example`.
- [ ] The README states the supported platform, a Node version matching `engines` and `.nvmrc`,
      non-affiliation, and the interface-stability caveat, and shows a screenshot free of real
      account data.
- [ ] `CONTRIBUTING.md` and `SECURITY.md` exist and are linked from the README.
- [ ] The CI workflow runs `npm run verify` on a pull request and passes.
- [ ] A fresh clone with an empty `HOME`, following only the README, completes install, migrate,
      collect, build, and start.
- [ ] A full-history secret scan at the release head matches only test fakes.
- [ ] `npm run verify` and the OKF validator pass.

## Testing

- Focused: `npx vitest run tests/unit/config-time.test.ts` if the timezone default changes.
- Hygiene: `git grep -nE '/home/[a-z]+|/Users/[a-z]+|git@github\.com'` reviewed by hand, plus the
  full-history key scan from Context.
- Fresh clone in a scratch directory with `HOME` and `AUD_DATA_DIR` pointed there: `npm ci`,
  `npm run db:migrate`, `npm run collect`, `npm run build`, `npm run start`.
- CI: the workflow run on the pull request that adds it.
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py` for the docs changes.
- `npm run verify` is the final gate. Changing repository visibility is done by the user and is
  not verified by an agent.

## Open Questions

- MIT or Apache-2.0? Owner: user.
- Keep the `Asia/Jakarta` timezone default, or follow the system timezone? Owner: user.
- For each maintainer-only item in Context 4, keep, move, or remove? Owner: user.
- Keep the current author email in commits, or switch future commits to a noreply address?
  Owner: user.
- Should CI also run `npm run test:e2e`? It needs Playwright browsers and adds run time. Owner:
  user.
