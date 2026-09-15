---
type: Plan
title: AI Usage Dashboard — Implementation Plan
description: Product authority — localhost quota/balance dashboard scope, provider contracts, milestones M0-M6, and annotated implementation status.
---

# AI Usage Dashboard — Implementation Plan

A local dashboard for monitoring Codex and Claude Code quota and DeepSeek and OpenRouter balances.

## 0. Machine validation baseline

> **Implementation status (2026-09-15).** This plan has been implemented, including
> §3.4 Development isolation and §3.5 Provider credentials (implemented 2026-09-15): DeepSeek
> and OpenRouter keys are saved from the dashboard's Settings dialog, as described in
> [`setup.md`](../operations/setup.md) §4. The baseline below is the initial observation;
> re-probe results, per-provider gate status, finalized decisions, and adopted
> deviations are recorded in
> [`m0-discovery.md`](../discovery/m0-discovery.md). Usage guidance is in
> [`setup.md`](../operations/setup.md).
>
> Drift to be aware of when reading this table:
>
> - Claude Code `2.1.267` → `2.1.269`, and `subscriptionType` `null` → **`pro`**,
>   so the account is eligible for `rate_limits`.
> - The Codex and Claude gates passed **live** (Claude with a real status-line event,
>   `five_hour` + `seven_day` windows). DeepSeek/OpenRouter had no credential at M0
>   and were fixture-tested only; both gates passed live on 2026-09-14.
> - Node 24 supports JSON source-text access, which underpins the decimal-safe
>   strategy for OpenRouter JSON numbers.
>
> Main deviations from the plan (full rationale in `m0-discovery.md` §"Deviations"):
> `drizzle-kit` is not used (hand-written SQL migrations; Drizzle ORM is still
> used for queries), migrations are embedded into a generated TypeScript module
> so they can be bundled, Next.js 16.3.5 is used for a clean `npm audit`, shadcn/ui
> components are written directly in `src/components/ui/`, the Claude `spend_limit`
> window is also supported, and `used_percent` is stored as `REAL` (the `REAL` ban
> applies strictly to money values only).

This baseline was verified on **2026-09-12 (Asia/Jakarta)** and should be treated as drift-prone. M0 must re-run the probes, store sanitized fixtures, and record the source versions used.

| Area            | Verified state                                                                                                                                          | Implication                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Repository      | Contains only this document; no commits, `package.json`, lockfile, schema, or source code yet                                                           | Application bootstrapping is still part of the work                                                                             |
| Runtime         | Node.js `24.19.0`, npm `11.17.0`, Corepack `0.35.0`, SQLite `3.45.1`                                                                                    | Use npm + `package-lock.json`; do not rely on unpinned Yarn, which tried to reach the registry during probing                   |
| Codex           | `codex-cli 0.154.0`, active ChatGPT login; `account/rateLimits/read` called successfully via app-server, returning 300-minute and 10,080-minute windows | Feasible via the official JSON-RPC; parsing `/status` or auth files is unnecessary                                              |
| Claude Code     | `2.1.267`, active first-party login; `subscriptionType` from `claude auth status` is `null`; no `statusLine` configured yet                             | Status line interface available, but quota eligibility/payload still needs proof from a real event after the first API response |
| API credentials | `DEEPSEEK_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`, and `OPENROUTER_API_KEY` are absent from the probed shell environment                                  | DeepSeek/OpenRouter live probes cannot run yet; a missing credential must surface as `unavailable`, not as a global failure     |
| Scheduler       | User systemd running with linger enabled                                                                                                                | A user-level service + timer is a viable primary scheduler                                                                      |

No secrets, emails, account IDs, raw auth payloads, or point-in-time quota values need to be recorded in the repository.

## 1. Goal

Build a single `localhost-first` dashboard answering three questions: how much subscription quota remains, how much API credit remains, and when a provider needs manual review or replacement.

- Show the current state of all four providers on one screen.
- Store historical snapshots so usage trends can be analyzed without conflating different metric types.
- Keep credentials and session tokens local and managed by their original source wherever possible.
- Stay useful when one adapter fails or an upstream format changes.

The dashboard makes no automatic routing decisions in the MVP. It only presents facts, freshness, and configurable thresholds.

## 2. Architecture principles and decisions

