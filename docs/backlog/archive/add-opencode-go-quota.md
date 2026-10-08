---
type: Backlog Brief
title: Add OpenCode Go subscription quota
---

# Add OpenCode Go subscription quota

## Status

Archived

Delivered on 2026-09-30 in [PR #20](https://github.com/baktiaditya/ai-usage-dashboard/pull/20),
merged as `ad85dcf` and deployed to the production checkout. The contract lives in
[plan §3.1 and §3.5](../../plan/ai-usage-dashboard-implementation-plan.md),
[M0 discovery](../../discovery/m0-discovery.md), and [Setup](../../operations/setup.md) §4; the
delivery is recorded in the [log](../../log.md).

Delivery goes beyond the Implementation Contract below: the OpenCode Go card spans the full grid
width and carries a **Today** chart of each window's utilisation per local hour, recorded as a
Design entry in the log. The canonical documents above state the delivered rules; this brief is not
updated further.

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: [#21](https://github.com/baktiaditya/ai-usage-dashboard/issues/21)

## Objective

The dashboard shows a fifth card, **OpenCode Go**, with the subscription's rolling five-hour, weekly,
and monthly quota windows. Each window shows the used percentage and reset time exactly as OpenCode
reports them. The card follows the same freshness, advisory, history, and failure rules as the
Codex and Claude quota cards. The source is an OpenCode API key the user saves in Settings.

## Context

On 2026-09-30 the user asked to track their OpenCode Go subscription, and scope was widened from four
providers to five (see the [log](../../log.md)). The contract lives in
[plan §3.1 and §3.5](../../plan/ai-usage-dashboard-implementation-plan.md). The live gate evidence
lives in [M0 discovery](../../discovery/m0-discovery.md), under "OpenCode Go".

The source is `GET https://opencode.ai/zen/go/v1/usage`, authenticated with
`Authorization: Bearer <key>`. OpenCode added it in
[anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513), which closed
[#16017](https://github.com/anomalyco/opencode/issues/16017). The public Go docs still say only
"track your usage in the console", so the shape below is the one verified live, not a documented
contract:

```
200 { usage: { rolling|weekly|monthly: { status: "ok" | "rate-limited",
                                         percent: <used, integer 0..100>,
                                         resetsAt: <ISO-8601 UTC> } } }
401 { type: "error", error: { type: "AuthError", message: "Missing API key." | "Unauthorized" } }
403 key is valid but has no Go subscription (reported upstream; not reproduced here)
```

Facts that constrain the design:

- **Only percentages come back.** The response has no dollar amounts, no plan name (Go or Go
  Plus), and no account identifier. The dollar limits depend on the plan and the model. The
  dashboard therefore never shows or computes dollars for this card (plan §10: no USD estimates of
  quota).
- **`weekly` is a calendar week.** It resets at Monday 00:00 UTC, so it always lasts 7 days.
- **`monthly` follows the billing anniversary.** It resets on the day the subscription started,
  so its length varies from 28 to 31 days and has no fixed duration.
- **Only a Bearer header is read.** A key sent as `x-api-key` is answered as a missing key.
- **The key can spend money.** The same key authorises Go and Zen inference and can draw on a Zen
  balance, so it is a secret on the same footing as the OpenRouter Management key. The request
  itself is a read-only `GET`, spends no quota, and is safe to retry.
- **A `rate-limited` window does not always mean requests are blocked.** With **Use balance**
  enabled in the console, Go falls back to the Zen balance instead of blocking requests, and that
  setting is not in the response. The adapter therefore never reports `usageAllowed = false`.

## Dependencies and Gates

None. The live gate passed on 2026-09-30 (see M0 discovery), and the scope decision is recorded in
the plan and log. A live check with a key saved in Settings is part of this brief (see Testing).

## Scope

### In scope

- `opencode_go` as the fifth provider, a quota provider with a required credential.
- A pull adapter for `GET /zen/go/v1/usage`, polled on every collector run like Codex, DeepSeek,
  and OpenRouter.
- Migration `0004`, which widens every `provider` CHECK constraint without losing any row.
- An "OpenCode Go API Key" field in Settings.
- The card, window labels, logo, history series, demo seed data, and docs.

### Out of scope

- Zen pay-as-you-go balance. No API reports it (upstream issue #10448).
- Per-model limits and dollar amounts.
- Go usage history from OpenCode (upstream issue #43983). Local history is built from our own
  snapshots, as for every other provider.
- Reading `~/.local/share/opencode/auth.json`, `opencode.db`, or any other OpenCode local state.
  The plan's rule that authentication stays with its source applies unchanged.
- Scraping the console or using workspace cookies.
- Grid layout changes. Five cards in `lg:grid-cols-2` leave the last card alone on its row, which
  is accepted.

## Approach

Work in this order. Each step names the real module it touches.

1. **Domain constants** (`src/lib/domain.ts`):
   - Add `'opencode_go'` to `PROVIDERS` and `CREDENTIAL_PROVIDERS`.
   - Set `PROVIDER_LABELS.opencode_go = 'OpenCode Go'` and `PROVIDER_KIND.opencode_go = 'quota'`.
   - Update the `CREDENTIAL_PROVIDERS` comment: like DeepSeek and OpenRouter, OpenCode Go reports
     nothing without its key.
   - Let the compiler find every `Record<Provider, …>` that now needs an entry.
2. **Migration runner** (`src/lib/db/client.ts`). `collector_attempts` and `provider_snapshots`
   are parents of `ON DELETE CASCADE` foreign keys. Dropping either with `foreign_keys = ON` would
   delete every child row and wipe the history.
   - Make `runMigrations` follow SQLite's documented
     [12-step table rebuild](https://www.sqlite.org/lang_altertable.html#otheralter):
     1. Set `PRAGMA foreign_keys = OFF` before `BEGIN IMMEDIATE`. The pragma is a no-op inside a
        transaction.
     2. Apply the pending migrations.
     3. Run `PRAGMA foreign_key_check` before commit, and throw (which rolls back) if it returns
        any row.
     4. Restore `foreign_keys = ON` in a `finally`.
   - `openDb` must still leave every connection with `foreign_keys = ON`.
   - Migrations `0001` and `0003` are unaffected, because nothing references the tables they
     rebuild.
3. **Migration `drizzle/0004_opencode_go_provider.sql`.** Use the header style of `0001` and
   `0003`, and explain why the runner change is needed.
   - Rebuild `collector_attempts`, `provider_snapshots`, and `provider_credentials` so each
     `provider` CHECK also allows `'opencode_go'`.
   - For each table, in this order: create `<table>_rebuild` with every other column, constraint,
     and default copied verbatim from `0000` (or `0003` for credentials), copy every row with its
     `id`, drop the old table, then `ALTER TABLE <table>_rebuild RENAME TO <table>`. Never rename
     the old table aside first. Since SQLite 3.26, a rename rewrites foreign keys in child tables
     to follow it.
   - Recreate every index `0000` defined on the rebuilt tables, including any partial unique
     index on `provider_snapshots`.
   - Then run `pnpm run db:build-migrations` so `src/lib/db/migrations.generated.ts` stays in sync.
4. **Drizzle schema** (`src/lib/db/schema.ts`). Add `'opencode_go'` to the three `provider`
   enums.
5. **Credentials** (`src/lib/db/credentials.ts`). Add `opencodeGoApiKey`, read from
   `secrets.get('opencode_go')`. Update the invalid-provider message in
   `src/app/api/settings/credentials/[provider]/route.ts` to name all four credential providers.
6. **Adapter** (new `src/lib/adapters/opencode-go.ts`). Model it on
   `src/lib/adapters/deepseek.ts`:
   - Export `OPENCODE_GO_SCHEMA_VERSION = 1` and
     `OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'`.
   - The optional `url` exists for tests only, as in DeepSeek.
   - Use `getJsonLossless` with `bearerToken`. It already sets `redirect: 'error'` and
     `cache: 'no-store'`.
   - Wrap the call in `withBoundedRetry` (`maxRetries` 2, `baseDelayMs` 500), because the request
     is a read-only `GET`.
   - With no key, throw `not_configured` with "OpenCode Go API key is not saved in Settings".
   - Remap HTTP 403 (reported as `insufficient_scope`) to `not_entitled`, with the message "this
     key has no OpenCode Go subscription". Leave 401 as `auth_rejected`.
   - Validate with Zod:
     - `usage` must hold all three of `rolling`, `weekly`, and `monthly`. Allow extra keys at
       every level (`.loose()`).
     - `status` must be the enum `ok | rate-limited`.
     - `percent` must be a finite number ≥ 0, not clamped (plan: keep the source value).
     - `resetsAt` must parse as an instant and is stored as canonical UTC ISO-8601.
     - A missing window, an unknown status, or an invalid field is `schema_mismatch`, and nothing
       from that payload is stored.
   - Map the three windows. All use `bucketId: 'go'`:

     | Source key | `windowKind` | `windowDurationMinutes` |
     | ---------- | ------------ | ----------------------- |
     | `rolling`  | `rolling`    | `300`                   |
     | `weekly`   | `weekly`     | `10080`                 |
     | `monthly`  | `monthly`    | `null`                  |

     In each window, `usedPercent` is `percent` and `resetsAt` is `resetsAt`.

   - Snapshot fields:
     - `sourceVersion: 'opencode-api/zen-go-v1-usage'`
     - `usageAllowed: null`, always (see Context)
     - `limitReachedCode: '<window>_rate_limited'` for the first window, in the order `rolling`,
       `weekly`, `monthly`, whose status is `rate-limited`; otherwise `null`
     - `sourceEventId: null`
   - Keep only these fields. Log or store nothing else from the payload.

7. **Collector** (`src/lib/collector/index.ts`). Register
   `createOpencodeGoAdapter({ apiKey: keys.opencodeGoApiKey })` next to DeepSeek and OpenRouter.
8. **Freshness** (`src/lib/freshness.ts`). Add `'opencode_go'` to `PULL_PROVIDERS`.
9. **Config** (`src/lib/config.ts`). Add `opencode_go` to `PROVIDER_PATTERN`, so
   `AUD_THRESHOLDS` keys like `opencode_go:weekly` validate. The default quota thresholds apply
   unchanged.
10. **Labels** (`src/lib/queries/overview.ts`). Add `monthly: 'Monthly'` to `WINDOW_LABELS`.
    `rolling` and `weekly` already label as "5 hour" and "7 day" from their duration. Check that
    the history legend in `src/lib/queries/history.ts` shows "5 hour", "7 day", and "Monthly"
    without bucket suffixes, since the labels are unique.
11. **Settings UI** (`src/components/settings-dialog.tsx`):
    - Label the field `OpenCode Go API Key`. Add a ref, the empty value, and help text (`HAS_HELP`)
      saying:
      - the key comes from the OpenCode console's API Keys page;
      - it also authorises inference and can spend Zen balance;
      - the dashboard only reads the Go usage windows with it.
    - Keep `type="password"`, `autocomplete="off"`, and `spellcheck="false"`, as for the other
      fields.
12. **Logo** (`src/components/provider-logo.tsx`, `src/app/globals.css`):
    - Add the LobeHub `opencode` mark (<https://lobehub.com/icons/opencode>) with the same
      attribution and trademark note as the existing marks.
    - Add a `--logo-opencode-go` token that gives enough contrast in light and dark themes. Use
      `currentColor` if the mark is monochrome.
13. **Demo seed** (`scripts/seed-demo.ts`). Add an OpenCode Go card that is `healthy`, with its
    `weekly` window inside the `watch` threshold. Include at least 7 days of snapshots, so
    `seed:dev` shows a history chart for all three windows.
14. **Redaction** (`src/lib/redact.ts`). The generic `bearer`, `authorization`, `api_key=`, and
    `sk-` patterns should already cover the key. Add a unit test with a synthetic OpenCode-shaped
    key in each of those contexts. Add a dedicated pattern only if a case leaks.
15. **Docs.** Nothing may record a real key, account data, or live percentage (`okf-sync`
    guardrails).
    - `README.md`: add a provider-table row, and update "Four providers" and the security note on
      saved keys.
    - `docs/operations/setup.md`: add an OpenCode Go section after §4. Cover where to get the key,
      what the card shows (percentages only, no dollars, no Zen balance), 401 and 403 hints, and
      that the key can spend money.
    - `docs/log.md`: add an `Update` entry on delivery.
    - `docs/discovery/m0-discovery.md`: add a note if the Settings-saved live check differs from
      the gate evidence.

## Files Touched

| Path                                                      | Change                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/lib/domain.ts`                                       | `opencode_go` in `PROVIDERS`, `CREDENTIAL_PROVIDERS`, labels, kind          |
| `src/lib/db/client.ts`                                    | `runMigrations` disables FK enforcement, runs `foreign_key_check`           |
| `drizzle/0004_opencode_go_provider.sql`                   | new: FK-safe rebuild of three tables with widened `provider` CHECK          |
| `src/lib/db/migrations.generated.ts`                      | regenerated by `pnpm run db:build-migrations`                               |
| `src/lib/db/schema.ts`                                    | `opencode_go` in three `provider` enums                                     |
| `src/lib/db/credentials.ts`                               | `opencodeGoApiKey`                                                          |
| `src/app/api/settings/credentials/[provider]/route.ts`    | invalid-provider message                                                    |
| `src/lib/adapters/opencode-go.ts`                         | new adapter                                                                 |
| `src/lib/collector/index.ts`                              | register adapter                                                            |
| `src/lib/freshness.ts`                                    | `opencode_go` in `PULL_PROVIDERS`                                           |
| `src/lib/config.ts`                                       | `PROVIDER_PATTERN`                                                          |
| `src/lib/queries/overview.ts`                             | `monthly` window label                                                      |
| `src/components/settings-dialog.tsx`                      | key field and help text                                                     |
| `src/components/provider-logo.tsx`, `src/app/globals.css` | logo and colour token                                                       |
| `scripts/seed-demo.ts`                                    | OpenCode Go demo card and history                                           |
| `tests/fixtures/opencode-go/*.json`                       | new, synthetic: `valid`, `rate-limited`, `missing-window`, `unknown-status` |
| `tests/unit/adapter-opencode-go.test.ts`                  | new: normalisation and every guard                                          |
| `tests/unit/*`, `tests/integration/*`, `tests/e2e/*`      | extend the suites that enumerate providers (list below)                     |
| `tests/integration/migration-0004.test.ts`                | new: history survives the rebuild                                           |
| `tests/live/live-smoke.test.ts`                           | OpenCode Go case, gated on a saved key                                      |
| `README.md`, `docs/operations/setup.md`, `docs/log.md`    | docs                                                                        |

Suites that currently enumerate providers or credential providers, and must be checked:

- **Unit:** `advisory`, `config-time`, `history-panel`, `provider-card`, `redact`, and
  `settings-dialog`.
- **Integration:** `collector`, `collect-script`, `credentials`, `database`, `http-adapters`,
  `queries`, `refresh-route`, `saved-credentials`, and `settings-route`.
- **E2E:** `credentials.ts`, `dashboard.spec.ts`, `refresh.spec.ts`, and `settings.spec.ts`.
- **Helper:** `tests/helpers/saved-credentials.ts`.

## Acceptance Criteria

- [ ] With no OpenCode Go key saved, the card renders `unavailable` with the `not_configured`
      hint, and the other four cards are unaffected.
- [ ] With the `valid` fixture served, the card shows three windows labelled "5 hour", "7 day",
      and "Monthly", with used percentages and reset times equal to the fixture values.
- [ ] A `401` renders `error` with `auth_rejected`. A `403` renders `unavailable` with
      `not_entitled`. A missing window or an unknown `status` renders `error` with
      `schema_mismatch`, and stores no snapshot.
- [ ] A payload with a `rate-limited` window yields `limitReachedCode` `<window>_rate_limited`,
      `usageAllowed` `null`, and a `switch_suggested` advisory.
- [ ] Migrating a database holding rows from `0003` in every table to `0004` keeps every row and
      every `id` in all tables. `PRAGMA foreign_key_check` and `PRAGMA integrity_check` pass. The
      connection ends with `foreign_keys = 1`. An `opencode_go` attempt, snapshot, and credential
      can then be inserted.
- [ ] A migration that leaves a foreign-key violation rolls back entirely and leaves the database
      at its previous version.
- [ ] The key is saved from Settings and never reaches the browser beyond its last four characters.
      Logs, diagnostics, and API responses never contain it (redaction tests).
- [ ] `pnpm run seed:dev` shows the OpenCode Go card with a 7-day history for three series.
- [ ] `pnpm run verify` passes, and `pnpm run test:e2e` passes outside the production checkout.
- [ ] `python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py` passes.

## Testing

While iterating:

```bash
pnpm exec vitest run tests/unit/adapter-opencode-go.test.ts tests/integration/migration-0004.test.ts
pnpm exec vitest run tests/integration/collector.test.ts tests/integration/settings-route.test.ts
```

Final gates:

- `pnpm run verify` (format, lint, typecheck, unit, and integration).
- `pnpm run test:e2e`. It rebuilds `.next`, so never run it in the production checkout.
- The OKF validator.

Live checks, which the user must perform because they need the real key:

- Save the key in Settings on the dev server (`AUD_DEV_LIVE_REFRESH=1 pnpm run dev`), press
  **Refresh** on the OpenCode Go card, and confirm the three percentages match the OpenCode
  console.
- Run `pnpm run test:live` with the key saved.

Record the outcome in the log without numbers.

Production rollout follows Setup §6. `db:backup` runs before migration `0004`, because this is the
first migration that rebuilds tables holding history.

## Open Questions
