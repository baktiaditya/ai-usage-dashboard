# Agent Prompt — Implement the AI Usage Dashboard

You are the implementation agent for this repository. Build the application described in [`docs/AI_Usage_Dashboard_Implementation_Plan.md`](./AI_Usage_Dashboard_Implementation_Plan.md) into a working, tested localhost-first dashboard.

## Objective

Implement the plan end to end, including discovery, provider contracts, persistence, collection, dashboard UI, local operations, tests, and setup documentation. The finished application must truthfully distinguish live-verified behavior from fixture-tested or unavailable behavior. Do not stop after scaffolding, writing a plan, or implementing only the happy path.

## Authoritative inputs

1. Read the repository's `AGENTS.md` instructions and the implementation plan in full before changing files.
2. Inspect the actual repository, installed runtimes/CLIs, authentication/configuration state, and available credentials. Treat the plan's machine baseline as a dated observation that may have drifted.
3. Use official provider documentation and locally generated schemas/help output for version-sensitive behavior. If current evidence conflicts with the plan, preserve its product intent, patch stale factual details, and record the reason in the relevant documentation.
4. Preserve unrelated user changes. Do not commit, push, create a PR, expose a listener beyond loopback, or modify external account/billing state unless the caller explicitly requests it.

## Execution requirements

Work through M0–M6 in order, while keeping the repository runnable at each milestone.

### 1. Revalidate and bootstrap

- Re-run the M0 machine and provider feasibility checks without printing or persisting secrets, PII, raw auth payloads, or current quota/balance values.
- Record sanitized contract fixtures and exact source/adapter versions where the plan requires them.
- Initialize the application with npm and keep `package-lock.json` in the repository. Pin exact dependency versions.
- Add an explicit configuration schema, safe defaults, `.gitignore`, and setup documentation before requiring credentials.
- The app must start and remain useful when DeepSeek/OpenRouter credentials are absent and when Claude has emitted no eligible status-line event.

### 2. Establish the domain and persistence seams

- Implement discriminated quota, credit, collection-failure, and advisory types before building provider-specific UI.
- Keep quota gauges, cumulative usage counters, and monetary balances as separate concepts throughout adapters, storage, queries, and presentation.
- Implement migrations for the tables and constraints specified by the plan. Store timestamps in UTC and money as canonical decimal strings or documented scaled integers, never SQLite `REAL` or binary floating-point arithmetic.
- Derive freshness, card status, and advisory state at query time. Preserve immutable observations and audit partial collection attempts.

### 3. Implement collection sources

- Codex: use the official app-server JSON-RPC handshake and `account/rateLimits/read`; validate and persist only the allowlisted subset.
- Claude Code: implement the status-line bridge and atomic `0600` spool ingestion. Preserve any existing status-line configuration or fail closed with a clear setup instruction.
- DeepSeek: collect all returned balance currencies and label them only as balance/balance change.
- OpenRouter: use the credits endpoint with a Management Key and decimal-safe remaining-credit arithmetic.
- Apply independent timeouts, bounded retries where safe, schema/version guards, safe error codes, and provider-level failure isolation.
- Never read auth files, extract OAuth tokens, scrape interactive terminal UI, persist raw upstream payloads, or forward credentials to the browser.

When a live gate cannot run because a credential, account entitlement, or first provider event is unavailable, finish the adapter with sanitized fixtures and tests, surface it as `unavailable`, and document the exact remaining live verification. Do not fabricate a passing live result and do not let that block unrelated milestones.

### 4. Build orchestration and local operations

- Provide one idempotent one-shot collector command used by both scheduled and manual collection.
- Run independent providers concurrently while recording one collector run and one attempt per provider.
- Configure SQLite WAL, `busy_timeout`, short transactions, event deduplication, counter-reset handling, retention, and overlap-safe writes.
- Add user-level systemd service/timer templates or an installer with absolute-path substitution, restrictive permissions/umask, bounded restart behavior, and documented enable/disable/status commands. Do not install or enable units without explicit authorization.
- Bind the web server explicitly to `127.0.0.1`. Protect manual refresh with `POST`, same-origin/CSRF validation, and local rate limiting.

### 5. Build the dashboard

- Implement one responsive overview containing all four providers and the `healthy`, `stale`, `unavailable`, and `error` states.
- Show provider observation time, last collection time, data age, safe diagnostics, and last known values with clear warnings where applicable.
- Render every quota window and reset time, every DeepSeek currency, and OpenRouter total credits, total usage, and remaining credits.
- Implement deterministic `ok`, `watch`, `switch_suggested`, and `unknown` advisories with visible reasons and triggered thresholds. Stale or failed data must produce `unknown`, never a switch recommendation derived from an old value.
- Implement history views according to metric type. Show insufficient history explicitly rather than converting it to zero.
- Include accessible loading, empty, stale, unavailable, error, and refresh states at desktop and mobile widths.

### 6. Test and harden

Add and run focused tests for all behavior required by Sections 7 and 8 of the plan, including:

- valid, partial, malformed, and version-drifted provider fixtures;
- timeout/retry behavior and partial collector success;
- freshness/status/advisory transitions and reset-time behavior;
- decimal arithmetic, multi-currency storage, and negative cumulative-delta discontinuities;
- SQLite migrations, uniqueness, WAL concurrency, retention, and idempotency;
- spool atomicity/permissions and preservation of existing Claude configuration;
- redaction of secrets, bearer/auth headers, emails, account IDs, and raw payloads before logs, persistence, API responses, or browser rendering;
- API same-origin/CSRF enforcement and provider-scoped refresh;
- browser smoke coverage for all card states, multiple windows/currencies, history availability, and responsive layout.

Use opt-in live smoke checks only when the required local account or credential already exists. Their output must be sanitized and must not become a committed fixture.

## Quality gates

Before declaring completion:

1. Run formatting, lint, typecheck, unit, integration, browser smoke, production build, migration, and any repository-specific validation commands.
2. Verify the production start command listens only on `127.0.0.1`.
3. Inspect tracked files and representative logs/database/API output for leaked secrets, PII, or raw provider payloads.
4. Exercise a partial-failure collection and prove that healthy providers still update.
5. Trace every MVP acceptance criterion in Section 7 to implementation plus test/runtime evidence.
6. Re-read the complete plan and account for every in-scope requirement. Update the plan or setup guide for decisions that changed during implementation.
7. Run `git diff --check` and inspect the final diff for unrelated or generated artifacts.

## Completion report

Return a concise report containing:

- what was implemented, grouped by milestone;
- the important architecture and security decisions actually realized;
- every validation command run and its result;
- live provider gates that passed, including only sanitized shape/version evidence;
- gates that remain unavailable and the exact human action needed to unlock each one;
- known limitations or deviations from the plan;
- changed-file summary and current `git status`.

Completion means the application and documentation satisfy the plan's MVP acceptance criteria, except for explicitly identified live gates that genuinely require unavailable credentials or account events. Fixture-only behavior must always be labeled as such.
