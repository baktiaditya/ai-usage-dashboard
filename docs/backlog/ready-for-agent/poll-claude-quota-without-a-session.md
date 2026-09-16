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

1. Widen the credential store first, because every later step writes through it. The provider
   column is constrained twice: a Drizzle `enum` on `providerCredentials.provider` in
   `src/lib/db/schema.ts`, and `CHECK (provider IN ('deepseek', 'openrouter'))` in
   `drizzle/0002_provider_credentials.sql`. SQLite cannot alter a `CHECK` in place, so add
   `drizzle/0003_claude_usage_token.sql` that rebuilds the table — create it with the widened
   check, copy the rows, drop the old table, rename. Do not edit `0002`: it has already run on
   the user's database, and a rewritten migration would make the recorded history a lie. The new
   migration's own header carries the correction, since `0002` still claims Claude "never gets a
   row".
2. Regenerate `src/lib/db/migrations.generated.ts` with `pnpm run db:build-migrations`. That file
   is generated from `drizzle/*.sql`; hand-editing it desynchronises the two. `assertLatestSchema`
   in `src/lib/db/backup.ts` compares a restored database against the SQL these migrations
   produce, so a table rebuilt by migration matches automatically — but a hand-edited generated
   file would not.
3. `readProviderCredentials` in `src/lib/db/credentials.ts` returns a fixed two-field object and
   does not follow `CREDENTIAL_PROVIDERS`. Add a third field for the Claude token and update
   `ProviderCredentials`, whose only consumer is `buildAdapters` in `src/lib/collector/index.ts`.
   Confirm the token passes `credentialSecretSchema` unchanged: it is printable ASCII with no
   whitespace and is far shorter than the 512-character cap.
4. Add `claude` to `CREDENTIAL_PROVIDERS` in `src/lib/domain.ts`, so the token is saved,
   redacted, and hinted by the same path DeepSeek and OpenRouter already use. The doc comment
   directly above that constant currently reads "Codex and Claude authenticate through their own
   CLIs and have no key here" — rewrite it, because widening the union makes it false. The type
   is `CredentialProvider`, and `isCredentialProvider` guards the API boundary in
   `src/app/api/settings/credentials/[provider]/route.ts`.
5. Widening that union is product-visible. `src/components/settings-dialog.tsx` maps over
   `CREDENTIAL_PROVIDERS`, so a third field appears in Settings on its own. Add its `FIELD_LABELS`
   entry and help copy, and extend the `aria-describedby` branch that currently special-cases
   `openrouter`. The copy must say the Claude token is **optional**: unlike DeepSeek and
   OpenRouter, Claude still reports quota without it, through the status-line spool.
6. Add `src/lib/adapters/claude-usage.ts`. It sends one `GET` to the usage endpoint through the
   shared helper in `src/lib/adapters/http.ts`, with `Authorization: Bearer <token>`,
   `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`, and a `claude-cli/<version>`
   user agent. It reads the `limits[]` array and maps each entry to a `QuotaWindow` from
   `src/lib/domain.ts`, field by field as the next step specifies. Ignore the individual window
   keys, so a new window needs no code change.