- **Localhost-first:** UI and API bind explicitly to `127.0.0.1`; not just checking request headers or addresses.
- **Quota, counters, and money kept separate:** a quota window is a gauge; `total_usage` is a cumulative counter; a balance is a money value per currency. The three are never summed into a single number.
- **Structured source first:** use documented APIs/provider interfaces. Do not read tokens from auth files, call internal endpoints with extracted tokens, or parse terminal UI when a structured interface is available.
- **Separate pull and event ingestion:** Codex, DeepSeek, and OpenRouter can be polled; Claude quota arrives via the status line while Claude is active.
- **Read-only behavior:** the application only performs read operations. Note: the OpenRouter Management Key remains a powerful administrative credential even though the adapter only calls `GET`.
- **Graceful degradation:** one provider's failure or missing configuration does not fail the other providers.
- **No raw payload storage:** validate payloads at the boundary, pick the needed fields, then discard the raw payload.
- **Versioned adapters:** store CLI versions and adapter schema versions alongside snapshots so drift can be diagnosed.

## 3. MVP scope

### 3.1 Provider adapters

#### Codex

- Spawn `codex app-server` over stdio, perform the `initialize`/`initialized` handshake, then call `account/rateLimits/read`.
- Normalize `rateLimitsByLimitId` when available; fall back to `rateLimits` for compatibility.
- Store each `primary`/`secondary` window as a separate record with `limitId`, `usedPercent`, `windowDurationMins`, and `resetsAt`.
- Do not store `email`, `accountId`, tokens, reset-credit IDs, or the full app-server response.
- Use the schema generated by the installed CLI version (`codex app-server generate-json-schema`) as a development fixture, but validate at runtime only the subset of fields the dashboard uses.
- Time out the process, reap the child process cleanly, and never attempt to read `~/.codex/auth.json` or internal databases.

#### Claude Code

- Use the official `rate_limits.five_hour` and `rate_limits.seven_day` fields from the status line JSON input. Each window carries `used_percentage` and `resets_at`.
- Add a status line bridge that selects only quota fields + the observation timestamp and writes a local spool file atomically with `0600` permissions. Do not store the full status line input because it contains unneeded session/workspace metadata.
- The collector reads and validates that spool. When no event exists yet, the event is too old, or the reset time has passed with no new observation, show `unavailable`/`stale`; never treat a stale value as current.
- Configuration integration must preserve any existing status line. If an existing configuration is found later, compose explicitly or fail closed — never overwrite silently.
- The `rate_limits` field is only expected for Claude.ai Pro/Max accounts (or gateways with spend limits) and only becomes available after the first API response. Since this machine's `subscriptionType` is undetected and no status line exists yet, M0 must still prove the actual payload.
- Parsing interactive `/status` or `/usage` output is not an MVP source.

#### DeepSeek

- Call `GET https://api.deepseek.com/user/balance` with an official API key.
- Normalize `is_available` and all of `balance_infos[]`, including `currency`, `total_balance`, `granted_balance`, and `topped_up_balance`.
- Keep source currencies (`USD` or `CNY`); do not merge or convert currencies in the MVP.
- The balance endpoint provides no usage. The UI may only say **balance** or **balance change**, never “DeepSeek usage”.

#### OpenRouter

- Call `GET https://openrouter.ai/api/v1/credits` using a Management Key.
- Normalize `data.total_credits` and `data.total_usage`; compute `remaining = total_credits - total_usage` with decimal arithmetic, not binary floating point.
- Distinguish `401` (missing/invalid credential) from `403` (credential is not a Management Key) in the error taxonomy without printing raw responses.

### 3.2 Dashboard

- Four provider cards with `healthy`, `stale`, `unavailable`, or `error` status.
- Codex and Claude Code quota progress bars per window plus reset time; UI labels derive from duration/source, not from array position alone.
- DeepSeek balances per currency, plus OpenRouter total credits, total usage, and remaining in USD.
- `source observed at`, `last successful collection`, and data age per provider.
- Deterministic `ok`, `watch`, `switch_suggested`, or `unknown` advisories from local per-provider/window/currency thresholds. Every advisory must include a reason; stale/error data must never produce switch recommendations based on old numbers.
- Overridable initial defaults: quota remaining `<=20%` becomes `watch` and `<=10%` becomes `switch_suggested`; balance thresholds are configured per provider and currency so USD/CNY never mix.
- History charts by metric type:
  - quota: latest/min/max utilization per window; never summed as daily usage;
  - OpenRouter: `total_usage` deltas for today/7/30 days only when a pre-period baseline exists;
  - DeepSeek: balance changes labeled **balance change**, not usage, since top-ups/grants can move the value;
  - insufficient history shown explicitly, never as zero.
