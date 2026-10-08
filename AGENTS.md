# AGENTS.md

pnpm single-package repo for the AI Usage Dashboard. Product overview and commands live in
`README.md`; setup, credentials, and the systemd timer live in `docs/operations/setup.md`; the current
implementation lives in `src/`.

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

This project has a code-review-graph knowledge graph. Use it to narrow scope when the question is
structural — callers, dependents, impact, test coverage, architecture — then read the source. There
the graph is cheaper than scanning files and gives context file search cannot. For a literal string,
a config key, or a file you already know, search or read directly.

### Which graph tool

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool`
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

### Verify in the source

- Narrow scope with the graph, then read the source. Do not change code from graph output alone.
- For any non-trivial change, read the implementation and the relevant tests before concluding.
- Verify the exact source when touching behavior, database logic, migrations, retries, fallbacks,
  recovery, or compatibility code.
- When the graph and the source disagree, the source wins. The graph may be stale or may not
  model that relationship.
- An empty graph result can mean "not indexed" or "not statically visible", not "does not exist".

### Key Tools

| Tool                             | Use when                                               |
| -------------------------------- | ------------------------------------------------------ |
| `detect_changes_tool`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context_tool`        | Need source snippets for review — token-efficient      |
| `get_impact_radius_tool`         | Understanding blast radius of a change                 |
| `get_affected_flows_tool`        | Finding which execution paths are impacted             |
| `query_graph_tool`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview_tool` | Understanding high-level codebase structure            |
| `refactor_tool`                  | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
<!-- /code-review-graph MCP tools -->

## Browser Automation

For ad-hoc inspection outside the spec lane — the running dashboard, a rendered card or chart, a
layout at a given viewport — use the global `agent-browser` CLI rather than the Playwright MCP
server. Its targeted accessibility snapshots keep interaction compact. It is machine tooling, not a
project dependency; Playwright remains the automated runner behind `pnpm run test:e2e`.

Work in a named session: the default session is one browser shared by every agent and conversation
on the machine, and using it can navigate away from a page someone else has open. Start with
`export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix <task>)"` and
finish with `agent-browser close`.

Core loop:

1. `agent-browser open <url>` — the production dashboard defaults to `http://127.0.0.1:3838/`;
   `pnpm run dev` serves `http://127.0.0.1:3839/` from its own database.
2. `agent-browser snapshot -i`
3. `click`, `fill`, or `press` by `@eN` ref.
4. Re-snapshot after each page change.

Use `agent-browser --help` or `agent-browser skills get core` for other commands, and
`agent-browser doctor --offline --quick` for installation diagnosis. Linux Chrome sandbox issues can
involve unprivileged user namespaces; the persistent machine fix lives in
`/etc/sysctl.d/60-userns.conf`. macOS needs no equivalent. A browser-visible claim needs browser
evidence.

## Completion and Git

- Verification must match the risk and the claim. `pnpm run verify` (format + lint + typecheck +
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

### OKF bundle

The `docs/` tree is an Open Knowledge Format (OKF v0.2) bundle maintained by the `okf-sync` skill
(`.agents/skills/okf-sync/SKILL.md`). Use it when editing anything under `docs/`, `README.md`,
`AGENTS.md`, or `CLAUDE.md`, when a decision needs recording in `docs/log.md`, or when a backlog
brief is filed, promoted, or archived; update the smallest owning surface and run the validator.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
