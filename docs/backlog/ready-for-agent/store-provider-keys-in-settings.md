# Store provider keys from a Settings dialog

## Status

Ready for agent

The status above must match the directory that contains this brief. Move the file with
`git mv` when its readiness changes.

This is a backlog implementation brief, not a canonical product or operations
contract. It does not override `docs/plan/ai-usage-dashboard-implementation-plan.md`,
`docs/discovery/m0-discovery.md`, `docs/operations/setup.md`, or `docs/log.md`.

Related issue: none yet. Creating an issue is tracking hygiene, not an implementation gate.

## Objective

The DeepSeek and OpenRouter keys are entered in the dashboard. A **Settings** button next to
**Reload view** opens a modal dialog with two fields, **DeepSeek API Key** and
**OpenRouter Management Key**. Saving writes the keys to the SQLite database, and every collection path
reads them from there: the systemd timer, `npm run collect`, and manual refresh. The environment
variables `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` stop being read, wherever they are set:
`collector.env`, the shell, or a repository `.env.local`. A saved key never returns to the browser
in full. The dialog shows only whether a key is saved, its last four characters, and when it was
saved.

## Context

The user asked for this on 2026-09-15. Today every entry point merges `collector.env` into
`process.env` (`src/lib/env-file.ts`), `loadConfig` reads both keys into `AppConfig.credentials`
(`src/lib/config.ts`), and `buildAdapters` passes them to the adapters
(`src/lib/collector/index.ts`). Keys in `.env.local` reach only the Next.js server, which is why
[Setup](../../operations/setup.md) §4 warns against using that file.

The change reverses an earlier contract: the database stored no API keys, and no credential was
sent to the browser. The user decided the new contract on 2026-09-15. It is recorded in the
[log](../../log.md) and stated canonically in
[plan §3.5](../../plan/ai-usage-dashboard-implementation-plan.md), which wins over this brief:

- Keys are stored in plaintext in the owner-only (`0600`) database, the same protection
  `collector.env` has today. `npm run db:backup` files therefore contain the keys. They are
  already owner-only.
- The environment variables are removed outright. They are not a fallback and are not imported
  once. After deploy, the DeepSeek and OpenRouter cards read `unavailable` until the user saves
  the keys in Settings.
- The browser receives, for each provider, whether a key is saved, its last four characters, and
  when it was saved. It never receives the full key.
- The OpenRouter field is labelled **OpenRouter Management Key**, with helper text explaining that
  `/api/v1/credits` accepts only a Management key.

Other constraints that stay in force:

- Mutating routes require a same-origin request (`requireSameOrigin` in
  `src/lib/server/security.ts`).
- Redaction runs before logs and API responses (`src/lib/redact.ts`).
- The development server uses its own database (plan §3.4). A key saved on `npm run dev` lands only
  in the development database, and development refresh stays disabled unless
  `AUD_DEV_LIVE_REFRESH=1`.
- The [access-dashboard-over-tailscale](../ready-for-human/access-dashboard-over-tailscale.md)
  brief would widen `allowedOrigins`. These new routes use the same guard, and that brief now
  records the question.

