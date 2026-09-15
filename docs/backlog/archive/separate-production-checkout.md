# Serve production from its own checkout of `main`

## Status

Archived

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The collector timer and the dashboard web unit run from a dedicated checkout that deploys only
commits from `origin/main`. Development in the working repository — branch switches, `npm install`,
`npm run build` — can no longer change what production serves, and every deploy records an exact
candidate and previous commit for verification or rollback.

The production checkout is a deployment surface, not a release or development branch. No feature
work, hotfix commit, merge, or force-push originates there. Production bugs are fixed and verified
on `main`; production either moves forward to that fix or temporarily rolls back to an earlier
known-good commit from `main`.

## Context

Both units' `WorkingDirectory`, `ExecStart`, and `ReadWritePaths` are rendered from the repository
the installer runs in (`scripts/install-systemd.sh`, `scripts/render-systemd-units.ts`). Today
they point at the development repository.

The web unit serves `.next` from there and never builds on start
([Setup](../../operations/setup.md) §6). Two failures follow:

- `npm run build` on an unfinished branch replaces the running server's build mid-flight.
- A reboot serves whatever build was last left in `.next`.

[isolate-dev-server-from-production](../archive/isolate-dev-server-from-production.md)
removed the port and
database collisions, but not this one.

## Dependencies and Gates

- Resolved: PR #1 is merged into `main` as `a695a09`, including the web unit and the installer's
  `--with-web` flag (introduced in `f80c013`).
- Resolved: the production checkout is a separate clone at
  `/home/bago/Workspace/ai-usage-dashboard-prod`.
- Resolved: brief dashboard and collection downtime during deploy and rollback is acceptable.
- Resolved: the user authorizes creating the production clone, reinstalling and restarting both
  user units from it, and performing the rollback rehearsal required by this brief.

## Scope

### In scope

- Create the production checkout, install dependencies, build, and reinstall both units from it.
- A deploy and rollback runbook in Setup §6.

### Out of scope

- Code changes.
- CI/CD or automatic deploys.
- Moving the data directory: collection history stays where it is.

## Approach

1. Clone the repository to `~/Workspace/ai-usage-dashboard-prod`. A clone is preferred over a
   linked `git worktree`: both give `node_modules` and `.next` separate working directories, but a
   clone also avoids Git's same-branch checkout restriction and does not share repository config,
   refs, or worktree administration with the development repository.
2. In the production checkout, run `npm ci`, approve the native build scripts as Setup describes,
   run `npm run verify`, and run `npm run build` at the current `origin/main` commit.
3. Run `scripts/install-systemd.sh --install --enable --with-web` from the production checkout.
   - The installer re-renders `WorkingDirectory` and every path, and restarts the web unit.
   - The data directory and `collector.env` are unchanged, so history and keys carry over.
4. Verify (see Testing), then document the runbook in Setup §6:
   - **Preflight:** require a clean production checkout; fetch `origin/main`; resolve and record the
     candidate SHA and the currently deployed SHA; require the candidate to be reachable from
     `origin/main`.
   - **Deploy with brief downtime:** stop the collector timer, wait for or stop any active collector
     service, and stop the web unit before changing source, dependencies, or `.next`; detach at the
     candidate SHA; run `npm ci`, `npm run verify`, and `npm run build`; reinstall both units from
     that checkout; then start the timer and web unit.
   - **Failure:** if install, verification, or build fails after the units stop, do not start the
     partial candidate. Run the rollback procedure for the recorded previous SHA.
   - **Rollback:** stop the timer, any active collector service, and the web unit; detach at the
     recorded known-good SHA; run `npm ci`, `npm run build`, and reinstall both units; then start and
     verify them. A later deploy repeats the normal fetch-and-detach flow from `origin/main`.
5. Record the decision in `docs/log.md`.

## Files Touched

| Path                       | Change                               |
| -------------------------- | ------------------------------------ |
| `docs/operations/setup.md` | §6 deploy and rollback runbook       |
| `docs/log.md`              | `Decision` entry naming the checkout |

## Acceptance Criteria

- [ ] `systemctl --user show -p WorkingDirectory` for both `ai-usage-dashboard-web.service` and
      `ai-usage-dashboard-collector.service` names the production checkout.
- [ ] Units rendered from the production checkout are byte-identical to the installed units.
- [ ] The production checkout is clean, its deployed `HEAD` is recorded, and that commit is
      reachable from `origin/main`; it contains no production-only commits.
- [ ] A deploy cannot run the collector against partially updated source/dependencies or let the
      web unit serve `.next` while it is being replaced.
- [ ] A rollback rehearsal returns both units to the recorded known-good SHA with the dependencies,
      build, and rendered units from that same SHA.
- [ ] `npm run build` in the development repository leaves the page served on 3838 unchanged,
      and both a manual refresh and the next timer run succeed.
- [ ] After a reboot, the dashboard answers on `127.0.0.1:3838` without a login.
- [ ] The OKF validator passes.

## Testing

Live checks:

- `systemctl --user show` for both units, and `cmp` between rendered and installed units.
- `git status --short`, `git rev-parse HEAD`, and `git merge-base --is-ancestor HEAD origin/main`
  in the production checkout.
- `curl` against `127.0.0.1:3838`.
- A manual refresh through `agent-browser` in a named session.
- Outcomes of the next timer run from `collector_runs` and `collector_attempts`.
- One rollback rehearsal using the recorded pre-deploy SHA, followed by redeploying the candidate.

Boot start needs a real reboot; state it explicitly if one is not performed. The OKF validator
covers the documentation change.

## Open Questions
