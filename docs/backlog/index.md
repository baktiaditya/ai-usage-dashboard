# Backlog

Triaged work briefs that are not yet part of the product or operations contract.
They hold implementation proposals, review follow-ups, and human-gated tasks that
have no home in a canonical document.

## Status Folders

- `ready-for-agent/` — specified well enough for an implementation agent to work
  without further questions.
- `needs-triage/` — ideas or findings that still need narrowing before they can
  be worked.
- `ready-for-human/` — actionable, but needs a decision, access, or confirmation
  from the user.
- `archive/` — done, rejected, or expired; kept for the decision trail.

Move files between folders with `git mv` so history stays readable.

## Authority Boundary

`docs/backlog/` is working context, never source of truth.

A brief here may carry firm implementation direction, but it **never overrides**:

- `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md` — scope and provider contracts
- `docs/discovery/M0_DISCOVERY.md` — what is live-verified vs fixture-tested
- `docs/operations/SETUP.md` — install, credentials, and operations
- `docs/log.md` — decisions already taken

When a brief conflicts with any of the above, the canonical document wins. Resolve
the conflict first — change the canonical document through a decision recorded in
`docs/log.md`, then work the brief.

Once a brief is accepted as a delivery contract, fold its substance into the
canonical document that owns it, then move the file to `archive/`.

## Writing Rules

- File name `lowercase-kebab-case.md`, matching the rest of `docs/`.
- Briefs are working documents, not OKF concept pages — they carry no frontmatter.
- Start from [`template.md`](template.md).
- After copying the template into a status folder, resolve every relative link from
  the brief's location; canonical documents are usually reached via `../../`.
- The `Status` value inside the brief must match its folder. Change the status and
  move the file with `git mv` in the same change.
- A brief entering `ready-for-agent/` must satisfy all of this: an objective, every
  dependency and gate resolved or inside the agent's executable scope, a concrete
  approach and file list, verifiable acceptance criteria, testing that names proof
  plus risk-appropriate completion gates, and a truly empty `Open Questions` section.

## Relation to GitHub Issues

Issues are the tracking unit; briefs are the specification. A small brief does not
need its own file — write it directly in the issue. Create a file here when the
brief is long, needs separate review, or must outlive its issue. When both exist,
link them to each other.