This repository runs Next.js 16.3.5. Before writing the route handlers, read
`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. Dynamic `params`
is a `Promise`, as in `src/app/api/providers/[provider]/refresh/route.ts`.

## Dependencies and Gates

None. The contract is decided. The new dependency `@floating-ui/react` is public on npm, and
installing it is inside this task. No real key is needed to implement or verify the work: tests use
fake keys and never reach a provider. Deploying and entering the real keys is the user's step
afterwards (see Out of scope).

## Scope

### In scope

- A `provider_credentials` table, a repository module, and a migration.
- Collection reads keys from the database at the start of every run.
- `GET /api/settings/credentials`, `PUT` and `DELETE /api/settings/credentials/[provider]`.
- A Settings button and a modal dialog built with `@floating-ui/react`.
- Removing the two variables from the configuration, the development launcher, test harnesses,
  `.env.example`, and the installer hint.
- One warning, naming the variables but never their values, when `npm run collect` still finds
  either variable set.
- Unit, integration, component, and Playwright coverage.
- Delivery documentation (see Approach step 10).

### Out of scope

- Deploying to the production checkout, entering the real keys, and deleting the key lines from
  `collector.env` or `.env.local`. The user does this after merge, following the updated Setup
  §4 and §6.
- Encrypting keys at rest.
- Checking a key against the provider when it is saved. The next collection or a manual refresh
  reports `auth_rejected` or `insufficient_scope` as it does today.
- Starting a collection on save.
- Settings for Codex, Claude, thresholds, or any other configuration.
- Changes to `allowedOrigins` or remote access.

## Approach

1. **Dependency.** Run `npm install --save-exact @floating-ui/react@0.27.20`. `package.json` pins
   every dependency exactly. Its peer ranges accept React 19.1.1, and it has no install scripts,
   so `allowScripts` does not change.

2. **Migration.** Add `drizzle/0002_provider_credentials.sql` with the header-comment style of
   `0000` and `0001`:

   ```sql
   CREATE TABLE provider_credentials (
     provider   TEXT PRIMARY KEY CHECK (provider IN ('deepseek', 'openrouter')),
     secret     TEXT NOT NULL CHECK (length(secret) > 0),
     updated_at TEXT NOT NULL
   ) STRICT;
   ```

   A missing row means no key is saved. Mirror the table as `providerCredentials` in
   `src/lib/db/schema.ts`, then run `npm run db:build-migrations`. Do not edit
   `migrations.generated.ts` by hand. `src/lib/db/backup.ts` compares a restored database with a
   fresh schema, so it covers the new table without changes.

3. **Shared types.** In `src/lib/domain.ts`, next to `PROVIDERS`, add:
   - `CREDENTIAL_PROVIDERS = ['deepseek', 'openrouter'] as const`, and the
     `CredentialProvider` type;
   - `isCredentialProvider(value: string): value is CredentialProvider`;
   - `CredentialStatus`, an interface with `provider`, `configured: boolean`,
     `hint: string | null`, and `updatedAt: string | null`.

   These live in `domain.ts` so the client dialog imports no database module.

4. **Repository.** Create `src/lib/db/credentials.ts`:
   - `ProviderCredentials`, an interface with `readonly deepseekApiKey: string | null` and
     `readonly openrouterManagementKey: string | null`. The field names stay the same so adapter
     call sites barely change.
   - `readProviderCredentials(db): ProviderCredentials`.
   - `saveProviderCredential(db, provider, secret, updatedAt = nowIso()): CredentialStatus`, an
     upsert on `provider`.
   - `removeProviderCredential(db, provider): CredentialStatus`. It is idempotent.
   - `listCredentialStatus(db): CredentialStatus[]`, returning both providers in
     `CREDENTIAL_PROVIDERS` order.
   - `credentialHint(secret): string | null`. It returns the last four characters when the
     secret is at least 16 characters long, and `null` otherwise, so a short key is never mostly
     revealed.

   A `CredentialStatus` never carries the secret. Validation lives in one exported zod schema
   here, `credentialSecretSchema`. It trims the value and requires 1–512 printable ASCII
   characters with no whitespace (`/^[\x21-\x7E]+$/`). Both the route and the repository apply
   it. `saveProviderCredential` throws on an invalid secret.

5. **Configuration and collection.**
   - `src/lib/config.ts`: remove `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` from
     `envSchema`, and `credentials` from `AppConfig` and `loadConfig`. Add
     `retiredCredentialEnvVars(env: EnvLike): string[]`, which returns the names of those two
     variables that are set and non-blank. Update the header comment: `collector.env` still
     carries `AUD_*` settings.
   - `src/lib/env-file.ts`: the header comment now describes `AUD_*` settings, not provider keys.
     The behavior does not change.
   - `src/lib/collector/index.ts`: `buildAdapters(config, credentials: ProviderCredentials)`.
     When `options.adapters` is absent, `collectOnce` calls `readProviderCredentials(options.db)`
     before `startRun`. Keys are read on every run and never cached, so a key saved in Settings
     applies to the next scheduled run and to an immediate manual refresh.
   - `scripts/collect.ts`: after the logger is created, if `retiredCredentialEnvVars(process.env)`
     is non-empty, log one `warn`,
     `provider key environment variables are ignored; save keys in dashboard Settings`, with
     `{ variables: [...] }`. Log the names only.
   - `src/lib/adapters/deepseek.ts` and `openrouter.ts`: change the `not_configured` messages to
     `DeepSeek API key is not saved in Settings` and `OpenRouter Management key is not saved in Settings`.
   - `src/lib/errors.ts`: set `ERROR_CODE_HINTS.not_configured` to
     `No credential is saved yet. Add it in Settings.` Only the two credential adapters raise
     this code.

6. **Development launcher and harnesses.**
   - `src/lib/dev-environment.ts`: delete the block that blanks the two variables in the child
     environment, and the parts of the header comment about keys. `AUD_REFRESH_ENABLED=0` still
     stops every provider, Codex included. With `AUD_DEV_LIVE_REFRESH=1`, refresh uses the keys
     saved in the development database.
   - `playwright.config.ts`: remove the blank `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY`
     entries and their comment. Keep the `AUD_ENV_FILE` redirect.
   - `tests/helpers/setup.ts`: remove the two `delete process.env[...]` lines. Keep the
     `AUD_ENV_FILE` and `AUD_DATA_DIR` handling.
   - `tests/helpers/spawn-recorder.mjs` and `tests/integration/next-wrapper.test.ts`: remove the
     `credentials` recording and its assertions.
   - `tests/unit/dev-environment.test.ts`: remove the key assertions from `credential isolation`,
     keep `decides the refresh flag itself…`, and rename the describe block to `refresh policy`.
   - `tests/live/live-smoke.test.ts`: read keys through
     `readProviderCredentials(openDb({ path: config.databasePath, readonly: true, migrate: false }))`
     inside a `try`, and close the handle. A missing database file or a missing
     `provider_credentials` table counts as no keys, so the gate skips. Never print a key.

7. **Routes.** Every handler sets `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`, sends
   `Cache-Control: no-store`, calls `requireSameOrigin` first (GET included, because its body is
   derived from credentials), never logs the request body, and turns an unexpected failure into
   `500 { error: { code: 'settings_failed', message: safeErrorMessage(err) } }`.
   - `src/app/api/settings/credentials/route.ts`: `GET` returns
     `200 { credentials: CredentialStatus[] }`.
   - `src/app/api/settings/credentials/[provider]/route.ts`:
     - `PUT`, with body `{ "secret": string }`. It answers `200 { credential: CredentialStatus }`.
       Errors are `400 invalid_provider` when the provider is not in `CREDENTIAL_PROVIDERS` (Codex
       and Claude included), `400 invalid_body` when the body is not JSON or has no string
       `secret`, and `400 invalid_secret` when `credentialSecretSchema` fails, with the message
       `Enter the key exactly as issued: printable characters, no spaces.` No response echoes the
       secret.
     - `DELETE`. It answers `200 { credential: CredentialStatus }` and is idempotent. An unknown
       provider gets `400 invalid_provider`.
   - Settings writes are allowed on the development server whatever `refreshEnabled` says. They
     touch only that server's database and reach no provider.

8. **Dialog.** Create `src/components/settings-dialog.tsx`, a `'use client'` component that takes
   `open` and `onOpenChange`:
   - Floating UI: `useFloating({ open, onOpenChange })`, `useDismiss` (Escape and an outside
     press), `useRole(context, { role: 'dialog' })`, `useInteractions`, `FloatingPortal`,
     `FloatingOverlay lockScroll` (a `bg-black/50` backdrop, with the panel centered), and
     `FloatingFocusManager` with `initialFocus` on the first input. Focus returns to the Settings
     button on close. The panel has `aria-labelledby` pointing at its `Settings` heading.
   - The panel uses `bg-surface border-border rounded-xl border shadow-sm`, `w-full max-w-md`, and
     `max-h-[calc(100dvh-2rem)] overflow-y-auto`, with `m-4` around it so it fits a 412 px viewport.
   - On open, it fetches `GET /api/settings/credentials` with `credentials: 'same-origin'` and
     shows a loading line until the response arrives.
   - It opens with the intro text
     `Keys are stored in the local dashboard database and used from the next collection. Use Refresh on a card to collect now.`
   - It shows one field per provider, in this order:
     - **DeepSeek API Key** (`data-testid="settings-input-deepseek"`).
     - **OpenRouter Management Key** (`settings-input-openrouter`), with helper text
       `Must be a Management key; ordinary inference keys are rejected.` and a link to
       `https://openrouter.ai/settings/management-keys` (`target="_blank" rel="noreferrer"`).

     Each input has `type="password"`, `autoComplete="off"`, and `spellCheck={false}`, and always
     starts empty. The saved key is never put into the input. Below each input, a status line
     (`settings-status-<provider>`) reads `Saved ••••<hint> · updated <age>` (or
     `Saved · updated <age>` when `hint` is `null`) or `Not set`. Ages come from `formatAge` in
     `src/lib/time.ts`. A configured provider also shows a **Remove** button
     (`settings-remove-<provider>`), which sends `DELETE` immediately. Use no browser `confirm()`.

   - The footer has **Cancel** (`settings-close`, closes the dialog) and **Save**
     (`settings-save`). Save is disabled while nothing is filled in or a request is pending. It
     sends one `PUT` per non-empty field, in order. It clears each input whose `PUT` succeeds,
     updates that provider's status, and shows `Saved.` (`settings-success`). A failed `PUT` keeps
     that input's value and shows the server's message in a `role="alert"` element
     (`settings-error`). The dialog stays open after saving.
   - It never writes a key to `console`, `localStorage`, or the URL.

