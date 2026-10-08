---
type: Backlog Brief
title: Remove dated prompting from agent instructions
description: Prompt-audit findings for the Claude Code configuration this repo loads, with a proposed diff that is not yet applied.
---

# Remove dated prompting from agent instructions

## Status

Needs triage

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#46](https://github.com/baktiaditya/ai-usage-dashboard/issues/46)

## Objective

The agent instructions this repository ships — `AGENTS.md` and the skills under
`.agents/skills/` — contain no instruction written for an older model that makes the current
one over-route, over-script, or cap its own work, while every fact, safety rule, and tool
contract they carry stays intact.

## Context

A read-only prompt audit (the `claude-api` skill's `prompt-audit` subcommand) ran on
2026-10-08 against the Claude Code configuration that loads in this repository. The target
model was Claude Opus 5.5, the model running the session. The proposed diff was reviewed but
the owner chose not to apply it yet, so the findings are recorded here.

Audited: `CLAUDE.md` → `AGENTS.md`, the five skills under `.claude/skills/` (relative
symlinks into `.agents/skills/`) and okf-sync's `references/repo-sync-map.md`; the
user-level `~/.claude/CLAUDE.md` → `RTK.md`, `~/.claude/commands/yeet.md`, and
`~/.claude/skills/post-pr-review/SKILL.md`; and, report-only, the skills of the loaded
plugins and the Anthropic-synced skills. Settings files, `.mcp.json`, and credentials were
not read. Every path, script, and port named by the in-repo files was checked and exists.

### Findings in this repository

| #   | Location                                                                                  | Evidence                                                                                               | Pattern                                                    | Confidence | Proposed action                       |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------- | ------------------------------------- |
| 1   | `.agents/skills/{debug-issue,explore-codebase,refactor-safely,review-changes}/SKILL.md`   | "Budget: about five tool calls and 800 tokens of graph output per task."                               | Numeric output ceiling; tool-use discouragement            | Medium     | Remove the line in all four files     |
| 2   | `AGENTS.md:11-17`                                                                         | "**…Start with the code-review-graph MCP tools…**", "When to use graph tools FIRST", "instead of Grep" | Default-to-a-tool booster in bold and capitals             | Medium     | Rewrite (see Approach)                |
| 3   | `.agents/skills/debug-issue/SKILL.md:10-16`                                               | "### Steps 1. Call … 5. Call …"                                                                        | Fixed step script for a judgment task                      | Medium     | Rewrite as tools keyed to questions   |
| 4   | `AGENTS.md:4`                                                                             | "setup, credentials, and the systemd timer live in…"                                                   | Volatile specific (incomplete since launchd landed in #44) | Low        | Flag only                             |
| 5   | `AGENTS.md:111`                                                                           | "# This is NOT the Next.js you know"                                                                   | Capitals                                                   | Low        | Flag only — `next dev` regenerates it |
| 6   | `.agents/skills/okf-sync/SKILL.md:153-160`                                                | "Use $okf-sync to …" (six examples)                                                                    | Codex invocation syntax; body examples do not route        | Low        | Flag only — Codex shares the skill    |
| 7   | `.agents/skills/{debug-issue,explore-codebase,refactor-safely,review-changes}/SKILL.md:3` | One-line vendor `description:`                                                                         | Trigger text says what, not when                           | Low        | Flag only                             |

Why the three Medium findings matter:

1. **Budget line.** It came from the code-review-graph installer template ("≤5 tool calls and
   ≤800 total output tokens", commit `6a4c1b4`) and was softened in #45. Current models take a
   numeric cap literally, and the cap contradicts the steps beside it: `debug-issue`
   prescribes about seven calls, and `review-changes` step 3 runs once per high-risk function.
   The neighbouring lines (`detail_level="minimal"`, targeted queries) already carry the
   intent.
2. **"FIRST … instead of Grep".** A blanket default routes even a literal-string or config-key
   lookup through the graph, including when the graph is stale — the session that ran this
   audit started with a hook warning that the graph was built on another branch. The
   surrounding context (the graph is cheaper and structural; verify in source) stays.
3. **Fixed debugging script.** Debugging is a judgment task; a mandatory five-call sequence
   makes the model run every step (for example `detect_changes_tool`) whether or not the bug
   calls for it. `refactor-safely` keeps its numbered steps, because preview-then-apply is a
   fragile order.

Clean: `CLAUDE.md`, okf-sync apart from finding 6, `~/.claude/CLAUDE.md` with `RTK.md`,
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

- The owner decides which of the three Medium hunks to accept. Closed by: the repository
  owner.

## Scope

### In scope

- Findings 1–3: the budget line in the four graph skills, the graph block in `AGENTS.md`, and
  the step list in `debug-issue`.

### Out of scope

- Findings 4–7 until a decision moves any of them into scope.
- Every user-level and plugin file listed above.
- The generated Next.js block in `AGENTS.md`.

## Approach

Apply the diff below, one hunk per finding. The `AGENTS.md` hunk sits between the
`<!-- code-review-graph MCP tools -->` markers; re-running the graph installer may write the
old text back, so check after any reinstall.

```diff
--- a/.agents/skills/debug-issue/SKILL.md
+++ b/.agents/skills/debug-issue/SKILL.md
@@ -7,18 +7,17 @@
 Trace a bug through the knowledge graph before reading source.

-### Steps
+### Tools by question

-1. Call `semantic_search_nodes_tool` to find code related to the issue.
-2. Call `query_graph_tool` with `callers_of` and `callees_of` to trace the call chain in both directions.
-3. Call `get_flow_tool` for the execution path that reaches the suspect code. Its entry point is where the bug is triggered.
-4. Call `detect_changes_tool` to check whether a recent change caused the issue.
-5. Call `get_impact_radius_tool` on the suspect files to see what a fix would affect.
+- Where is the code behind the symptom? `semantic_search_nodes_tool`.
+- How does control reach it? `query_graph_tool` with `callers_of` / `callees_of`, or `get_flow_tool`
+  for the execution path; the flow's entry point is where the bug is triggered.
+- Did a recent change cause it? `detect_changes_tool`.
+- What would a fix affect? `get_impact_radius_tool` on the suspect files.

 ## Token Efficiency Rules
@@
 - Prefer a targeted `query_graph_tool` call over a broad listing call.
-- Budget: about five tool calls and 800 tokens of graph output per task.
 - Read the implementation and its tests before changing code. The graph narrows scope; it does not replace the source.
```

The same one-line `Budget:` removal applies to `explore-codebase`, `refactor-safely`, and
`review-changes`.

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

| Path                                       | Change                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `AGENTS.md`                                | Rewrite the graph block opening (finding 2)     |
| `.agents/skills/debug-issue/SKILL.md`      | Rewrite the steps; drop the budget line (1, 3)  |
| `.agents/skills/explore-codebase/SKILL.md` | Drop the budget line (1)                        |
| `.agents/skills/refactor-safely/SKILL.md`  | Drop the budget line (1)                        |
| `.agents/skills/review-changes/SKILL.md`   | Drop the budget line (1)                        |
| `docs/log.md`                              | `Update` entry for the agent-instruction change |

## Acceptance Criteria

- [ ] No graph skill states a tool-call or token budget.
- [ ] `AGENTS.md` no longer tells agents to use graph tools first or instead of Grep, and
      still says to verify graph output in the source.
- [ ] `debug-issue` maps each debugging question to its graph tool without a fixed order.
- [ ] Prettier and the OKF validator pass.

## Testing

Documentation-only work:

- `pnpm exec prettier --check AGENTS.md .agents/skills/*/SKILL.md`
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py`

No runtime suite applies. A behavioural check — one debugging and one literal-lookup task in a
fresh session, before and after — is optional and has not been run.

## Open Questions

- Accept, amend, or reject each of the three Medium hunks? Owner: the repository owner.
- Should any of the Low flags (4–7) be acted on — for example, naming launchd beside the
  systemd timer in `AGENTS.md:4`? Owner: the repository owner.
- Should the plugin and synced-skill findings be reported upstream? Owner: the repository
  owner.
