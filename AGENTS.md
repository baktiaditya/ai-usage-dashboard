# AGENTS.md

npm single-package repo for the AI Usage Dashboard. Product overview and commands live in
`README.md`; setup, credentials, and the systemd timer live in `docs/operations/SETUP.md`; the current
implementation lives in `src/`.

<!-- code-review-graph MCP tools -->

## Start Every Task

1. Use code-review-graph before Grep/Glob/Read-style codebase exploration. Start with
   `get_minimal_context_tool`, then use semantic/relationship queries for exploration, impact/flow
   tools for blast radius, `detect_changes_tool` for review, and `tests_for` before concluding
   coverage is missing. Confirm graph freshness when the exact head matters. If the tools are
   unavailable, `get_minimal_context_tool` returns `not_ready`, or the graph does not cover the
   target, state that limitation and continue with filesystem search.
2. Inspect `git status --short` and the relevant diff before editing. Preserve unrelated worktree
   changes.
3. Load only the task branches that apply:
   - **Setup, commands, or tooling:** read `README.md`, `package.json`, and the owning config.
     Package scripts are the command source of truth and run from the repository root.
   - **Product or scope:** read `docs/index.md`, search `docs/log.md` for the subject and
     read the current relevant entries, then read `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md`
     and `docs/discovery/M0_DISCOVERY.md` for what is live-verified vs fixture-tested.
   - **Setup or operations:** read `docs/operations/SETUP.md`.
   - **Backlog:** read `docs/backlog/index.md`. Implement only briefs in
     `docs/backlog/ready-for-agent/`.
   - **Bundle or repo-entrypoint documentation:** use the `okf-sync` skill. If it is not registered,
     read `.agents/skills/okf-sync/SKILL.md` and follow its workflow directly. Update the smallest
     owning surface, record structural decisions in `docs/log.md`, and run the validator.
4. For code review, pin the exact base and head, then corroborate every finding against the direct
   diff and relevant runtime behavior. Graph output is navigation, not defect evidence by itself.

## Completion and Git

- Verification must match the risk and the claim. `npm run verify` (format + lint + typecheck +
  unit + integration) is the final gate; use focused checks while iterating.
- Create no commit unless the user explicitly asks in the same message.
