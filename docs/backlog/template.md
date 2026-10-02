# <Title>

## Status

<Ready for agent | Needs triage | Ready for human>

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: <link to #NN, or "none yet">

## Objective

What should be true after this work is done. One paragraph, no implementation detail.

## Context

Why this exists now — the finding, review, or user answer that triggered it. Link to
the canonical documents that constrain it. Resolve links from the brief's destination
directory: a brief inside a status folder normally reaches the plan through
`../../plan/ai-usage-dashboard-implementation-plan.md`, not the path that works from this
template's directory.

## Dependencies and Gates

List every decision, access grant, credential, preceding change, or external input that must
exist before implementation can finish. Name who or what can close each gate. Write `None` only
when the work has no unresolved prerequisite. A `ready-for-agent/` brief must have every gate
satisfied or explicitly included in the agent's executable scope.

## Scope

### In scope

- …

### Out of scope

- …

## Approach

The intended implementation path. Name real files and modules — check `src/` first and do
not reference modules that have not been built. A `ready-for-agent/` brief needs a concrete,
ordered path; earlier statuses may keep this provisional when the uncertainty is named under
Dependencies and Gates or Open Questions.

## Files Touched

| Path      | Change |
| --------- | ------ |
| `src/...` | …      |

For `ready-for-agent/`, make this the verified impact map rather than a speculative list. Earlier
statuses may label uncertain entries as provisional.

## Acceptance Criteria

- [ ] Verifiable statement, not a task description.
- [ ] Exact completion checks appropriate to this change pass.

## Testing

Name the exact focused commands that prove each changed behavior and the broader completion gates
justified by the change. Use `pnpm run verify` as the final gate and focused checks (`vitest`,
`playwright`) while iterating; browser-visible claims need the Playwright specs, happy-dom alone
does not prove geometry, overflow, focus, scrolling, or paint. For documentation-only work, name
the OKF validator instead of requiring unrelated runtime suites. Keep any unperformed live,
hardware, or integration verification explicit.

## Open Questions

Anything unresolved. Each question should name the decision owner or evidence needed to close it.
A brief in `ready-for-agent/` must leave this section truly empty — do not write `None` or retain
guidance text. If a question remains, the brief belongs in `needs-triage/` or `ready-for-human/`.
