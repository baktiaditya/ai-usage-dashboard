---
type: Backlog Brief
title: Remove dated prompting from agent instructions
description: Prompt-audit findings for the Claude Code configuration this repo loads, with a proposed diff that is not yet applied.
---

# Remove dated prompting from agent instructions

## Status

Archived

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#46](https://github.com/baktiaditya/ai-usage-dashboard/issues/46)

## Objective

The agent instructions this repository writes itself — `AGENTS.md` and the `okf-sync` skill —
contain no instruction written for an older model that makes the current one over-route,
while every fact, safety rule, and tool contract they carry stays intact.

## Context

A read-only prompt audit (the `claude-api` skill's `prompt-audit` subcommand) ran on
2026-10-08 against the Claude Code configuration that loads in this repository. The target
model was Claude Opus 5.5, the model running the session. The proposed diff was reviewed but
the owner chose not to apply it yet, so the findings are recorded here.

Audited: `CLAUDE.md` → `AGENTS.md`, the skills under `.claude/skills/` (relative symlinks
into `.agents/skills/`) and okf-sync's `references/repo-sync-map.md`; the user-level
`~/.claude/CLAUDE.md` → `RTK.md`, `~/.claude/commands/yeet.md`, and
`~/.claude/skills/post-pr-review/SKILL.md`; and, report-only, the skills of the loaded
plugins and the Anthropic-synced skills. Settings files, `.mcp.json`, and credentials were
not read. Every path, script, and port named by the in-repo files was checked and exists.

The four code-review-graph skills (`debug-issue`, `explore-codebase`, `refactor-safely`,
`review-changes`) are excluded by owner decision: they follow the upstream
[code-review-graph skills](https://github.com/tirth8205/code-review-graph/tree/staging/skills),
so their findings are not tracked here.

### Findings in this repository

| #   | Location                                   | Evidence                                                                                               | Pattern                                                    | Confidence | Proposed action                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------- | ------------------------------------- |
| 1   | `AGENTS.md:11-17`                          | "**…Start with the code-review-graph MCP tools…**", "When to use graph tools FIRST", "instead of Grep" | Default-to-a-tool booster in bold and capitals             | Medium     | Rewrite (see Approach)                |
| 2   | `AGENTS.md:4`                              | "setup, credentials, and the systemd timer live in…"                                                   | Volatile specific (incomplete since launchd landed in #44) | Low        | Flag only                             |
| 3   | `AGENTS.md:111`                            | "# This is NOT the Next.js you know"                                                                   | Capitals                                                   | Low        | Flag only — `next dev` regenerates it |
| 4   | `.agents/skills/okf-sync/SKILL.md:153-160` | "Use $okf-sync to …" (six examples)                                                                    | Codex invocation syntax; body examples do not route        | Low        | Flag only — Codex shares the skill    |

Why finding 1 matters: a blanket "FIRST … instead of Grep" default routes even a
literal-string or config-key lookup through the graph, including when the graph is stale — the
session that ran this audit started with a hook warning that the graph was built on another
branch. Current models follow such defaults literally. The surrounding context (the graph is
cheaper and structural; verify in source) stays.

Clean: `CLAUDE.md`, okf-sync apart from finding 4, `~/.claude/CLAUDE.md` with `RTK.md`,
`post-pr-review`, and `yeet.md` (it reads `~/.codex/skills/yeet/SKILL.md`, which was not
audited).

### Findings outside this repository (report only)

These live in user-level or plugin files that this repository does not own; they are recorded
so the decision trail is complete, not as work for this brief.

- firecrawl: `firecrawl-cli/SKILL.md:137` gives a 5-minute minimum monitor interval while
  `firecrawl-monitor/SKILL.md:120` gives 15 minutes; `commands/skill-gen.md:26` uses
  `--maxDepth` where the crawl skill documents `--max-depth`.
- Synced `pdf/FORMS.md:4` runs `scripts/check_fillable_fields`, but the script is
  `check_fillable_fields.py`.
- skill-creator `SKILL.md:306` steers thinking depth in prose ("take your time and really
  mull things over"), which effort settings control on current models.
- context-mode, mattpocock-skills, hindsight-memory, and the synced pptx and deep-research
  skills carry capitalised defaults ("Default to context-mode for ALL commands"), word caps
  ("Under 400 words."), tool names that no longer match this session's
  `mcp__plugin_…` names, and a recommended "italic accent text" style.
- mattpocock `resolving-merge-conflicts/SKILL.md:14` ("Stage everything and commit") differs
  from `AGENTS.md`'s "Create no commit unless the user explicitly asks"; it is arguably a
  task-scoped override and is flagged only.

## Dependencies and Gates

- The owner decides whether to accept the `AGENTS.md` hunk. Closed by: the repository owner.

## Scope

### In scope

- Finding 1: the opening of the code-review-graph block in `AGENTS.md`.

### Out of scope

- Findings 2–4 until a decision moves any of them into scope.
- The four code-review-graph skills, which follow upstream.
- Every user-level and plugin file listed above.
- The generated Next.js block in `AGENTS.md`.

## Approach

Apply the diff below. The hunk sits between the `<!-- code-review-graph MCP tools -->`
markers; re-running the graph installer may write the old text back, so check after any
reinstall.

```diff
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -8,13 +8,14 @@
 ## MCP Tools: code-review-graph

-**This project has a knowledge graph. Start with the code-review-graph
-MCP tools to narrow scope, then read the source.** The graph is cheaper than scanning files and
-gives you structural context (callers, dependents, test coverage) that file search cannot.
+This project has a code-review-graph knowledge graph. Use it to narrow scope when the question is
+structural — callers, dependents, impact, test coverage, architecture — then read the source. There
+the graph is cheaper than scanning files and gives context file search cannot. For a literal string,
+a config key, or a file you already know, search or read directly.

-### When to use graph tools FIRST
+### Which graph tool

-- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
+- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool`
```

## Files Touched

| Path          | Change                                          |
| ------------- | ----------------------------------------------- |
| `AGENTS.md`   | Rewrite the graph block opening (finding 1)     |
| `docs/log.md` | `Update` entry for the agent-instruction change |

## Acceptance Criteria

- [ ] `AGENTS.md` no longer tells agents to use graph tools first or instead of Grep, and
      still says to verify graph output in the source.
- [ ] Prettier and the OKF validator pass.

## Testing

Documentation-only work:

- `pnpm exec prettier --check AGENTS.md`
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`

No runtime suite applies. A behavioural check — one structural question and one
literal-lookup task in a fresh session, before and after — is optional and has not been run.

## Open Questions

- Accept, amend, or reject the `AGENTS.md` hunk? Owner: the repository owner.
- Should any of the Low flags (2–4) be acted on — for example, naming launchd beside the
  systemd timer in `AGENTS.md:4`? Owner: the repository owner.
- Should the plugin and synced-skill findings be reported upstream? Owner: the repository
  owner.
