# Poll Claude quota without a live session

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#13](https://github.com/baktiaditya/ai-usage-dashboard/issues/13)

## Objective

The Claude card reports a current quota reading whether or not a Claude Code session has run
recently, instead of falling back to `no_event_yet` whenever the machine has been idle.

## Context

Claude quota is the only source in this application that is push-shaped. Claude Code emits
`rate_limits` on the status line only while a session is live, and only after that session's
first API response, so `src/lib/ingestors/claude-statusline.ts` reports `no_event_yet` until a
session has run. That is why the plan gives Claude a long event-driven freshness budget
(`claudeEventMaxAgeMinutes`) rather than the pull budget the other providers use, and why
[the plan](../../plan/ai-usage-dashboard-implementation-plan.md) §2 states the principle
directly: "Claude quota arrives via the status line while Claude is active."

The behaviour is correct and the ingestor is honest about it. It is still the weakest reading on
the dashboard, because idleness and a genuine outage look similar to a user glancing at the card.

Two pull-shaped alternatives were probed live on this machine on 2026-09-16. Both work. Neither is
free of cost, and the choice between them is a real trade-off rather than a clear win.

### Candidate A — `GET https://api.anthropic.com/api/oauth/usage`

The endpoint Claude Code itself reads for `/usage`. It answers with no session running.

Probed twice, five minutes apart, with `scripts/spike-claude-oauth-usage.ts`. Both probes returned
`200 OK`; the second confirmed that cadence does not trip the rate limiter. Active windows carry a
uniform structure:

```
five_hour / seven_day {
  utilization        <number>
  resets_at          <iso8601>
  limit_dollars      null
  used_dollars       null
  remaining_dollars  null
  locked_reason      null
}
```

The payload also carries `limits[]`, a normalised projection of the same windows
(`{ kind, group, percent, severity, resets_at, scope, is_active }`) holding exactly one entry per
active window; an `extra_usage` object that expresses credits in minor units with an explicit
`currency` and `decimal_places`; and a `seven_day_breakdown` with per-model rows. The dollar
fields on each window were null on this plan.

Values are elided deliberately — only the shape is evidence.

Costs and risks:

- **Undocumented and unsupported.** The upstream issue tracking it is labelled `invalid`. A shape
  change is expected behaviour, not an exceptional event.
- **Punitive rate limiting.** Refusals escalate 30/60/120/240/300s and can stay at the ceiling,
  with no `Retry-After` to anchor backoff. One request per five minutes or slower is the safe
  cadence; retrying on refusal is how tools get stuck.
- **Token lifecycle becomes this application's problem.** The OAuth token in
  `~/.claude/.credentials.json` expires, and its refresh token is rotated by Claude Code. A
  collector that refreshes it races the CLI for the same file. `claude setup-token` avoids the
  race by minting a standalone long-lived token, at the cost of one more credential to manage.
- The payload carries twelve keys with non-descriptive codenames. Eleven were null; one held a
  live number. They are not modelled here, and their names are deliberately not recorded in this
  bundle — see Open Questions.

### Candidate B — `claude -p "/usage"`

Claude Code intercepts `/usage` on the client, so no inference happens. The
`--output-format json` envelope proves it: `num_turns: 0`, `total_cost_usd: 0`,
`duration_api_ms: 0`, every token count `0`, and `local_command: "usage"`. Reading quota this way
consumes no quota.

Two problems make it a poor primary source:

- **The numbers are prose, not a contract.** The JSON envelope wraps SDK metadata; the quota
  itself stays inside a human-rendered `result` string, with integer percentages and a localised
  reset time.
- **The rendered reset time is not absolute.** Two runs seconds apart rendered reset times one
  minute apart, so the value is a rounded relative duration. It cannot be stored as `resets_at`
  or used as a cache key. Candidate A returns an absolute ISO-8601 timestamp.

It is also heavy for a timer: a cold run took about seven seconds and boots the full CLI,
including plugins, MCP servers and hooks. `--bare` cannot trim that, because it disables the OAuth
path `/usage` depends on.

What it is good at is proving the account is healthy with no token handling at all, which makes it
a better doctor check than collector.

### `claude auth status`

Worth naming so it is not mistaken for a third option. It returns clean JSON and confirms
`loggedIn`, but its `subscriptionType` is `null` on this Pro account, so it cannot confirm plan
tier. It also returns an email address and an organisation ID — exactly the class of field the
normaliser must drop, and which must never reach the database or this bundle.

## Dependencies and Gates

All closed on 2026-09-16.