9. **Button.** In `src/components/dashboard.tsx`, wrap **Reload view** and a new **Settings**
   button in `<div className="flex items-center gap-2">`. Settings sits to the right of Reload
   view and uses the same class list, the lucide `Settings` icon at `size-3.5`,
   `data-testid="open-settings"`, `aria-haspopup="dialog"`, and `aria-expanded={open}`. The
   dashboard owns the `open` state and renders `<SettingsDialog>`.

10. **Delivery documentation**, in the same change, using the `okf-sync` skill:
    - [Setup](../../operations/setup.md):
      - §1: replace the "Collector credentials" row. Add to "Backup and restore" that backups
        contain the saved keys.
      - §4: rewrite it around the Settings dialog. Keep the Management-key warning. Explain that
        the environment variables are ignored, and give the migration: deploy, save both keys,
        refresh both cards, then delete the key lines from `collector.env` and `.env.local`.
      - §6 "Development server": a saved key lives in the development database only.
      - §7: remove the two variable rows. `AUD_ENV_FILE` now carries `AUD_*` settings only.
      - §11: the application stores DeepSeek and OpenRouter keys only in its database, and never
        sends a full key to the browser.
    - `README.md`: the security bullet about credentials.
    - `.env.example`: remove both key entries, and reword the `AUD_DEV_LIVE_REFRESH` comment.
    - `scripts/install-systemd.sh`: the missing-env-file note says keys are saved in dashboard
      Settings, and the file holds only optional `AUD_*` overrides.
    - [m0-discovery](../../discovery/m0-discovery.md): one note under the DeepSeek and OpenRouter
      gates saying keys now come from Settings. The gate evidence stays as recorded.
    - Plan §0: mark §3.5 as implemented. Plan §3.4: the offline child no longer handles
      credential variables.
    - `docs/log.md`: an `Update` entry. `git mv` this brief to `docs/backlog/archive/` with status
      `Archived`.