- The “today” boundary follows the dashboard's configured timezone: `AUD_TIMEZONE` when set, otherwise the system timezone as Node resolves it, falling back to `UTC` when none resolves; timestamps are stored in UTC and converted only at query/presentation time. (Decided 2026-09-15; until [prepare-open-source-release](../backlog/ready-for-agent/prepare-open-source-release.md) is delivered, the running default is `Asia/Jakarta`.)
- The diagnostics panel shows only error codes, adapter/source versions, and redacted safe messages.
- Per-provider manual refresh uses `POST` and never blocks other providers.

### 3.3 Collector and storage

- Provide a one-shot command, e.g. `npm run collect`, as the single orchestration path for scheduled and manual collection.
- Run that command every 5 minutes via a user-level `systemd` service + timer. Do not rely on in-process Next.js intervals as the primary scheduler.
- Optionally serve the dashboard itself at boot as a user-level web unit, installed with `--with-web`. See the 2026-09-14 decision in the [log](../log.md).
- Pull Codex, DeepSeek, and OpenRouter in parallel with independent timeouts; ingest the Claude spool in the same run.
- Use SQLite WAL mode, `busy_timeout`, short transactions, and unique constraints to handle overlap between collector/manual refresh and the web process.
- Default retention 90 days. Daily aggregates may be kept longer once their rollup and idempotency rules are tested.
- Define freshness per source. Initial defaults: a pull source becomes `stale` after three missed intervals; a Claude event also becomes `stale` when the event passes its threshold or `resets_at` has passed.
- Treat negative counter deltas as data discontinuity/reset, not as negative usage.

### 3.4 Development isolation

- `npm run start` and both systemd units keep the production `AUD_PORT` and `AUD_DATA_DIR` contract.
- `npm run dev` defaults to loopback port `3839` and an independent XDG data directory named
  `ai-usage-dashboard-dev`; neither default is derived from the production data path, and a
  development directory that resolves to the production data directory is refused.
- Development-only settings are parsed at the launcher seam, not by the shared application
  configuration, so an invalid development override cannot stop production or scheduled collection.
- Development manual refresh is disabled by default before any database or provider side effect.
  `AUD_DEV_LIVE_REFRESH=1` is the explicit opt-in. The offline child prevents collection from every
  provider, Codex included. It no longer handles credential variables: keys come only from the
  development server's own database (§3.5).
- Development data starts empty. `npm run seed:dev` may replace seeded rows in that directory only;
  production data is never copied or selected implicitly.
- A dedicated production checkout remains a separate operational hardening task for build,
  dependency, restart, and rollback isolation. Next.js 16 already separates `next dev` output under
  `.next/dev`, so that checkout is not a prerequisite for the development port/data contract.

### 3.5 Provider credentials

Decided and implemented 2026-09-15 (see the [log](../log.md)); delivered from the archived brief
[store-provider-keys-in-settings](../backlog/archive/store-provider-keys-in-settings.md).

- The DeepSeek API key and the OpenRouter Management key are entered in a Settings dialog on the
  dashboard and stored in the SQLite database, in plaintext, protected by the database's
  owner-only (`0600`) permissions. Database backups therefore contain them.
- Every collection path — the systemd timer, `npm run collect`, and manual refresh — reads the
  keys from the database at the start of each run. `DEEPSEEK_API_KEY` and
  `OPENROUTER_MANAGEMENT_KEY` are no longer read from any environment, file, or `.env.local`;
  there is no fallback and no import. An existing install re-enters its keys after upgrading.
- The browser never receives a full key. The settings API returns, per provider, whether a key is
  saved, its last four characters (only for keys of at least 16 characters), and when it was
  saved. Every settings route, reads included, requires a same-origin request.
- Saving a key does not validate it upstream and does not start a collection. Saving or removing a
  key changes only the dashboard's local copy; the application still never creates, modifies, or
  deletes keys at the provider (§10).
- The development server stores keys only in its own database (§3.4).

## 4. Technical design

