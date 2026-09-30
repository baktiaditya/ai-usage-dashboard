---
type: Discovery Report
title: M0 — Discovery and feasibility gates
description: Re-probed machine baseline, per-provider gate evidence, fixed decisions, and deviations from the plan.
---

# M0 — Discovery and feasibility gates

Re-probed **2026-09-12 (Asia/Jakarta)**, superseding the plan's 2026-09-12 baseline
where noted. The DeepSeek and OpenRouter gates closed live on **2026-09-14**. Nothing here records a secret, an email, an account ID, a raw auth
payload, or a current quota/balance value.

## Machine baseline

| Area                        | Plan baseline      | Re-probed 2026-09-12 | Drift                                         |
| --------------------------- | ------------------ | -------------------- | --------------------------------------------- |
| Node.js                     | 24.19.0            | 24.19.0              | —                                             |
| npm                         | 11.17.0            | 11.17.0              | —                                             |
| SQLite                      | 3.45.1             | 3.45.1               | —                                             |
| Codex CLI                   | 0.154.0            | 0.154.0              | —                                             |
| Claude Code                 | 2.1.267            | **2.1.269**          | patch bump, no contract change                |
| Claude `subscriptionType`   | `null`             | **`pro`**            | **account is now eligible for `rate_limits`** |
| Claude `statusLine`         | not configured     | still not configured | —                                             |
| `DEEPSEEK_API_KEY`          | absent             | absent               | —                                             |
| `OPENROUTER_MANAGEMENT_KEY` | absent             | absent               | —                                             |
| `OPENROUTER_API_KEY`        | absent             | absent               | —                                             |
| User systemd + linger       | running, linger on | running, linger on   | —                                             |

One extra capability was verified because the whole decimal strategy rests on
it: **Node 24 supports JSON source-text access** in `JSON.parse` revivers
(`context.source`). That is what lets the OpenRouter adapter read `100.5` as the
literal characters on the wire instead of an IEEE-754 double. See
`src/lib/money.ts`.

## Gate results

### Codex — PASSED (live)

`codex app-server` was driven over stdio with the real JSON-RPC handshake
(`initialize` → `initialized` → `account/rateLimits/read`). The response carried
`rateLimitsByLimitId.codex` with both windows:

```
rateLimits / rateLimitsByLimitId.codex
  limitId              "codex"
  planType             "plus"
  primary   { usedPercent <number>, windowDurationMins 300,   resetsAt <number> }
  secondary { usedPercent <number>, windowDurationMins 10080, resetsAt <number> }
  rateLimitReachedType null
ordinaryUsageAllowed   true
```

Values are elided deliberately — only the shape is evidence.

The protocol schema was generated from the installed CLI
(`codex app-server generate-json-schema`) and `GetAccountRateLimitsResponse.json`
confirmed the field set, the nullability, and that `resetsAt` is **Unix seconds**
(`int64`), not milliseconds.

Fields present in the response that this application deliberately never stores:
`accountId`, `rateLimitResetCredits[].id/title/description`, `credits.balance`,
`rateLimitUpsell`.

Re-run after any Codex CLI upgrade: `npm run test:live`.

### Claude Code — PASSED (live)

All three preconditions were met and a real event was captured.

- The account reports `subscriptionType: "pro"`, so it is in the class of
  accounts that receive `rate_limits` (the plan observed `null`).
- The field contract was confirmed against
  <https://code.claude.com/docs/en/statusline>:
  `rate_limits.five_hour.used_percentage` / `.resets_at`,
  `rate_limits.seven_day.*`, and a third documented window, `spend_limit.*`.
  `resets_at` is Unix epoch seconds.
- The bridge was installed into `~/.claude/settings.json` (no prior
  `statusLine` existed; the file was backed up first) and a live Claude Code
  session produced an event immediately.

The spool event, and the rows it became:

```
spool event (shape only)
  spoolSchemaVersion 1
  eventId            <32 hex chars>
  observedAt         <iso>
  cliVersion         "2.1.269"
  hasRateLimits      true
  rateLimits         { five_hour: {...}, seven_day: {...} }

persisted quota_windows
  claude  five_hour  usedPercent <number>  windowDurationMinutes 300    resetAt <iso>
  claude  seven_day  usedPercent <number>  windowDurationMinutes 10080  resetAt <iso>
  source_version "claude-code/2.1.269"   source_event_id <32 chars>
```