## Files Touched

| Path                                                             | Change                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `package.json`, `package-lock.json`                              | add `@floating-ui/react` `0.27.20`, exact                         |
| `drizzle/0002_provider_credentials.sql`                          | new table                                                         |
| `src/lib/db/migrations.generated.ts`                             | regenerated by `npm run db:build-migrations`                      |
| `src/lib/db/schema.ts`                                           | `providerCredentials`                                             |
| `src/lib/db/credentials.ts`                                      | new repository, hint, secret schema                               |
| `src/lib/domain.ts`                                              | `CREDENTIAL_PROVIDERS`, `CredentialStatus`, guard                 |
| `src/lib/config.ts`                                              | drop credential env and `credentials`; `retiredCredentialEnvVars` |
| `src/lib/env-file.ts`                                            | header comment                                                    |
| `src/lib/collector/index.ts`                                     | read credentials from the database per run                        |
| `src/lib/adapters/deepseek.ts`, `src/lib/adapters/openrouter.ts` | `not_configured` messages                                         |
| `src/lib/errors.ts`                                              | `not_configured` hint                                             |
| `src/lib/dev-environment.ts`                                     | drop key blanking                                                 |
| `scripts/collect.ts`                                             | retired-variable warning                                          |
| `scripts/install-systemd.sh`                                     | env-file note                                                     |
| `src/app/api/settings/credentials/route.ts`                      | new `GET`                                                         |
| `src/app/api/settings/credentials/[provider]/route.ts`           | new `PUT`, `DELETE`                                               |
| `src/components/settings-dialog.tsx`                             | new dialog                                                        |
| `src/components/dashboard.tsx`                                   | Settings button and dialog state                                  |
| `playwright.config.ts`                                           | drop blank key env                                                |
| `tests/helpers/setup.ts`, `tests/helpers/spawn-recorder.mjs`     | drop credential env handling                                      |
| `tests/integration/credentials.test.ts`                          | new                                                               |
| `tests/integration/settings-route.test.ts`                       | new                                                               |
| `tests/integration/collector.test.ts`                            | keys read from the database                                       |
| `tests/integration/refresh-route.test.ts`                        | a saved key reaches the adapter                                   |
| `tests/integration/http-adapters.test.ts`                        | new `not_configured` message                                      |
| `tests/integration/next-wrapper.test.ts`                         | drop credential assertions                                        |
| `tests/unit/config-time.test.ts`, `tests/unit/env-file.test.ts`  | env keys ignored; `retiredCredentialEnvVars`                      |
| `tests/unit/dev-environment.test.ts`                             | drop key assertions                                               |
| `tests/unit/settings-dialog.test.tsx`                            | new, jsdom                                                        |
| `tests/unit/provider-card.test.tsx`                              | only if it asserts the old hint text                              |
| `tests/live/live-smoke.test.ts`                                  | read keys from the database                                       |
| `tests/e2e/credentials.ts`                                       | new helper `clearProviderKeys(request)`                           |
| `tests/e2e/settings.spec.ts`                                     | new                                                               |
| `tests/e2e/refresh.spec.ts`                                      | clear keys in `beforeEach`                                        |
| `.env.example`, `README.md`                                      | credentials text                                                  |
| `docs/operations/setup.md`, `docs/discovery/m0-discovery.md`     | delivery documentation                                            |
| `docs/plan/ai-usage-dashboard-implementation-plan.md`            | §0 and §3.4 delivery annotations                                  |
| `docs/log.md`, this brief                                        | `Update` entry; `git mv` to `archive/`                            |

