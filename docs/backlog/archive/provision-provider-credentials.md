---
type: Backlog Brief
title: Close the DeepSeek and OpenRouter live gates
---

# Close the DeepSeek and OpenRouter live gates

## Status

Archived

Closed on 2026-09-14. Both keys are provisioned in `collector.env`, `npm run test:live` passes all
four provider gates with nothing skipped, and the collector timer is enabled; scheduled runs record
`success` for DeepSeek and OpenRouter.

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet

## Objective

DeepSeek and OpenRouter stop rendering as `unavailable`: both adapters are proven
against their live endpoints, and the systemd collector timer is enabled.

## Context

Per [M0 Discovery](../../discovery/m0-discovery.md), the Codex and Claude Code gates passed
live, but DeepSeek and OpenRouter are fixture-tested only — no credential for
either exists on this machine. The exact closing action per gate is recorded in
[M0 Discovery](../../discovery/m0-discovery.md) (§DeepSeek, §OpenRouter); credential setup
is described in [Setup](../../operations/setup.md) (§4). Until keys are provisioned, both
cards correctly render as `unavailable` with a setup hint.

## Dependencies and Gates

- A real `DEEPSEEK_API_KEY` in the collector environment file
  (`~/.config/ai-usage-dashboard/collector.env`, mode `0600`). Closes the DeepSeek
  gate. Owner: user.
- A real OpenRouter **Management** key (not an inference key — inference keys yield
  403, a different error code by design) as `OPENROUTER_MANAGEMENT_KEY` in the same
  file. Closes the OpenRouter gate. Owner: user.

## Scope

### In scope

- Provision both keys, run `npm run test:live`, confirm both gates pass.
- Enable the collector timer (`scripts/install-systemd.sh --install --enable`).
- Update [M0 Discovery](../../discovery/m0-discovery.md) gate results and record the outcome
  in [log](../../log.md).

### Out of scope

- Any adapter, schema, or UI change — the code path is already implemented and
  covered by fixtures.

## Approach

1. Add the two keys to the collector environment file per [Setup](../../operations/setup.md) §4.
2. Run `npm run test:live` and confirm the DeepSeek and OpenRouter gates pass.
3. Run `npm run collect` once and confirm both providers write fresh observations.
4. Enable the timer, then update [M0 Discovery](../../discovery/m0-discovery.md) and
   [log](../../log.md).

## Files Touched

| Path                             | Change                                                   |
| -------------------------------- | -------------------------------------------------------- |
| `docs/discovery/m0-discovery.md` | Update DeepSeek/OpenRouter gate results to passed (live) |
| `docs/log.md`                    | `Decision` entry recording the closed gates              |

## Acceptance Criteria

- [x] `npm run test:live` passes all four provider gates with nothing skipped for
      missing credentials.
- [x] The dashboard shows DeepSeek and OpenRouter cards with live data, not
      `unavailable`.
- [x] No secret, key, or balance value is recorded in the repository, logs, or
      fixtures.

## Testing

`npm run test:live` is the proof; `npm run verify` is the completion gate. Keep the
timer disabled until both gates pass — scheduled runs against missing credentials only
produce `unavailable` attempts.

## Open Questions

Resolved: the user provisioned both keys on 2026-09-14.