7. The mapping from a `limits[]` entry to a `QuotaWindow` is specified field by field, because
   `quota_windows` enforces `UNIQUE (snapshot_id, bucket_id, window_kind)` and a guessed identity
   would let two windows collapse into one row.
   - Skip every entry whose `is_active` is `false`. An inactive limit is not a gauge.
   - `windowKind` is `kind`, verbatim.
   - `bucketId` is `kind` when `group` and `scope` are both null, otherwise those fields joined
     with `:` in the order `kind:group:scope`, omitting the null ones. It must be derived only
     from fields that identify the window, never from array position. If two surviving entries
     produce the same `bucketId`, raise `schema_mismatch` and discard the whole snapshot rather
     than let the unique constraint decide which one survives.
   - `usedPercent` is `percent`. The probe already asserts it is finite and within 0..100, which
     is also what the column's `CHECK` requires.
   - `resetsAt` is `resets_at` verbatim. **It is already an ISO-8601 string here**, unlike the
     status-line spool, which carries Unix epoch seconds. An adapter written by copying
     `src/lib/ingestors/claude-statusline.ts` would pass it through `epochSecondsToIso` and
     produce a date in 1970. Convert nothing.
   - `windowDurationMinutes` is always `null`. `limits[]` states no duration, and inferring one
     from the name of a window is exactly the guess §3.1 of the plan forbids. Two consequences
     both already have working code: `labelWindow` in `src/lib/queries/overview.ts` falls back to
     `WINDOW_LABELS[windowKind]`, and `findEndedWindows` skips a window with no known length, so
     a polled window never produces an "ended window" note. The spool's `spend_limit` already
     ships with a null duration, so neither path is new.
   - `severity` and `scope` are read for identity and drift only; neither is stored. `severity` is
     a presentation hint the dashboard computes for itself from `usedPercent`.
   - A `200` whose `limits[]` is absent, empty, or entirely inactive is `not_entitled`, the same
     vocabulary `spoolEventToSnapshot` already uses when no window survives its filter.
8. Add the observed `kind` values to `WINDOW_LABELS` in `src/lib/queries/overview.ts`. The gate
   recorded shape only, so those values are deliberately **not** in this bundle and have to be
   captured during implementation — run the probe once and read them there. Decide the fallback
   explicitly before writing the adapter: today an unlabelled `windowKind` renders as its own raw
   string, which would put an undocumented API's internal name in the browser. Either label it or
   refuse to render it; do not let it through by default.
9. Reuse the failure vocabulary already in `src/lib/errors.ts`, exactly as
   `src/lib/ingestors/claude-statusline.ts` does: `schema_mismatch` on a drifted shape,
   `version_unsupported` on an adapter schema bump. Do not invent a second vocabulary.
10. Treat `429` as "keep the last good observation": the adapter surfaces a distinct error the
    collector records without clearing the previous snapshot, so the card reads `stale` rather than
    failing. Never retry, and never sleep-and-retry inside one collection run.
11. Wire the adapter into `src/lib/collector/index.ts` alongside the other pull sources. It must
    skip cleanly, not fail, when no Claude token is configured — the same shape as a missing
    DeepSeek key today.
12. In `src/lib/config.ts`, add the poll's cadence with a hard floor of five minutes, and reject a
    shorter value at load time rather than silently clamping it. The floor belongs to the poll, not
    to the collector timer, so a manual refresh cannot bypass it either.
13. In `src/lib/freshness.ts`, give a polled Claude observation the pull budget
    (`pullMissedIntervals` x `collectIntervalMinutes`). Leave `claudeEventMaxAgeMinutes` in place —
    it still governs the spool, which remains the default path.
14. Precedence: when both a poll and a spool observation are fresh, the more recent `observedAt`
    wins, and the card carries one reason string. The card must never show two disagreeing Claude
    readings.
15. Keep `scripts/spike-claude-oauth-usage.ts` as the hand-run gate probe, and add a live check to
    `tests/live/live-smoke.test.ts` that skips when no token is configured. Its key source is
    `tests/helpers/saved-credentials.ts`, which reads the database directly and needs the new
    column value exposed.
16. Document the whole token lifecycle in `docs/operations/setup.md`, not just how to mint one. A
    key kept in plaintext needs a stated way to kill it, and the obvious guess is wrong: removing
    the key in Settings deletes only the dashboard's local copy, because the application never
    creates, modifies, or deletes credentials at the provider (plan §3.5 and §10). The token stays
    valid upstream until it is revoked there.
    - Mint: `claude setup-token`, then paste the token into the Claude field in dashboard Settings.
      It is never placed in `collector.env`, an environment variable, or `.env.local`, which is the
      same rule the other two keys already follow.
    - Revoke: claude.ai → Settings → Claude Code, one authorisation at a time. There is no CLI
      path; `claude setup-token` only mints, and `claude auth logout` ends the interactive session
      rather than the standalone token. The Anthropic Console key page does not list these tokens
      at all — it owns organisation API keys, a different mechanism.
    - Verify the revocation, because a revocation that silently does nothing is worse than none.
      Run the probe against the old token with the credentials fallback disabled:
      `CLAUDE_OAUTH_TOKEN=<old> pnpm run spike:claude-usage -- --credentials /nonexistent`.
      A dead token answers `401` with `OAuth access token is invalid`. The `--credentials` override
      is not optional: without it the probe falls back to `~/.claude/.credentials.json` and reports
      the live session's `200 OK`, which reads as a failed revocation when nothing is wrong.
      Verified on 2026-09-16 against a token revoked through that page.
    - Also remove the key from dashboard Settings, so the database stops holding a dead secret.