Before finishing, run `grep -rn "DEEPSEEK_API_KEY\|OPENROUTER_MANAGEMENT_KEY\|credentials\.deepseek\|credentials\.openrouter" src scripts tests playwright.config.ts .env.example README.md`.
Only the retired-variable list in `src/lib/config.ts` and its tests may still match.

## Acceptance Criteria

- [ ] **Header.** A Settings button with a gear icon sits immediately to the right of Reload view
      and shares its styling. At the desktop (1280 px) and Pixel 7 widths, both buttons are
      visible and the page has no horizontal overflow.
- [ ] **Opening.** Clicking Settings opens a modal dialog named "Settings" with inputs labelled
      "DeepSeek API Key" and "OpenRouter Management Key". Focus moves to the DeepSeek input. Escape, an
      outside press, and Cancel each close it, and focus returns to the Settings button. Page
      scroll is locked while it is open. At Pixel 7 width the dialog fits inside the viewport.
- [ ] **Saving.** Saving a key stores it in `provider_credentials`, and the key persists across a
      page reload. The status then reads `Saved ••••<last 4>`, and the input is empty again.
- [ ] **Masking.** Neither the GET, PUT, or DELETE responses nor the rendered HTML contain a saved
      key beyond its last four characters. A key shorter than 16 characters shows no hint.
- [ ] **Removing.** Remove deletes the row and the status reads `Not set`. Removing a key that is
      not saved still returns 200.
- [ ] **Origin guard.** All three handlers answer `403` to a request with a foreign `Origin` or with
      neither `Origin` nor `Sec-Fetch-Site: same-origin`, and write nothing.
- [ ] **Validation.** `PUT` rejects an unknown or non-credential provider, a non-JSON body, a blank
      secret, a secret containing whitespace, and one longer than 512 characters, each with `400`
      and the documented code, and writes nothing.
- [ ] **Collection source.** `collectOnce` passes the saved keys to the DeepSeek and OpenRouter
      adapters, re-reading them on every run. With no rows, both attempts are `unavailable` /
      `not_configured`, even when `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` are set in
      the environment or in an `AUD_ENV_FILE`.
- [ ] **Manual refresh.** After a `PUT`, a manual refresh of that provider constructs its adapter
      with the saved key, with no server restart.
