---
name: okf-sync
description: Maintain and synchronize the AI Usage Dashboard Open Knowledge Format bundle rooted at `docs/`. Use when an agent needs to add, update, repair, or audit bundle documents after changes to `docs/plan/**`, `docs/discovery/**`, `docs/operations/**`, `docs/backlog/**`, `README.md`, `AGENTS.md`, or `CLAUDE.md`; when a decision needs to be recorded in `docs/log.md`; when a backlog brief is filed, promoted, or archived; or when drift is suspected between the bundle and the repo's instruction files.
---

# OKF Sync

## Overview

Keep `docs/` coherent as an OKF v0.1 bundle. Unlike a derived navigation layer, this
bundle **is** the source of truth for product decisions, and the code under `src/` is
the source of truth for what has actually been built. Sync work means keeping those
two consistent with each other, and keeping `docs/index.md` and `docs/log.md` honest.

## Bundle Shape

The bundle root is `docs/` itself. There is no nested `docs/okf/`.

```
docs/
  index.md                         — root navigation, holds okf_version frontmatter
  log.md                           — dated Creation/Decision/Discovery/Risk/Design/Update entries
  plan/                            — implementation plan (scope, contracts, milestones) + original prompt
  discovery/                       — re-probed baseline, gate evidence, fixed decisions
  operations/                      — install, credentials, timer, troubleshooting
  backlog/                         — triaged work briefs; non-canonical
  agents/                          — per-repo configuration read by agent skills
  assets/                          — images referenced by the bundle and the README; not concept pages
```

Each folder has a plain `index.md` navigation list with no frontmatter. Concept pages carry YAML frontmatter with at
least `type`, `title`, and `description`. Links between documents are relative to the
file that contains them — never root-relative.

## Language Rule

The bundle is written in English and stays that way, matching the existing documents.
Backlog brief bodies are English too, since coding agents consume them. Everything
outside `docs/` — `README.md`, `AGENTS.md`, code, commit messages — is English as well.

## Read First

Read only what applies to the request:

- Always read `docs/index.md` and `docs/log.md`.
- Read `references/repo-sync-map.md` for the current topology and the change-to-document map.
- Read the documents the change touches. Typical inputs:
  - `docs/plan/ai-usage-dashboard-implementation-plan.md` for scope and provider contracts
  - `docs/discovery/m0-discovery.md` for what is live-verified vs fixture-tested
  - `docs/operations/setup.md` when install, credentials, or operations change
  - `docs/backlog/index.md` before filing or moving a brief
  - `AGENTS.md` and `README.md` when the change affects how agents enter the repo
- Read the existing document before editing it.

## Workflow

1. Inspect the current state with `git status --short`.
2. Identify what actually changed — a scope decision, a gate result, a setup or
   operations change, or a new work brief. Decide which document owns it.
3. Update the smallest surface that restores alignment.
   - Edit an existing document when the topology is unchanged.
   - Add a new document only when a durable knowledge node exists that has no home.
   - Link a new document from `docs/index.md`.
4. Record the decision in `docs/log.md`.
   - Every scope decision, discovery, risk, or structural change gets a dated entry under
     the correct date heading, newest date first.
   - Use the existing entry labels: `Creation`, `Decision`, `Discovery`, `Risk`, `Design`,
     `Update`, `Proposed`, `Superseded`, `Restructure`, `Initialization`.
   - Link to the document the entry refers to.
5. Preserve the authority boundary.
   - Do not let `docs/backlog/` redefine anything the canonical documents decide.
   - Do not assert that code exists. Check `src/` first.
   - Never record secrets, keys, emails, account IDs, raw provider payloads, or current
     quota/balance values in any bundle document.
6. Update entry points when navigation changed — `docs/index.md` always, `AGENTS.md` and
   `README.md` when the change affects where an agent should start.
7. Validate with `scripts/validate_okf_bundle.py`.

## Change Patterns

### A provider gate result changes

- Update the gate section in `docs/discovery/m0-discovery.md` first — it owns live-vs-fixture truth.
- Update the plan's annotated status only if the scope implication changed.
- Add a `Decision` entry to `docs/log.md`.

### A scope decision changes what gets built

- Update `docs/plan/ai-usage-dashboard-implementation-plan.md` first — it owns the scope.
- Update `docs/discovery/m0-discovery.md` if a fixed decision or deviation is affected.
- Add a `Decision` entry to `docs/log.md` that names what changed and why.

### Setup or operations change

- Update `docs/operations/setup.md` — it owns install, credentials, and the timer.
- Add an `Update` entry to `docs/log.md` when the change affects existing installs.

### A new document joins the bundle

- Write it with full frontmatter (`type`, `title`, `description`).
- Link it from `docs/index.md`.
- Add a `Creation` entry to `docs/log.md`.

### A backlog brief is filed or moved

- New briefs start from `docs/backlog/template.md`, English body, no frontmatter,
  `lowercase-kebab-case.md` name.
- File it in the folder matching its readiness. A brief only belongs in `ready-for-agent/`
  when its Open Questions section is empty.
- Promote or archive with `git mv` so history survives.
- When a brief is accepted as a delivery contract, fold its substance into the canonical
  document that owns it, move the file to `docs/backlog/archive/`, and log the decision.

### Drift audit

- Compare `AGENTS.md` and `README.md` against the actual bundle shape and `src/`.
- Run the validator and fix missing frontmatter, broken links, and backlog placement first.
- Prefer small corrective edits over reorganizing the bundle.

## Example Requests

- "Use $okf-sync to record the DeepSeek live gate passing and propagate it."
- "Use $okf-sync to log the decision to change the poll interval."
- "Use $okf-sync to file this review output as a backlog brief in the right folder."
- "Use $okf-sync to promote a brief from needs-triage to ready-for-agent."
- "Use $okf-sync to audit whether `docs/` drifted from `AGENTS.md` and `README.md`."
- "Use $okf-sync to repair broken links and missing frontmatter in the bundle."

## Validation

```bash
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
rg -n "TODO|\[TODO" docs
git diff -- docs AGENTS.md CLAUDE.md README.md
```

The validator checks reserved files (`docs/index.md` with `okf_version`, `docs/log.md`),
concept frontmatter, relative in-bundle links, and the backlog rules — status directories,
kebab-case brief names, no frontmatter on briefs, and no open questions left in
`ready-for-agent/`. Fix what it reports before polishing prose.

## Resources

- `references/repo-sync-map.md`
  - The current bundle topology and the map from a kind of change to the documents it
    should touch.
- `scripts/validate_okf_bundle.py`
  - Run after every edit.

The Claude Code entrypoints under `.claude/skills/` are relative symlinks into
`.agents/skills/`, so each skill has one `SKILL.md` source of truth; there is no second
file to keep in sync.

## Guardrails

- The bundle stays in English.
- `docs/backlog/` never overrides a canonical document. Resolve conflicts in the canonical
  document, logged in `docs/log.md`, before working the brief.
- Do not create speculative documents for decisions that have not been made. If something
  is undecided, it belongs in a `needs-triage/` brief.
- Never write secrets, keys, emails, account IDs, raw payloads, or live quota/balance
  numbers into the bundle. Fixtures live under `tests/fixtures/`, sanitized and marked.
- Do not commit unless the request explicitly asks for it.