### 4.1 Stack and bootstrap

- **Next.js + TypeScript** for UI and Route Handlers; adapters touching SQLite or child processes must use the Node.js runtime, not the Edge runtime.
- **npm + `package-lock.json`** as the repository-pinned package manager.
- **Tailwind CSS + shadcn/ui** for dashboard components.
- **SQLite + Drizzle ORM** for schema and history queries.
- **Recharts** for MVP charts; evaluate bundle size during implementation.
- **Zod** for validating configuration, adapter payloads, and spool events.
- **Vitest + Testing Library** for unit/component tests and **Playwright** for browser smoke tests.
- Pin exact dependency versions via the lockfile and document minimum supported versions for both CLIs.

### 4.2 Modules

- `ProviderAdapter`: pull-adapter contract with `collect()` and a normalized result/error.
- `adapters/`: `codex`, `deepseek`, and `openrouter` implementations.
- `ingestors/claude-statusline`: Claude spool event validator.
- `collector/`: timeouts, parallel execution, partial success, freshness evaluation, and safe diagnostics.
- `repository/`: snapshot transactions, deduplication, queries, retention, and rollup.
- Internal API: `/api/overview`, `/api/history`, and `POST /api/providers/:provider/refresh`.
- UI: overview cards, trend chart, freshness indicator, configuration state, and diagnostics panel.

### 4.3 Minimum domain contract

Use a discriminated union so quota and money fields cannot form invalid state combinations:

- `QuotaSnapshot { provider, observedAt, collectedAt, sourceVersion, usageAllowed?, limitReachedCode?, windows[] }`
- `QuotaWindow { bucketId, windowKind, usedPercent, windowDurationMinutes?, resetsAt? }`
- `CreditSnapshot { provider, observedAt, collectedAt, balances[] }`
- `CreditBalance { currency, total?, granted?, toppedUp?, usage?, remaining?, isAvailable? }`
- `CollectionFailure { provider, attemptedAt, code, safeMessage, retryable }`
- `Advisory { state, reasons[] }`, computed at query time from fresh snapshots + threshold configuration and never stored as provider fact

Quota `remainingPercent` is computed in the presentation layer as `clamp(100 - usedPercent, 0, 100)`. The source `usedPercent` value is still stored to preserve fidelity and diagnostics.

### 4.4 Minimum data model

#### `provider_snapshots`

- `id`
- `collector_attempt_id`
- `provider`
- `kind` (`quota` or `credit`)
- `source_observed_at`
- `collected_at`
- `source_version`
- `schema_version`
- `source_event_id` nullable for event-driven sources
- partial unique key `(provider, source_event_id)` when `source_event_id` is present; every successful poll is still its own historical observation

#### `quota_windows`

- `snapshot_id`
- `bucket_id`
- `window_kind`
- `used_percent`
- `window_duration_minutes` nullable
- `reset_at` nullable

#### `credit_balances`

- `snapshot_id`
- `currency`
- `total_balance` nullable
- `granted_balance` nullable
- `topped_up_balance` nullable
- `total_credits` nullable
- `total_usage` nullable
- `remaining_credit` nullable
- `is_available` nullable

All money values are stored as canonical decimal strings or scaled integers with a documented scale; never use SQLite `REAL`.

#### `collector_runs` and `collector_attempts`

- run: `id`, `started_at`, `finished_at`, `duration_ms`
- attempt: `run_id`, `provider`, `outcome` (`success`, `unavailable`, or `error`), `started_at`, `finished_at`, `error_code`, `retry_count`

Derive success/failure counts from attempts so partial success is auditable and cannot drift from its details.

The database stores no OAuth tokens, account emails, account IDs, full CLI/status-line inputs, full app-server responses, or raw API payloads. Under §3.5 it stores exactly two API keys — DeepSeek and OpenRouter — in `provider_credentials`.

### 4.5 Status semantics

- `healthy`: the last collection succeeded and is still within the freshness policy.
- `stale`: previously succeeded, but data age passed the threshold or a quota reset passed with no new observation.
- `unavailable`: source/credential not configured, account ineligible, source field unavailable, or format/version guard unrecognized.
- `error`: the source should be available and an attempt failed due to timeout, network, auth rejection, or upstream error.

