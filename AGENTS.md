# AGENTS.md

npm single-package repo for the AI Usage Dashboard. Product overview and commands live in
`README.md`; setup, credentials, and the systemd timer live in `docs/operations/setup.md`; the current
implementation lives in `src/`.

<!-- code-review-graph MCP tools -->

## Start Every Task

1. Use code-review-graph before Grep/Glob/Read-style codebase exploration. Start with
   `get_minimal_context_tool`, then use semantic/relationship queries for exploration, impact/flow
   tools for blast radius, `detect_changes_tool` for review, and `tests_for` before concluding
   coverage is missing. Confirm graph freshness when the exact head matters. If the tools are
   unavailable, `get_minimal_context_tool` returns `not_ready`, or the graph does not cover the
   target, state that limitation and continue with filesystem search. Semantic search degrades
   silently: `code-review-graph update` never refreshes embeddings, so nodes added since the last
   `embed` are absent from vector results while `search_mode` still reports `semantic`. Re-run
   `code-review-graph embed --provider local` before relying on it, or treat a semantic miss as
   inconclusive.
2. Inspect `git status --short` and the relevant diff before editing. Preserve unrelated worktree
   changes.
3. Load only the task branches that apply:
   - **Setup, commands, or tooling:** read `README.md`, `package.json`, and the owning config.
     Package scripts are the command source of truth and run from the repository root.
   - **Product or scope:** read `docs/index.md`, search `docs/log.md` for the subject and
     read the current relevant entries, then read `docs/plan/ai-usage-dashboard-implementation-plan.md`
     and `docs/discovery/m0-discovery.md` for what is live-verified vs fixture-tested.
   - **Setup or operations:** read `docs/operations/setup.md`.
   - **Backlog:** read `docs/backlog/index.md`. Implement only briefs in
     `docs/backlog/ready-for-agent/`.
   - **Bundle or repo-entrypoint documentation:** use the `okf-sync` skill. If it is not registered,
     read `.agents/skills/okf-sync/SKILL.md` and follow its workflow directly. Update the smallest
     owning surface, record structural decisions in `docs/log.md`, and run the validator.
4. For code review, pin the exact base and head, then corroborate every finding against the direct
   diff and relevant runtime behavior. Graph output is navigation, not defect evidence by itself.

## Browser Automation

For ad-hoc inspection outside the spec lane — the running dashboard, a rendered card or chart, a
layout at a given viewport — use the global `agent-browser` CLI rather than the Playwright MCP
server. Its targeted accessibility snapshots keep interaction compact. It is machine tooling, not a
project dependency; Playwright remains the automated runner behind `npm run test:e2e`.

Work in a named session: the default session is one browser shared by every agent and conversation
on the machine, and using it can navigate away from a page someone else has open. Start with
`export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix <task>)"` and
finish with `agent-browser close`.

Core loop:

1. `agent-browser open <url>` — the dashboard defaults to `http://127.0.0.1:3838/`.
2. `agent-browser snapshot -i`
3. `click`, `fill`, or `press` by `@eN` ref.
4. Re-snapshot after each page change.

Use `agent-browser --help` or `agent-browser skills get core` for other commands, and
`agent-browser doctor --offline --quick` for installation diagnosis. Linux Chrome sandbox issues can
involve unprivileged user namespaces; the persistent machine fix lives in
`/etc/sysctl.d/60-userns.conf`. macOS needs no equivalent. A browser-visible claim needs browser
evidence.

## Completion and Git

- Verification must match the risk and the claim. `npm run verify` (format + lint + typecheck +
  unit + integration) is the final gate; use focused checks while iterating.
- Create no commit unless the user explicitly asks in the same message.

## Agent skills

### Issue tracker

GitHub Issues via `gh`; long briefs live in `docs/backlog/`, linked both ways. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