Two properties were verified against the live event rather than a fixture:

1. **Field selection holds.** A scan of the live database found no email,
   bearer token, API-key shape, UUID, `session_id`, `transcript`, home path, or
   `total_cost_usd` — all of which are present in the status-line input the
   bridge receives.
2. **Event dedup holds.** Replaying an identical frozen spool produced
   `deduplicated: 1`, one snapshot row, and two audited attempts — which is what
   makes a manual refresh racing the scheduled collector safe.

To undo the status-line installation:
`npm run claude:install-statusline -- --uninstall --apply`.

The plan noted `spend_limit` nowhere; it is documented by Anthropic and is a
gauge exactly like the other two, so the bridge allowlists it and the ingestor
labels it. This account did not report one, so it simply never appeared — which
is the intended behaviour, not a gap.

#### Optional quota probe — PASSED (live, 2026-09-17)

The status line is push-shaped: it answers only while a session is live and only
after that session's first API response, so the card goes blind exactly when
nobody is working. The plan admits one pull-shaped source for that gap, an
optional, default-off probe (§3.1), delivered from the now archived brief
[poll-claude-quota-without-a-session](../backlog/archive/poll-claude-quota-without-a-session.md).

Every Messages API response to a subscription token carries the account's
unified rate-limit state in its headers. Probed once on 2026-09-17 with a
`claude setup-token` token saved in the development database and no session
reporting: `POST https://api.anthropic.com/v1/messages`, model `claude-haiku-4-5`,
`max_tokens: 1`, one character of input, no system prompt, headers
`anthropic-version: 2023-06-01` and `anthropic-beta: oauth-2025-04-20`, the
dashboard's own `User-Agent`. It returned `200 OK` with 8 input and 1 output
tokens billed to the subscription. Header names and value shapes, values elided:

```
anthropic-ratelimit-unified-5h-utilization   <decimal 0..1>
anthropic-ratelimit-unified-5h-reset         <epoch seconds>
anthropic-ratelimit-unified-5h-status        allowed
anthropic-ratelimit-unified-7d-utilization   <decimal 0..1>
anthropic-ratelimit-unified-7d-reset         <epoch seconds>
anthropic-ratelimit-unified-7d-status        allowed
anthropic-ratelimit-unified-status           allowed
anthropic-ratelimit-unified-reset            <epoch seconds>
anthropic-ratelimit-unified-representative-claim  five_hour
anthropic-ratelimit-unified-fallback-percentage   <decimal 0..1>
anthropic-ratelimit-unified-overage-status   rejected
anthropic-ratelimit-unified-overage-disabled-reason  org_level_disabled
```

The adapter reads the four `5h`/`7d` utilisation and reset headers only, and
maps them to the status line's `five_hour` and `seven_day` windows. That mapping
rests on public reports, not on this probe: Claude Code's status-line
`rate_limits` are fed from these headers. It is why the two sources share one
history series. Properties that constrain the implementation:

1. **It costs usage.** The probe is real inference, so it runs only when the
   spool has no fresh reading, at most once per five minutes.