Attempt status and snapshot freshness are separate concepts and are not stored as a single status on the immutable snapshot. The overview computes the card state at query time with the following precedence: latest attempt `error`; source `unavailable` or no snapshot ever; snapshot past the freshness policy becomes `stale`; otherwise `healthy`. The last known value may remain visible in `error`/`unavailable` states with a clear timestamp and warning.

## 5. Security and operations

- Read `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` from the collector process environment. For systemd, use an environment file outside the repository with `0600` permissions; a user service does not automatically inherit the shell environment. **Superseded by §3.5 (decided and implemented 2026-09-15):** keys are saved from the dashboard's Settings dialog into the owner-only database and are no longer read from any environment.
- Treat the OpenRouter Management Key as a high-impact secret since it can access other administrative operations. Use a dashboard-specific key when the provider supports operational separation, restrict file permissions, and never send it to the browser. Under §3.5 the browser may receive only its last four characters.
- Do not copy Codex/Claude OAuth credentials into `.env`. The Codex adapter delegates auth to the app-server; the Claude bridge only accepts status line fields the CLI already provides.
- Selectors/redactors run before logging and persistence. Tests must prove that emails, account IDs, bearer tokens, authorization headers, and raw payloads never leak through.
- The web server binds to `127.0.0.1`. Refresh endpoints accept `POST`, verify same-origin/CSRF, enforce a local rate limit, and never trust `Host`/`X-Forwarded-For` as the sole control.
- Database, spool, environment, log, and sensitive config files live outside public assets, go into `.gitignore` when inside the tree, and use minimal permissions.
- Systemd units use an absolute `WorkingDirectory`, a bounded restart policy, timeouts, and umask `0077`. The timer uses `Persistent=true` when catch-up after reboot is actually desired.
- If accessed from a phone later, add authentication, TLS, origin policy, and a private network before opening a non-loopback listener.

## 6. Implementation milestones

### M0 — Discovery and feasibility gate

- Re-run the CLI/runtime version baseline and record its date.
- Generate the app-server schema from the installed Codex and store a sanitized `account/rateLimits/read` response fixture.
- Build a Claude status-line bridge proof of concept without overwriting the existing configuration; perform at least one Claude response to confirm `rate_limits` actually appears for this account.
- Provision DeepSeek and OpenRouter credentials outside the repository, then live-probe the official endpoints with sanitized output. Do not make secret provisioning part of source control.
- Decide and document the final freshness thresholds, per-currency balance thresholds, and post-reset-time behavior.
- **Codex gate:** passed at the 2026-09-12 baseline; repeat after CLI upgrades.
- **Claude gate:** not passed until an actual `rate_limits` payload is observed; if the account is ineligible, the provider can still launch as `unavailable`.
- **DeepSeek/OpenRouter gates:** not passed because no credential exists in the probed environment.

The MVP may proceed with unavailable adapters, but acceptance for a given provider is only complete once that provider's gate passes.

### M1 — Bootstrap and provider foundation

- Initialize Next.js/TypeScript with an npm lockfile.
- Create the discriminated domain contracts, validated configuration, error taxonomy, freshness policy, safe logger, and mock fixtures.

### M2 — Pull adapters

- Implement Codex app-server, DeepSeek balance, and OpenRouter credits with timeouts, bounded retries, version guards, and tests.
- Ensure upstream changes yield safe `unavailable`/errors, not wrong numbers.

### M3 — Claude event ingestion

- Implement the status-line bridge, atomic spool, existing-status-line-preserving configuration, schema/version guards, and stale/reset handling.

### M4 — Storage and collector

- Create SQLite migrations, deduplication, the one-shot collector, concurrency handling, user systemd unit/timer, retention, and health logging.

### M5 — Dashboard UI

- Create overview cards, per-metric-type history charts, empty/loading/error/stale states, responsive layout, and manual refresh.

### M6 — Hardening

- Add parser unit tests, API/repository integration tests, redaction tests, failure isolation, browser smoke tests, upgrade-compatibility fixtures, backup/restore tests, and the setup guide.

## 7. MVP acceptance criteria