- [ ] **Retired variables.** `npm run collect` with either retired variable set logs one warning
      naming the variables, and no value appears in any output.
- [ ] **Development server.** `npm run dev` no longer rewrites the credential variables.
      Development refresh is still refused with `409 refresh_disabled` unless
      `AUD_DEV_LIVE_REFRESH=1`.
- [ ] **Migrations.** `migrations.generated.ts` matches `drizzle/`, and a backup written after the
      migration restores and passes the schema check.
- [ ] **Documentation.** The delivery documentation in Approach step 10 is updated, and the OKF
      validator passes.
- [ ] **Verification.** `npm run verify` and `npm run test:e2e` pass.

## Testing

Focused, while iterating:

```bash
npm run db:build-migrations
npx vitest run tests/unit/migrations-sync.test.ts tests/integration/db-backup.test.ts
npx vitest run tests/integration/credentials.test.ts tests/integration/settings-route.test.ts
npx vitest run tests/integration/collector.test.ts tests/integration/refresh-route.test.ts tests/integration/http-adapters.test.ts
npx vitest run tests/unit/config-time.test.ts tests/unit/env-file.test.ts tests/unit/dev-environment.test.ts tests/integration/next-wrapper.test.ts
npx vitest run tests/unit/settings-dialog.test.tsx
```

What each new suite proves:

- `tests/integration/credentials.test.ts`, on a real temp database (`createTestDb`):
  - upsert and read;
  - `updatedAt` changes on a second save;
  - remove is idempotent;
  - `listCredentialStatus` order, and no `secret` field on any status;
  - the hint at lengths 15 and 16;
  - the secret schema's trim, whitespace, and length rules;
  - the table's `CHECK` rejects `codex`.
- `tests/integration/settings-route.test.ts`, modelled on `refresh-route.test.ts` (with
  `server-only` mocked and a temp `AUD_DATA_DIR`):
  - every status and code in the acceptance criteria;
  - `JSON.stringify(body)` never contains the fake secret beyond its last four characters;
  - a rejected request leaves the table unchanged.
- `tests/integration/collector.test.ts`: `collectOnce` with a saved key hands exactly that key to
  a spied `createDeepseekAdapter` or `createOpenrouterAdapter`. With an empty table and env keys
  set, both are `not_configured`.
- `tests/unit/settings-dialog.test.tsx` (`// @vitest-environment jsdom`, `fetch` stubbed with
  `vi.fn`, `@testing-library/user-event`):
  - opening, focus, Escape, and returned focus;
  - statuses render from GET, and inputs start empty;
  - Save sends a `PUT` only for filled fields;
  - a failed `PUT` keeps its value and shows the alert;
  - Remove sends `DELETE`.

Browser proof: `tests/e2e/settings.spec.ts` runs in the desktop and mobile projects. It covers:

- button placement and no overflow;
- the dialog's role and name, and focus;
- save, reload, and the persisted masked status with an empty input;
- the page HTML and the GET response never contain the full fake key;
- Remove;
- dialog bounds inside the viewport on mobile.

Use fake keys only, such as `sk-e2e-0000000000001234`. Saving never triggers collection, so no
request reaches a provider. `clearProviderKeys` runs in `afterEach` of `settings.spec.ts` and in
`beforeEach` of `refresh.spec.ts`: the mobile project runs `refresh.spec.ts` after the desktop
project's settings spec, and DeepSeek must still have no key there. It sends `DELETE` for both
providers with `Origin: http://127.0.0.1:3939`. jsdom does not prove focus trapping, scroll lock,
or geometry; the Playwright spec does.

Completion gates:

```bash
npm run verify
npm run test:e2e
python3 .agents/skills/okf-sync/scripts/validate_okf_bundle.py
```

The production web unit serves the separate checkout at
`/home/bago/Workspace/ai-usage-dashboard-prod` (Setup §6). `npm run test:e2e`, which rebuilds
`.next`, is safe in the development checkout or a worktree, and must never run inside the
production checkout. For browser inspection outside the spec, AGENTS.md's `agent-browser` workflow
against `npm run dev` (`http://127.0.0.1:3839/`) is enough. A key saved there stays in the
development database.

Not performed in this task, and to be reported as such: live collection with real keys read from
the production database. The user checks it after deploying and saving the keys, by refreshing both
cards to `Healthy` and running `npm run test:live`.

## Open Questions