## Files Touched

Verified against `src/`, `drizzle/`, and `tests/` on 2026-09-16.

| Path                                                   | Change                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `drizzle/0003_claude_usage_token.sql`                  | new; rebuild `provider_credentials` with the widened provider check    |
| `src/lib/db/schema.ts`                                 | widen the `enum` on `providerCredentials.provider`                     |
| `src/lib/db/migrations.generated.ts`                   | regenerate via `pnpm run db:build-migrations`; never hand-edit         |
| `src/lib/db/credentials.ts`                            | third field on `ProviderCredentials` and `readProviderCredentials`     |
| `src/lib/domain.ts`                                    | add `claude` to `CREDENTIAL_PROVIDERS`; rewrite the false doc comment  |
| `src/lib/adapters/claude-usage.ts`                     | new pull adapter reading `limits[]`                                    |
| `src/lib/adapters/http.ts`                             | reuse; extend only if headers cannot be passed today                   |
| `src/lib/collector/index.ts`                           | run the poll in the parallel pull phase; skip when unconfigured        |
| `src/lib/config.ts`                                    | poll cadence with a five-minute floor, rejected below it               |
| `src/lib/freshness.ts`                                 | pull budget for a polled Claude observation                            |
| `src/lib/queries/overview.ts`                          | poll-versus-spool precedence; `WINDOW_LABELS` for the polled kinds     |
| `src/components/settings-dialog.tsx`                   | maps `CREDENTIAL_PROVIDERS`; add label, optional-key copy, aria branch |
| `src/app/api/settings/credentials/[provider]/route.ts` | validates via `isCredentialProvider`; the union widens the route       |
| `tests/integration/credentials.test.ts`                | save, read, and redact a Claude token round-trip                       |
| `tests/integration/database.test.ts`                   | migration applies, is idempotent, and preserves existing rows          |
| `tests/integration/settings-route.test.ts`             | the route accepts and rejects the widened provider set                 |
| `tests/helpers/saved-credentials.ts`                   | expose the stored token to the live check                              |
| `tests/unit/settings-dialog.test.tsx`                  | asserts over the provider list; update for the third field             |
| `tests/e2e/settings.spec.ts`                           | covers the Settings dialog; update for the third field                 |
| `tests/live/live-smoke.test.ts`                        | live check that skips without a token                                  |
| `tests/fixtures/`                                      | sanitised endpoint fixtures, values replaced                           |
| `docs/operations/setup.md`                             | token mint, revoke, revocation check, and how to enable the poll       |

`docs/discovery/m0-discovery.md` and `README.md` are absent because they are already done: the
usage-endpoint gate was recorded in discovery and the `spike:claude-usage` row was added to the
README command table on 2026-09-16, ahead of implementation. Re-read the discovery entry before
writing the adapter — it is the contract, and it withholds the codenamed key names on purpose.

`drizzle/0002_provider_credentials.sql` is deliberately absent: it has already run on the user's
database, so it is history and must not be rewritten, even though its header comment is now wrong.
`src/lib/ingestors/claude-statusline.ts` is likewise absent: its contract does not change.
`src/lib/db/backup.ts` needs no edit — it derives the expected schema from the migrations
themselves — but its restore guard is the reason the generated migration file has to be rebuilt
rather than edited.