- One page shows the last known state of all four providers without blocking when one adapter fails or is unconfigured.
- Codex reads quota via `account/rateLimits/read`; it does not read auth files or parse terminal UI.
- Claude shows quota only when the bridge receives a validated, still-fresh payload; a missing payload shows as `unavailable`/`stale`.
- DeepSeek shows all per-currency balances without claiming any usage; OpenRouter shows total credits, total usage, and remaining from the official endpoint.
- All money figures use decimal-safe arithmetic, and every quota window retains its source `usedPercent`, duration, and reset time.
- Historical snapshots are stored. 7/30-day charts appear only with sufficient baseline and use metric-type-appropriate aggregation.
- Each provider shows source observed time, last collection time, status, and safe diagnostics.
- Switch advisories are deterministic, show the reason + triggered threshold, and become `unknown` when data is not fresh.
- No secrets/PII in the browser, logs, fixtures, database, or error responses; redaction tests cover sanitized real payloads.
- The server binds to `127.0.0.1` by default; refresh endpoints use `POST` + same-origin/CSRF guards.
- The user systemd collector survives logout/reboot per policy, re-runs idempotently, and keeps history intact.

## 8. Test strategy

- **Unit:** Zod schemas, version/unknown-field handling, percentage clamping, decimal arithmetic, status/freshness transitions, and error redaction.
- **Contract fixtures:** one sanitized fixture per provider and CLI version; malformed/partial fixtures required.
- **Integration:** mocked HTTP, spawned fake JSON-RPC process, SQLite migrations/constraints/WAL, spool atomicity, collector partial success, and API same-origin checks.
- **Browser:** cards and charts for healthy/stale/unavailable/error, multiple quota windows, multiple currencies, insufficient history, and manual refresh.
- **Live smoke (opt-in):** does not run in CI; only checks endpoint shape/status without printing or recording raw responses.

## 9. Top risks and mitigations

| Risk                                      | Mitigation                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI format/protocol changes               | Isolated adapters, per-version fixtures, generated schema at discovery, subset validation, version guards, and `unavailable`                                                                                                        |
| Claude idle or account ineligible         | Event timestamps + stale policy; do not promise realtime polling; show unavailable with a setup hint                                                                                                                                |
| OpenRouter Management Key leak            | `0600` database (§3.5; `0600` environment file until implemented), redaction, only the last four characters ever sent to the UI, same-origin settings routes, document administrative privileges and that backups contain keys      |
| API rate limits                           | Conservative poll interval, jitter, timeouts, bounded backoff, and last-snapshot cache                                                                                                                                              |
| Subscription quota mistaken for cost      | Separate quota gauges from money/counters; do not convert to USD                                                                                                                                                                    |
| DeepSeek balance mistaken for usage       | Label balance changes explicitly and do not compute spend without a transaction/usage API                                                                                                                                           |
| Reset time missing or already passed      | Nullable field; stale status after reset passes with no new observation; show `unknown` when null; a window the source stops reporting once it resets stays on the card as ended, with no percentage, for at most one window length |
| Money values off due to floating point    | Decimal strings/scaled integers and decimal-safe calculations                                                                                                                                                                       |
| Scheduler and web process writing at once | SQLite WAL, `busy_timeout`, short transactions, dedup keys, and overlap tests                                                                                                                                                       |
| Credential/PII leakage                    | Field allowlists before logging/storage, redaction tests, no raw payloads, localhost binding, and CSRF guards                                                                                                                       |

## 10. Out of scope for MVP

- Public or multi-user access.
- Automatic provider routing.
- Changing plans, buying credit, consuming reset credit, creating/modifying API keys, or any other billing action.
- Browser/terminal automation for scraping pages or TUI usage.
- Converting subscription quota into USD estimates.
- Claiming DeepSeek usage from balance changes.
- Telegram/email alerts and advanced forecasting; can be added once historical data stabilizes.

## 11. Next execution order

1. Close the Claude gate with a temporary bridge that captures only allowlisted fields plus one real event.
2. Provision DeepSeek/OpenRouter credentials locally, then complete the live contract probe without storing raw responses.
3. Bootstrap npm/Next.js and finalize the TypeScript unions + Zod schemas before database migrations or UI.
4. Implement the one-shot collector and persistence first; build the UI after at least one fixture per provider passes contract tests.

## 12. Verified official references

- [Codex app-server protocol and `account/rateLimits/read`](https://developers.openai.com/codex/app-server/)
- [Claude Code status line — rate limit usage](https://code.claude.com/docs/en/statusline#rate-limit-usage)
- [DeepSeek — Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)
- [OpenRouter — Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [OpenRouter — Management API Keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