- The plan contradiction is resolved. §2 "Structured source first" now carries a narrow Claude-only
  exception, §2 "Separate pull and event ingestion" records that Claude may also be polled, and
  §3.1 gains the optional poll while still ruling `/usage` out as a source. The decision is in
  [the log](../../log.md) under 2026-09-16.
- Adopting an undocumented endpoint is accepted, on the condition that the poll is **off by
  default**, so cloning this repository never calls it without the user opting in.
- Candidate A supplies the numbers. Candidate B is a diagnostic only.
- The token is minted with `claude setup-token` and stored like other provider keys, in the
  database. Authorisation to mint it was given; the implementing agent never needs the value.
- Reading `~/.claude/.credentials.json` is out of scope. `scripts/spike-claude-oauth-usage.ts`
  may read it because it is a hand-run probe, not a collector.

## Scope

### In scope

- A pull adapter for Claude quota, off unless a token is configured, wired into the collector's
  existing parallel pull phase.
- Extending the stored-credential machinery to cover Claude.
- A precedence rule for when both a fresh poll and a fresh spool event exist.
- Freshness for the polled path.
- Rate-limit handling that never retries into the escalation ladder.

### Out of scope

- Removing or changing the status-line bridge, its installer, or
  `src/lib/ingestors/claude-statusline.ts`. The spool costs nothing, never rate-limits, and is the
  documented path; it stays as the default and the fallback.
- Reading `~/.claude/.credentials.json` from the collector.
- Modelling `seven_day_breakdown`, `spend`, the dollar fields on each window, or any codenamed key.
- Recording the codenamed keys anywhere in this repository.
- Surfacing per-model or dollar-denominated Claude figures on the dashboard. The card shows quota
  gauges; money belongs to the credit providers.
- Multi-account support.

## Approach

1. Add `claude` to `CREDENTIAL_PROVIDERS` in `src/lib/domain.ts`, so the token is saved, read, and
   redacted by the same path DeepSeek and OpenRouter already use in `src/lib/db/credentials.ts`.
   The doc comment directly above that constant currently reads "Codex and Claude authenticate
   through their own CLIs and have no key here" — rewrite it, because widening the union makes it
   false. The type is `CredentialProvider`, and `isCredentialProvider` guards the API boundary in
   `src/app/api/settings/credentials/[provider]/route.ts`.
2. Widening that union is product-visible. `src/components/settings-dialog.tsx` maps over
   `CREDENTIAL_PROVIDERS`, so a third field appears in Settings on its own. Add its `FIELD_LABELS`
   entry and help copy, and extend the `aria-describedby` branch that currently special-cases
   `openrouter`. The copy must say the Claude token is **optional**: unlike DeepSeek and
   OpenRouter, Claude still reports quota without it, through the status-line spool.
3. Add `src/lib/adapters/claude-usage.ts`. It sends one `GET` to the usage endpoint through the
   shared helper in `src/lib/adapters/http.ts`, with `Authorization: Bearer <token>`,
   `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`, and a `claude-cli/<version>`
   user agent. It parses the `limits[]` array — `{ kind, group, percent, severity, resets_at,
scope, is_active }` — and maps each active entry to a `QuotaWindow` from `src/lib/domain.ts`.
   Ignore the individual window keys, so a new window needs no code change.
4. Reuse the failure vocabulary already in `src/lib/errors.ts`, exactly as
   `src/lib/ingestors/claude-statusline.ts` does: `schema_mismatch` on a drifted shape,
   `version_unsupported` on an adapter schema bump. Do not invent a second vocabulary.
5. Treat `429` as "keep the last good observation": the adapter surfaces a distinct error the
   collector records without clearing the previous snapshot, so the card reads `stale` rather than
   failing. Never retry, and never sleep-and-retry inside one collection run.
6. Wire the adapter into `src/lib/collector/index.ts` alongside the other pull sources. It must
   skip cleanly, not fail, when no Claude token is configured — the same shape as a missing
   DeepSeek key today.
7. In `src/lib/config.ts`, add the poll's cadence with a hard floor of five minutes, and reject a
   shorter value at load time rather than silently clamping it.
8. In `src/lib/freshness.ts`, give a polled Claude observation the pull budget
   (`pullMissedIntervals` x `collectIntervalMinutes`). Leave `claudeEventMaxAgeMinutes` in place —
   it still governs the spool, which remains the default path.
9. Precedence: when both a poll and a spool observation are fresh, the more recent `observedAt`
   wins, and the card carries one reason string. The card must never show two disagreeing Claude
   readings.
