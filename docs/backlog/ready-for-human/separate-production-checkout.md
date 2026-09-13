# Serve production from its own checkout of `main`

## Status

Ready for human

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md`,
`docs/discovery/M0_DISCOVERY.md`, `docs/operations/SETUP.md`, or `docs/log.md`.

Related issue: none yet

## Objective

The collector timer and the dashboard web unit run from a dedicated checkout that tracks `main`.
Development in the working repository — branch switches, `npm install`, `npm run build` — can no
longer change what production serves, and deploying becomes an explicit pull, build, and restart.

## Context

Both units' `WorkingDirectory`, `ExecStart`, and `ReadWritePaths` are rendered from the repository
the installer runs in (`scripts/install-systemd.sh`, `scripts/render-systemd-units.ts`). Today
they point at the development repository.

The web unit serves `.next` from there and never builds on start
([Setup](../../operations/SETUP.md) §6). Two failures follow:

- `npm run build` on an unfinished branch replaces the running server's build mid-flight.
- A reboot serves whatever build was last left in `.next`.

[isolate-dev-server-from-production](isolate-dev-server-from-production.md) removes the port and
database collisions, but not this one.

## Dependencies and Gates

- PR #1 is merged into `main`, including the web unit and the installer's `--with-web` flag
  (committed in `f80c013`). Owner: user.
- Authorization to reinstall and restart both user units from the new checkout. Owner: user.

## Scope

### In scope

- Create the production checkout, install dependencies, build, and reinstall both units from it.
- A deploy and rollback runbook in Setup §6.

### Out of scope

- Code changes.
- CI/CD or automatic deploys.
- Moving the data directory: collection history stays where it is.

## Approach

1. Clone the repository to `~/Workspace/ai-usage-dashboard-prod` on `main`. A clone is preferred
   over `git worktree`, because a worktree cannot check out `main` while another worktree has it,
   and a clone keeps `node_modules` and `.next` fully independent.
2. In the production checkout, run `npm ci`, approve the native build scripts as Setup describes,
   and run `npm run build`.
3. Run `scripts/install-systemd.sh --install --enable --with-web` from the production checkout.
   - The installer re-renders `WorkingDirectory` and every path, and restarts the web unit.
   - The data directory and `collector.env` are unchanged, so history and keys carry over.
4. Verify (see Testing), then document the runbook in Setup §6:
   - **Deploy:** `git pull --ff-only && npm ci && npm run build && systemctl --user restart
ai-usage-dashboard-web.service`. The timer picks up new collector code on its next run.
   - **Rollback:** check out the previous commit, build, and restart.
5. Record the decision in `docs/log.md`.

## Files Touched

| Path                       | Change                               |
| -------------------------- | ------------------------------------ |
| `docs/operations/SETUP.md` | §6 deploy and rollback runbook       |
| `docs/log.md`              | `Decision` entry naming the checkout |

## Acceptance Criteria

- [ ] `systemctl --user show -p WorkingDirectory` for both `ai-usage-dashboard-web.service` and
      `ai-usage-dashboard-collector.service` names the production checkout.
- [ ] Units rendered from the production checkout are byte-identical to the installed units.
- [ ] `npm run build` in the development repository leaves the page served on 3838 unchanged,
      and both a manual refresh and the next timer run succeed.
- [ ] After a reboot, the dashboard answers on `127.0.0.1:3838` without a login.
- [ ] The OKF validator passes.

## Testing

Live checks:

- `systemctl --user show` for both units, and `cmp` between rendered and installed units.
- `curl` against `127.0.0.1:3838`.
- A manual refresh through `agent-browser` in a named session.
- Outcomes of the next timer run from `collector_runs` and `collector_attempts`.

Boot start needs a real reboot; state it explicitly if one is not performed. The OKF validator
covers the documentation change.

## Open Questions

- Is `~/Workspace/ai-usage-dashboard-prod` the production checkout location? Owner: user.
- A separate clone (recommended) or a `git worktree`? Owner: user.