2. **Haiku needs no Claude Code identity.** Public reports
   (anthropics/claude-code#40515) show other models refusing a subscription
   token unless the first system block is Claude Code's own identity string;
   Haiku accepts it without. The probe therefore never impersonates Claude Code.
3. **An exhausted window still reports.** A subscription at its limit is refused
   with `429` carrying the same headers; that is a reading, not a failure. A
   `429` without them is `rate_limited`. Not observed live.
4. **Overage.** This account reported overage disabled, so a probe cannot bill
   extra usage here. An account with overage enabled is unproven.

Not gated, and still unproven: whether a probe sent while idle starts a new
five-hour window (the probe ran while a window was already open), a second
machine, and a non-Pro plan.

The probe depends on one model. `claude-haiku-4-5` is the newest Haiku as of
2026-09-17, and the only current model public reports show accepting a
subscription token without Claude Code's identity prompt; `claude-opus-5` and
`claude-sonnet-5` refuse it (anthropics/claude-code#87420). When Haiku 4.5 is
retired, the probe fails as `schema_mismatch` and the card falls back to the
spool until the model is changed. A successor Haiku is not known to share the
exemption; if it does not, a probe without impersonation stops working and the
source decision has to be reopened rather than patched.

#### Usage endpoint — SUPERSEDED for `setup-token` tokens (2026-09-17)

`GET https://api.anthropic.com/api/oauth/usage` was gated on 2026-09-16 as the
poll source. Three probes with `pnpm run spike:claude-usage`, spaced at least
five minutes apart with no session running, returned `200 OK`, and the record
said the token came from `claude setup-token`. That attribution does not hold:

- On 2026-09-17 a `claude setup-token` token saved from dashboard Settings got
  `403` from the endpoint.
- Public reports agree (anthropics/claude-code#11985, #22450, #24200): a
  `setup-token` token is scoped to inference only, and the endpoint requires the
  `user:profile` scope, answering
  `OAuth token does not meet scope requirement user:profile`.
- The spike falls back to `~/.claude/.credentials.json` when no token is in its
  environment, and that full-login token carries `user:profile`. The 2026-09-16
  `200`s most likely came from it.

The only tokens that can read the endpoint are therefore full-login tokens, which
the plan forbids the collector to extract, so the poll was replaced by the
header probe above. What that gate recorded about the endpoint itself stays true
and is kept for reference: it serves a normalised `limits[]` list (active kinds
`session` and `weekly_all` on 2026-09-17), escalates refusals with no
`Retry-After` (a 2026-09-17 `429` did carry one), and carries 12–13
non-descriptive top-level keys whose names this bundle withholds.
`claude -p "/usage"` remains a diagnostic only: integer percentages and a
rounded relative reset.

### DeepSeek — PASSED (live)

Passed live on 2026-09-14, once `DEEPSEEK_API_KEY` was provisioned in `collector.env`:
`npm run test:live` returned at least one currency with decimal-string balances and no usage
field, and scheduled collector runs record `success`. No balance value is recorded here.

The contract, from <https://api-docs.deepseek.com/api/get-user-balance>:

```
{ is_available: boolean,
  balance_infos: [ { currency: "CNY"|"USD",
                     total_balance: string,
                     granted_balance: string,
                     topped_up_balance: string } ] }
```

All monetary fields are **JSON strings** upstream, so they are already
decimal-safe; the adapter re-canonicalises them anyway for storage consistency.
The endpoint exposes **no usage figure at all**, which is why nothing in this
application ever labels a DeepSeek number "usage".

Fixtures are synthetic and marked as such in their `_fixture.note`.

**Gate closed** by provisioning the key in the collector environment file
(`docs/operations/setup.md` §4) and running `npm run test:live`.

> **Note (2026-09-15).** Keys now come from the dashboard's Settings dialog and are stored in the
> database ([plan §3.5](../plan/ai-usage-dashboard-implementation-plan.md)); the environment variable
> is no longer read. The gate evidence above stays as recorded. It was gathered with the key in
> `collector.env` and has not been re-run with a key saved in Settings.

### OpenRouter — PASSED (live)

Passed live on 2026-09-14 with a Management key in `collector.env`: `npm run test:live`
returned credits, usage, and an exact decimal remainder, and scheduled collector runs record
`success`. No credit value is recorded here.

Contract from
<https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits>:

```
200 { data: { total_credits: 100.5, total_usage: 25.75 } }
401 { error: { code: 401, message: "Missing Authentication header" } }
403 { error: { code: 403, message: "Only management keys can perform this operation" } }
```

Two facts drove implementation decisions:

1. `total_credits` and `total_usage` are JSON **numbers**, so `response.json()`
   would round them before we ever saw the digits. The adapter reads the
   response as text and parses it losslessly.
2. The endpoint requires a **Management key**
   (<https://openrouter.ai/settings/management-keys>); an ordinary inference key
   yields 403. That is a different problem from a missing key (401) and gets its
   own error code so the hint can be specific.

**Gate closed** by provisioning a Management key in the collector environment file and
running `npm run test:live`.

> **Note (2026-09-15).** Keys now come from the dashboard's Settings dialog and are stored in the
> database ([plan §3.5](../plan/ai-usage-dashboard-implementation-plan.md)); the environment variable
> is no longer read. The gate evidence above stays as recorded. It was gathered with the key in
> `collector.env` and has not been re-run with a key saved in Settings.

### OpenCode Go — PASSED (live, 2026-09-30)

Added after M0 when scope grew to a fifth provider (see the [log](../log.md)). On 2026-09-30 the
user ran `curl` with their own OpenCode API key against the endpoint. The response had exactly the
shape below, with all three windows `ok`. No key, percentage, or reset time is recorded here.

OpenCode added the endpoint in
[anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513). The public Go docs
(<https://opencode.ai/docs/go/>) do not document it yet, so this shape is observed rather than
contractual:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode API key>

200 { usage: { rolling: { status, percent, resetsAt },
               weekly:  { status, percent, resetsAt },
               monthly: { status, percent, resetsAt } } }
    status   "ok" | "rate-limited"
    percent  integer, percentage *used*
    resetsAt ISO-8601 UTC with milliseconds
```

Probes run from this machine without a valid key, same day:

| Request                             | Result                                               |
| ----------------------------------- | ---------------------------------------------------- |
| no auth header                      | `401` JSON, `AuthError` "Missing API key."           |
| `Authorization: Bearer` + bogus key | `401` JSON, `AuthError` "Unauthorized"               |
| `x-api-key` + bogus key             | `401` JSON, "Missing API key." (only Bearer is read) |

Facts that drove the contract in [plan §3.1](../plan/ai-usage-dashboard-implementation-plan.md):

1. **No money on the wire.** The response carries no dollar limit, plan tier (Go or Go Plus), or
   account identifier. The card can only show percentages.
2. **Windows have different reset rules.** In the live response, `weekly` reset at Monday
   00:00 UTC. `monthly` reset on a mid-month day and time, which is the billing anniversary, not a
   calendar month.
3. **`403` has not been observed here.** The upstream PR discussion and downstream integrations
   report that a valid key without a Go subscription gets `403`. It is fixture-tested only.

**Gate closed** by the live `200` above. The saved-in-Settings live check belongs to the
[implementation brief](../backlog/ready-for-agent/add-opencode-go-quota.md).

## Decisions fixed at M0

These were left open by the plan and are now settled, with defaults in
`src/lib/config.ts`.

| Decision                     | Value                                               | Why                                                                                     |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Poll interval                | 5 min                                               | plan default; conservative against provider rate limits                                 |
| Pull freshness budget        | 3 missed intervals (15 min)                         | tolerates one transient failure plus a retry before a card stops claiming to be current |
| Claude event budget          | 12 hours                                            | Claude only emits while a session is live, so a long gap is normal, not a fault         |
| Reset-passed handling        | forces `stale`                                      | once a window resets, the stored percentage describes a window that no longer exists    |
| Quota thresholds             | `watch` ≤ 20 % remaining, `switch_suggested` ≤ 10 % | plan default                                                                            |
| Balance thresholds           | per provider **and** currency: USD 5/1, CNY 35/7    | 20 CNY and 20 USD are not comparable runway                                             |
| Retention                    | 90 days                                             | plan default                                                                            |
| Advisory on non-healthy data | always `unknown`                                    | a recommendation from a stale number is a guess wearing the costume of a fact           |

## Deviations from the plan, and why

1. **`drizzle-kit` is not used.** Migrations are hand-written SQL in `drizzle/`.
   The generator round-trips STRICT tables, CHECK constraints and the partial
   unique index poorly, and dropping it also removed the last remaining
   `npm audit` finding (a transitive dev-only esbuild advisory). Drizzle ORM
   itself is used exactly as the plan specifies, for typed queries.
2. **Migrations are embedded into a generated TypeScript module.** Turbopack
   cannot trace a runtime `readdirSync`. `drizzle/*.sql` remains the source of
   truth and `tests/unit/migrations-sync.test.ts` fails if the two ever drift.
3. **Next.js 16.3.5, not 15.x.** Every 15.x line still carries unpatched
   advisories in its transitive `postcss`/`sharp`. `npm audit` is now clean.
4. **shadcn/ui components are hand-authored** in `src/components/ui/` rather
   than pulled through the shadcn CLI. shadcn is a copy-in pattern, not a
   dependency, so this is the same result with an auditable diff.
5. **`spend_limit` is supported** as a third Claude quota window (see above).
6. **Percentages are stored as SQLite `REAL`.** The plan's prohibition on `REAL`
   is about money, and is honoured absolutely for money. A quota gauge is a
   measurement with no exact-sum invariant, and `REAL` is the correct type.