10. Keep `scripts/spike-claude-oauth-usage.ts` as the hand-run gate probe, and add a live check to
    `tests/live/live-smoke.test.ts` that skips when no token is configured.

## Files Touched

Verified against `src/` on 2026-09-16.

| Path                                                   | Change                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/lib/domain.ts`                                    | add `claude` to `CREDENTIAL_PROVIDERS`; check the union's users        |
| `src/lib/adapters/claude-usage.ts`                     | new pull adapter reading `limits[]`                                    |
| `src/lib/adapters/http.ts`                             | reuse; extend only if headers cannot be passed today                   |
| `src/lib/collector/index.ts`                           | run the poll in the parallel pull phase; skip when unconfigured        |
| `src/lib/config.ts`                                    | poll cadence with a five-minute floor, rejected below it               |
| `src/lib/freshness.ts`                                 | pull budget for a polled Claude observation                            |
| `src/lib/db/credentials.ts`                            | follows `CREDENTIAL_PROVIDERS`; verify no provider list is hard-coded  |
| `src/lib/queries/overview.ts`                          | precedence between poll and spool for the Claude card                  |
| `src/components/settings-dialog.tsx`                   | maps `CREDENTIAL_PROVIDERS`; add label, optional-key copy, aria branch |
| `src/app/api/settings/credentials/[provider]/route.ts` | validates via `isCredentialProvider`; the union widens the route       |
| `tests/unit/settings-dialog.test.tsx`                  | asserts over the provider list; update for the third field             |
| `tests/e2e/settings.spec.ts`                           | covers the Settings dialog; update for the third field                 |
| `tests/live/live-smoke.test.ts`                        | live check that skips without a token                                  |
| `tests/fixtures/`                                      | sanitised endpoint fixtures, values replaced                           |
| `docs/discovery/m0-discovery.md`                       | record the gate now that the source is accepted                        |
| `docs/operations/setup.md`                             | token provisioning and how to enable the poll                          |

`src/lib/ingestors/claude-statusline.ts` is deliberately absent: its contract does not change.

Adding a provider to `CREDENTIAL_PROVIDERS` reaches the Settings UI, its route, and both of its
test suites. This table was assembled by tracing every reference to `CREDENTIAL_PROVIDERS`,
`CredentialProvider`, and `isCredentialProvider` across `src/` and `tests/`; re-run that trace
before widening the union, in case it has gained consumers since.

## Acceptance Criteria

- [ ] With a token configured, the Claude card reports a current reading on a machine where no
      Claude Code session has run inside the event freshness budget.
- [ ] With no token configured, behaviour is byte-for-byte what it is today: the spool is the only
      Claude source, and nothing calls the endpoint.
- [ ] A `429` renders the last good observation as `stale` and issues no retry.
- [ ] A response whose shape has drifted renders `unavailable`, never a confidently wrong number.
- [ ] A cadence below five minutes is rejected at configuration load, not clamped.
- [ ] A fresh poll and a fresh spool event never produce two disagreeing Claude readings.
- [ ] The Settings dialog renders a Claude field whose copy says the token is optional, and
      leaving it empty changes nothing about how the Claude card behaves today.
- [ ] No token, email address, organisation ID, quota value, or codenamed key appears in the
      database, the repository, or any log line.
- [ ] Fixtures under `tests/fixtures/` carry no real value and are marked sanitised.

## Testing

- `pnpm exec vitest run tests/unit tests/integration` for adapter shape, `limits[]` mapping, drift
  handling, the five-minute floor, the skip-when-unconfigured path, and the poll-versus-spool
  precedence rule, against sanitised fixtures.
- `pnpm run spike:claude-usage` as the hand-run live gate, no more than once every five minutes.
- `pnpm run test:live` for the added live check; it must skip, not fail, when no token is present.
- `pnpm run test:e2e` is **required**, not optional. Widening `CREDENTIAL_PROVIDERS` adds a third
  field to the Settings dialog, which is a browser-visible change, and happy-dom alone does not
  prove geometry, focus, or scrolling there.
- `pnpm run verify` as the final gate.
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py` for the documentation changes.

Not performed, and still unproven: verification on a second machine, on a non-Pro plan, and
against an account whose `seven_day_opus` or `seven_day_sonnet` windows are populated. Whether
`claude -p "/usage"` calls the same endpoint underneath was probed with `claude --debug` and stayed
inconclusive; it blocks nothing, because that path is a diagnostic rather than a fallback source.

## Open Questions
