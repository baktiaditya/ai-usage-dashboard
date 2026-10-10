# Contributing

Thanks for considering a contribution. This is a small, single-maintainer project; issues and pull
requests are welcome.

## Opening a pull request

Report a bug or request a feature with the
[issue templates](https://github.com/baktiaditya/ai-usage-dashboard/issues/new/choose), and report
a suspected vulnerability privately as described in [SECURITY.md](SECURITY.md).

1. Fork the repository and clone your fork.
2. Create a branch, commit following [Commits](#commits) below, and push it to your fork.
3. Open a pull request against `main`; the
   [pull request template](.github/PULL_REQUEST_TEMPLATE.md) prompts for a summary, the
   verification you ran, and a checklist.
4. Push follow-up commits to the same branch — they join the open pull request automatically.
   Merging into `main` requires an approving review and a green `pnpm run verify` check.

Two first-time wrinkles are expected, not rejections:

- CI workflows on a pull request from a fork wait for a maintainer to approve them before they
  start, so checks can sit in "waiting for approval". GitHub applies this to first-time
  contributors by default.
- Commit with the email address linked to your GitHub account; the `main` ruleset asks for an
  extra approval when it cannot attribute a commit to an account.

## Platform and requirements

- Linux and macOS. Linux is the managed platform: scheduling uses user `systemd`, and the
  one-command installer provisions it. On macOS, manual installations get per-user `launchd`
  LaunchAgents ([Setup §5](docs/operations/setup.md#5-scheduled-collection)); the managed
  installer stays Linux-only, and sleep/wake, logout/login, and Login Items checks are still
  user-assisted. Windows is not supported.
- Node.js 24.15 or a later Node 24 release (`.nvmrc` names Node 24). Node 25 is not supported: it
  no longer bundles corepack.
- pnpm, enabled through corepack. `package.json` pins the exact version and its sha512 hash, so
  every contributor and CI install the same one.

## Setup

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run collect
pnpm run build
pnpm run start        # http://127.0.0.1:3838
```

`pnpm install` also wires the Husky git hooks. `pnpm run collect` marks every unconfigured provider
`unavailable` instead of failing; exit code `1` means at least one configured provider errored.

For UI work, `pnpm run dev` runs beside production on `http://127.0.0.1:3839` with its own empty
database, and `pnpm run seed:dev` fills it with every card state.

## Validation

`pnpm run verify` is the gate: Prettier check, ESLint, `tsc --noEmit`, unit tests, and integration
tests. Run it before opening a pull request. Focused checks while iterating:

```bash
pnpm exec vitest run tests/unit/config-time.test.ts   # one test file
pnpm run typecheck
pnpm run format
```

`pnpm run test:e2e` runs the Playwright browser smoke tests against a seeded production build in
`.playwright/data`, never your real collection history. It is a local check; CI runs `pnpm run verify`
on Linux and macOS 15 ARM64, plus the disposable-systemd `installation-systemd` rehearsal
(`pnpm run test:installation:systemd`). The Linux job also runs the OKF bundle validator and is the
only required check. A pull request whose diff is documentation-only — `docs/`, `.agents/`,
`.claude/`, `.vscode/`, or Markdown files — skips the macOS and rehearsal jobs, which cannot fail
for it. `pnpm run test:live` is an opt-in live probe that skips any provider whose key is not saved
and talks to real endpoints, so use it deliberately. Never point either command at the production
checkout or the production database.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a subject of at
most 72 characters, enforced by commitlint through the Husky `commit-msg` hook. The `pre-commit`
hook runs Prettier on staged files, then typecheck and the tests related to staged TypeScript when
any is staged.

## Optional agent tooling

`AGENTS.md`, `.mcp.json`, `.claude/`, and `.agents/` serve the maintainer's agent workflows
(code-review graph, browser automation, and the OKF documentation skills). They are optional:
nothing in the product, the build, or the test suite requires them, so you can ignore them.

## Adding a provider

OpenCode Go ([PR #20](https://github.com/baktiaditya/ai-usage-dashboard/pull/20)) is the most recent
complete example; follow its shape. Confirm each path against `src/` before you start, because the
provider lists are hard-coded.

1. **Domain.** Add the provider id to `PROVIDERS` in `src/lib/domain.ts` (that order is the display
   order), plus `PROVIDER_LABELS` and `PROVIDER_KIND`. Add it to `PROVIDER_PATTERN` in
   `src/lib/config.ts` too: that regex gates `AUD_THRESHOLDS` for every provider, keyless ones
   included. Only if the provider takes a key saved in Settings, also add it to
   `CREDENTIAL_PROVIDERS`.
2. **Adapter.** Add `src/lib/adapters/<provider>.ts` implementing `ProviderAdapter`, with sanitized
   fixtures under `tests/fixtures/<provider>/` and an adapter unit test. Wire it into
   `buildAdapters` in `src/lib/collector/index.ts`, and into the credential map in
   `src/lib/db/credentials.ts` when it has a saved key.
3. **Migration.** SQLite cannot alter a `CHECK` constraint, so widening the `provider` CHECK means
   rebuilding every table that carries it. Follow `drizzle/0004_opencode_go_provider.sql`: create a
   `<table>_rebuild`, copy every row with its id, drop the original, rename the rebuild into place,
   and recreate its indexes verbatim. `collector_attempts` and `provider_snapshots` are parents of
   `ON DELETE CASCADE` keys, so the runner applies migrations with foreign keys off and runs
   `PRAGMA foreign_key_check` before commit — a rebuild with enforcement on would delete the
   history. `tests/integration/migration-0004.test.ts` proves rows, ids, and cascades survive. New
   migration files are embedded with `pnpm run db:build-migrations`;
   `tests/unit/migrations-sync.test.ts` fails if `src/lib/db/migrations.generated.ts` drifts from
   `drizzle/`.
4. **Surface.** Add the logo mark to `src/components/provider-logo.tsx` and record its source and
   license in `THIRD_PARTY_NOTICES.md`; add the Settings field and label in
   `src/components/settings-dialog.tsx`; seed a demo state in `scripts/seed-demo.ts`; and handle any
   card or chart behavior driven by the provider kind in `src/lib/queries/overview.ts`.
5. **Docs.** Add the provider to the README table and Setup §4, record the contract in plan §3 and
   the gate result in `docs/discovery/m0-discovery.md`, and add an entry to `docs/log.md`.

Also extend the collector and migration integration tests so the new provider's success and failure
paths are covered.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