Adding a provider to `CREDENTIAL_PROVIDERS` reaches the Settings UI, its route, and both of its
test suites, but it does **not** reach the database on its own: `readProviderCredentials` returns a
hand-written object and the provider column is constrained in SQL. This table was assembled by
tracing every reference to `CREDENTIAL_PROVIDERS`, `CredentialProvider`, `isCredentialProvider`,
`ProviderCredentials`, and `provider_credentials` across `src/`, `drizzle/`, and `tests/`; re-run
that trace before widening the union, in case it has gained consumers since.

## Acceptance Criteria

- [ ] With a token configured, the Claude card reports a current reading on a machine where no
      Claude Code session has run inside the event freshness budget.
- [ ] With no token configured, behaviour is byte-for-byte what it is today: the spool is the only
      Claude source, and nothing calls the endpoint.
- [ ] A `429` renders the last good observation as `stale` and issues no retry.
- [ ] A response whose shape has drifted renders `unavailable`, never a confidently wrong number.
- [ ] Two `limits[]` entries that would produce the same `bucketId` raise `schema_mismatch` and
      discard the snapshot, rather than reaching the unique constraint on `quota_windows`.
- [ ] A polled window's `resetsAt` matches the `resets_at` the endpoint sent, to the second. A
      window dated in 1970 means the epoch conversion from the spool path was copied in.
- [ ] Every rendered Claude window carries a label from `WINDOW_LABELS`; no raw `kind` string
      from the endpoint reaches the browser.
- [ ] A cadence below five minutes is rejected at configuration load, not clamped.
- [ ] A fresh poll and a fresh spool event never produce two disagreeing Claude readings.
- [ ] The Settings dialog renders a Claude field whose copy says the token is optional, and
      leaving it empty changes nothing about how the Claude card behaves today.
- [ ] No token, email address, organisation ID, quota value, or codenamed key appears in the
      database, the repository, or any log line.
- [ ] Fixtures under `tests/fixtures/` carry no real value and are marked sanitised.
- [ ] `pnpm run db:migrate` applies `0003` to a database that already holds DeepSeek and OpenRouter
      rows, keeps both rows, and is a no-op when run a second time.
- [ ] Saving a Claude token from Settings succeeds against the migrated database. Before `0003` the
      same write is refused by the `CHECK`, which is the defect this brief previously hid.
- [ ] `pnpm run db:build-migrations` leaves no diff, proving the generated file matches
      `drizzle/*.sql`.
- [ ] `pnpm run db:backup` followed by `pnpm run db:restore` still passes the schema guard in
      `src/lib/db/backup.ts` after the migration.
- [ ] Setup states that removing the key in Settings does not revoke it upstream, and gives the
      revocation path and the check that proves it worked.

## Testing

- `pnpm exec vitest run tests/unit tests/integration` for adapter shape, `limits[]` mapping, drift
  handling, the five-minute floor, the skip-when-unconfigured path, and the poll-versus-spool
  precedence rule, against sanitised fixtures.
- `pnpm run spike:claude-usage` as the hand-run live gate, no more than once every five minutes.
- `pnpm run test:live` for the added live check; it must skip, not fail, when no token is present.
- `pnpm run test:e2e` is **required**, not optional. Widening `CREDENTIAL_PROVIDERS` adds a third
  field to the Settings dialog, which is a browser-visible change, and happy-dom alone does not
  prove geometry, focus, or scrolling there.
- `pnpm run db:migrate` against a copy of a real database that already has saved keys, run twice.
- `pnpm run db:build-migrations` followed by `git diff --exit-code src/lib/db/migrations.generated.ts`.
- `pnpm run verify` as the final gate.
- `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py` for the documentation changes.

Not performed, and still unproven: verification on a second machine, on a non-Pro plan, and
against an account whose `seven_day_opus` or `seven_day_sonnet` windows are populated. Whether
`claude -p "/usage"` calls the same endpoint underneath was probed with `claude --debug` and stayed
inconclusive; it blocks nothing, because that path is a diagnostic rather than a fallback source.

## Open Questions
