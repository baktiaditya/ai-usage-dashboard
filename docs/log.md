# Bundle Update Log

## 2026-09-12

- **Tooling**: Husky git hooks, copied from Kyomi-pos and adapted from Yarn to
  npm (`npx`/`npm run`; `commitlint.config.cjs` because this repo is
  `"type": "module"`). `pre-commit` runs lint-staged (Prettier), then
  `typecheck` plus related Vitest files in parallel when TS/TSX is staged;
  `commit-msg` enforces Conventional Commits with a 72-character subject cap.
  [Setup](operations/SETUP.md) documents the hooks.

- **Restructure**: the four flat documents move into topic folders — plan
  ([plan/](plan/index.md)), discovery ([discovery/](discovery/index.md)), operations
  ([operations/](operations/index.md)) — each with its own `index.md`. No content
  changes; every intra-bundle link, code comment, and entry-point reference
  (`README.md`, `AGENTS.md`, `okf-sync` skill, sync map, backlog brief) follows the
  move. The bundle is no longer flat: each folder carries its own navigation list.
- **Initialization**: `docs/` becomes an OKF v0.1 bundle rooted at itself. New:
  [index](index.md) (root navigation, holds `okf_version`), this log, and
  [backlog/](backlog/index.md) with its brief template and four status folders.
  The four existing documents stay flat where they are — the bundle is small and
  needs no subfolders yet. Canonical authority: the
  [Implementation Plan](plan/AI_Usage_Dashboard_Implementation_Plan.md) for scope and
  contracts, [M0 Discovery](discovery/M0_DISCOVERY.md) for what is live-verified vs
  fixture-tested, [Setup](operations/SETUP.md) for operations. The
  [`okf-sync`](../.agents/skills/okf-sync/SKILL.md) skill and its validator keep
  the bundle coherent. First brief filed:
  [provision-provider-credentials](backlog/ready-for-human/provision-provider-credentials.md)
  — the two remaining live gates (DeepSeek, OpenRouter) wait on human-provisioned
  keys.
