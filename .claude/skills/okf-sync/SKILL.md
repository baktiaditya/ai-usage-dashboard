---
name: okf-sync
description: Keep the AI Usage Dashboard knowledge bundle under docs/ coherent and logged. Use when a scope decision is made, a provider gate result changes, setup or operations facts change, a backlog brief is filed or promoted, or docs/ has drifted from AGENTS.md and src/. Also use before finishing any task that changed docs/.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# OKF Sync

## What this bundle is

`docs/` is an OKF v0.1 bundle and the bundle root is `docs/` itself — there is no nested
`docs/okf/`. It **is** the source of truth for product decisions; `src/` is the source of
truth for what has actually been built. Sync work means keeping those two from
contradicting each other, and keeping `docs/index.md` and `docs/log.md` honest.

```
docs/
  index.md         — root navigation; holds okf_version frontmatter
  log.md           — dated Creation/Decision/Discovery/Risk/Design/Update entries
  plan/            — implementation plan (scope, contracts, milestones) + original prompt
  discovery/       — re-probed baseline, gate evidence, fixed decisions
  operations/      — install, credentials, timer, troubleshooting
  backlog/         — triaged work briefs; non-canonical
  agents/          — per-repo configuration read by agent skills
```

Each folder has a plain `index.md` navigation list with no frontmatter. Concept pages carry YAML frontmatter with at least `type`, `title`, `description`.
Links are relative to the file containing them, never root-relative.

**Language:** the bundle is English and stays that way, matching the existing documents.

## Workflow

1. `git status --short` to see what actually changed.
2. Decide which document owns the change. Read that document before editing it — and read
   `references/repo-sync-map.md` for the full change-to-document map.
3. Make the smallest edit that restores alignment. Add a new document only when a durable
   fact has no home; when you do, link it from `docs/index.md`.
4. Record it in `docs/log.md` under the right date heading, newest date first, using the
   labels already in use: `Creation`, `Decision`, `Discovery`, `Risk`, `Design`, `Update`,
   `Proposed`, `Superseded`, `Restructure`, `Initialization`.
5. Update `AGENTS.md` / `README.md` if the change affects where an agent should start.
6. Run the validator.

## The four rules that get broken most

- **`docs/backlog/` never overrides a canonical document.** If a brief contradicts the
  plan, `m0-discovery.md`, `setup.md`, or `log.md`, the canonical document wins. Fix it
  there first, log it, then work the brief.
- **Only `ready-for-agent/` briefs are implementable.** A brief with anything left in its
  Open Questions section belongs in `needs-triage/` or `ready-for-human/`. Move between
  folders with `git mv`.
- **Do not assert that code exists.** Check `src/` first.
- **Never record secrets, keys, emails, account IDs, raw payloads, or live quota/balance
  numbers in the bundle.** Fixtures live under `tests/fixtures/`, sanitized and marked.

## Filing a backlog brief

Start from `docs/backlog/template.md`. English body, no frontmatter,
`lowercase-kebab-case.md` filename, filed in the status folder matching its readiness. When
a brief is accepted as a delivery contract, fold its substance into the canonical document
that owns it, `git mv` the file to `docs/backlog/archive/`, and log the decision.

## Validation

```bash
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
```

Checks reserved files, concept frontmatter, relative in-bundle links, and the backlog rules
(status directories, kebab-case names, no frontmatter on briefs, no open questions left in
`ready-for-agent/`). Fix what it reports before polishing prose.

## Resources

Shared with the Codex skill at `.agents/skills/okf-sync/` so there is one copy of each:

- `.agents/skills/okf-sync/references/repo-sync-map.md` — full topology, the
  change-to-document table, and known drift risks. Read when the change is not obviously
  owned by one document.
- `.agents/skills/okf-sync/scripts/validate_okf_bundle.py` — run after every edit.

## Guardrail

Do not commit unless the request explicitly asks for it.
