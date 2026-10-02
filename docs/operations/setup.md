---
type: Setup Guide
title: Setup
description: Install, per-provider setup, systemd timer, config reference, and troubleshooting.
---

# Setup

A localhost-only dashboard for Codex and Claude Code subscription quota, and for
DeepSeek and OpenRouter prepaid balance.

It is designed to be useful before you configure anything. With an empty
environment every provider renders as `unavailable` with a setup hint, and each
one starts reporting the moment its source becomes available. You never have to
provision all four to get value from one.

---

## 1. Install and initialise

Requires Node.js 24.15 or a later Node 24 release (`engines.node` is `^24.15.0`). Node 25 no
longer bundles corepack and is not supported. Corepack runs the exact pnpm version that
`packageManager` in `package.json` pins and checks it against its sha512 hash. The first run
downloads that version; later runs use corepack's cache.

```bash
corepack enable pnpm            # once per Node installation: puts corepack's pnpm on PATH
pnpm install --frozen-lockfile  # exactly the locked versions; builds only allowlisted native modules
pnpm run db:migrate             # creates the SQLite database and applies migrations
pnpm run collect                # one collection pass
pnpm run build
pnpm run start                  # http://127.0.0.1:3838, serving the database just collected
```

`--frozen-lockfile` fails instead of changing `pnpm-lock.yaml` when it no longer matches
`package.json`.

`pnpm run db:migrate` prints where the database lives and which migrations ran.

`pnpm run dev` is for working on the dashboard itself. It runs beside production on
`127.0.0.1:3839` with its own empty database and never opens the one above; see
[Development server](#development-server).

`pnpm install` runs install scripts only for the exact package versions listed under
`allowBuilds` in `pnpm-workspace.yaml` (§10). That file also sets `pmOnFail: ignore`, so pnpm does
not record its own version in `pnpm-lock.yaml`. The lockfile then stays a single YAML document,
which GitHub's dependency graph can read. Corepack alone enforces the pinned version: a pnpm started
outside corepack ignores `packageManager`. `pnpm install` also wires the git hooks (`prepare` → Husky).
Every commit then runs `pre-commit` — Prettier over staged files, plus `typecheck` and the
tests related to staged files when any `*.ts`/`*.tsx` is staged — and
`commit-msg`, which enforces [Conventional Commits](https://www.conventionalcommits.org/)
with a subject of at most 72 characters. Docs-only commits skip the
type/test step but still get formatted and linted for message shape.

### Where data lives

Nothing runtime-related is stored inside the repository.

| What              | Default path                                                     | Mode                   |
| ----------------- | ---------------------------------------------------------------- | ---------------------- |
| Database          | `~/.local/share/ai-usage-dashboard/usage.db`                     | `0600`                 |
| Claude spool      | `~/.local/share/ai-usage-dashboard/spool/claude-statusline.json` | `0600`                 |
| Data directory    | `~/.local/share/ai-usage-dashboard/`                             | `0700`                 |
| Provider keys     | inside the database, saved from Settings (§4)                    | `0600` (the database)  |
| Optional settings | `~/.config/ai-usage-dashboard/collector.env`                     | `0600` (you create it) |

Override the base directory with `AUD_DATA_DIR`, using an absolute path or `~/…`.
A relative path is rejected at startup, because each process would resolve it
against its own working directory and open a different database. The default
honours `XDG_DATA_HOME` when that is absolute, and ignores it otherwise.

### Backup and restore

Copying `usage.db` by hand can miss the newest rows, which stay in `usage.db-wal` until SQLite
checkpoints them. Use the scripts instead:

```bash
pnpm run db:backup                   # <data dir>/backups/usage-<UTC timestamp>.db
pnpm run db:backup ~/usage-copy.db   # or a file of your choosing
```

A backup runs while the collector and the dashboard keep writing, and produces one verified `0600`
file. A backup inside the data directory does not survive losing the disk, so copy it elsewhere too.

A backup contains the DeepSeek, OpenRouter and OpenCode Go keys saved in Settings (§4), and the Claude token when
one is saved (§3), in plaintext, as the database holds them. Keep every copy owner-only, and delete copies you no longer need.

To restore, stop everything that has the database open, restore, and start it again. Leave the web
unit out of both `systemctl` lines if you did not install it.

```bash
systemctl --user stop ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service
pnpm run db:restore ~/usage-copy.db
systemctl --user start ai-usage-dashboard-collector.timer ai-usage-dashboard-web.service
```

The restore refuses, and changes nothing, in any of these cases:

- a process still holds the database open, including a collector run already in progress or a
  `pnpm run start`;
- the file is not an intact dashboard database;
- once migrated, it lacks a table, column, index or trigger this build creates, even when it records
  every migration;
- it comes from a newer build;
- it is a live database copied with a non-empty WAL beside it.

A backup from an older build is migrated forward. The database it replaces moves aside, together
with its WAL, to `usage.db.pre-restore-<UTC timestamp>`. Delete that once the restored dashboard
looks right.

---

## 2. Codex

Nothing to configure. The adapter spawns `codex app-server`, performs the
official JSON-RPC handshake, and calls `account/rateLimits/read`.

Authentication stays entirely inside the Codex CLI. This application never reads
`~/.codex/auth.json`, never extracts a token, and never calls the OpenAI backend
directly. If `codex` is logged in, the card works.

Minimum supported version: **`codex-cli 0.154.0`**, the version the adapter is live-verified against
([M0 Discovery](../discovery/m0-discovery.md)). Older releases are untested. Run
`pnpm run test:live` again after upgrading the CLI.

Verify:

```bash
codex --version
pnpm run collect
```

---

## 3. Claude Code

Claude quota is **pushed** by default, not polled. The status line is the only
documented interface that carries `rate_limits`, so a small bridge script records
it. Because the status line only fires during a session, you can also opt into a
probe that reads quota while no session is reporting; see
[Optional: read quota without a session](#optional-read-quota-without-a-session).

The bridge receives the full status-line payload — which includes `session_id`,
`transcript_path`, `cwd`, workspace/repo identity and session cost — and writes
**only** the rate-limit percentages, their reset times, and an observation
timestamp. Everything else is discarded in the process that saw it, so it never
reaches the collector, the database, or the browser.

### Install

```bash
pnpm run claude:install-statusline           # dry run: shows exactly what it would write
pnpm run claude:install-statusline --apply
```

Run it from the checkout that serves production: the [production checkout](production-checkout.md)
once you have one.
The installed command runs the bridge by absolute path from the checkout the installer ran in, so an
installation made from the development repository follows whatever branch is checked out there.
Re-running `--apply` from the right checkout refreshes this project's own status line in place and
keeps any status line it wraps. pnpm hands flags written after the script name straight to the
script, so no `--` is needed.

Then **start a Claude Code session and send one prompt**. `rate_limits` only
appears after a session's first API response, so an idle session records nothing.

```bash
pnpm run collect     # ingests the spool
```

### If you already have a status line

The installer **will not overwrite it**. It stops and prints your options:

```bash
# Compose: the bridge runs your existing command and prints its output verbatim.
pnpm run claude:install-statusline --apply --wrap-existing

# Or configure it yourself:
pnpm run claude:install-statusline --print
```

Your previous `settings.json` is copied to `settings.json.backup-<timestamp>`
before anything is written.

### Remove

```bash
pnpm run claude:install-statusline --uninstall --apply
```

This refuses to remove a status line it did not install.

### Requirements

`rate_limits` is emitted for Claude.ai Pro/Max accounts (and gateways with a
spend limit). If your account does not expose it, the bridge still runs and the
card reads `unavailable` with the reason _"the status line ran but this account
exposed no rate_limits"_ — which is a different, and more useful, message than
"no event yet".

Minimum supported version: **Claude Code 2.1.269**, the version whose status-line `rate_limits` the
bridge is live-verified against ([M0 Discovery](../discovery/m0-discovery.md)). Older releases are
untested.

### Optional: read quota without a session

The bridge only records quota while a session is live, so an idle machine drifts to
`stale` or `no_event_yet`. With a Claude token saved, the collector can also send a quota probe: a
`POST https://api.anthropic.com/v1/messages` request to Claude Haiku asking for one output token.
Every response to a subscription token carries the account's five-hour and seven-day usage in its
`anthropic-ratelimit-unified-*` headers, the same state Claude Code forwards to the status line.
It is **off until you save a token**: without one, nothing is sent and Claude behaves exactly as
above.

**Each probe counts toward your Claude subscription usage.** It is real inference, a few tokens
each, so it is sent only when it can tell you something. The headers are undocumented, so a change
in them is expected rather than exceptional. The dashboard treats both facts that way:

- **Only when no session is reporting.** Each run reads the spool first. A status-line reading no
  older than the probe's freshness budget (three collect intervals) answers the run, and no probe
  is sent, so an active session costs nothing extra.
- **At most one probe per five minutes**, whatever triggers the run. The scheduled collector and a
  card's **Refresh** share one claim in the database, taken before each request, so a refused or
  failed request still spends the interval. A run inside the interval skips the probe and reads the
  spool. When the spool has nothing usable either, that run records nothing for Claude: the card
  keeps the last probe's result, ages it by the probe's freshness budget, and never turns
  `unavailable` just because a Refresh landed inside the interval. It reads `unavailable` only when
  no probe has produced a result yet.
  `AUD_CLAUDE_POLL_INTERVAL_MINUTES` (§7) can lengthen it; a value below `5` stops startup with a
  configuration error. Idle, the default spends at most 288 one-token requests a day.
- **Never retried.** A refusal is left for the next interval.
- **The spool stays the default and the fallback.** When a probe is sent, the run keeps whichever
  source observed most recently, so the card never shows two Claude readings. When the probe fails
  — a refusal, a network error, a timeout, or headers whose shape changed — the run uses the spool.
  Only when the spool has nothing usable does the card show the probe's error, such as
  `rate_limited`, `auth_rejected`, or `schema_mismatch`. A subscription at its limit answers `429`
  but still reports its windows; the card shows that as a reading at 100%, not as an error.
- **Only the five-hour and seven-day utilisation and reset headers are read.** The response body is
  discarded unread. The probe reports the status line's own `5 hour` and `7 day` windows, so the
  history chart draws one line per window whichever source observed it, and `AUD_THRESHOLDS`
  overrides such as `claude:five_hour` apply to both. The diagnostics panel's source version reads
  `claude-api/ratelimit-headers` when the probe supplied the reading and `claude-code/<version>`
  when the spool did.
- **No Claude Code identity.** The request carries no system prompt and the dashboard's own user
  agent. Haiku is the one model that accepts a subscription token on those terms.

Unproven: whether a probe sent while no five-hour window is open starts one, which would move that
window's reset time; and how the probe is billed on an account with extra usage enabled.

The probe depends on Claude Haiku 4.5, the only current model known to accept a subscription token
without Claude Code's identity prompt. When Anthropic retires it, the card shows `schema_mismatch`
and falls back to the status line until a release changes the model. A later Haiku may not share
that exemption; the dashboard will not work around that by presenting itself as Claude Code.

The collector never reads `~/.claude/.credentials.json`. The token is one you mint for this
dashboard. It cannot read the `/api/oauth/usage` endpoint Claude Code uses for `/usage`: a
`claude setup-token` token lacks the `user:profile` scope that endpoint requires.

#### Claude token lifecycle

The token is long-lived and stored in plaintext in the database, like the other keys (§4).

1. **Mint.** Run `claude setup-token`, then paste the token into **Claude Token (optional)** in
   dashboard **Settings** and select **Save**. Never put it in `collector.env`, an environment
   variable, or `.env.local`; none of them is read. It applies from the next collection, or select
   **Refresh** on the Claude card.
2. **Revoke.** Removing the token in Settings deletes only the dashboard's copy; the token stays
   valid at Anthropic until you revoke it there. Revoke it on claude.ai → **Settings** →
   **Claude Code**, one authorisation at a time. There is no CLI path: `claude setup-token` only
   mints, and `claude auth logout` ends your interactive session, not the standalone token. The
   Anthropic Console's API key page does not list these tokens; it manages organisation API keys, a
   different mechanism.
3. **Verify the revocation.** Send one probe with the old token. It reads the token without echoing
   it, so nothing lands in your shell history, and prints only the status code:

   ```bash
   read -rs CLAUDE_OLD_TOKEN && curl -sS -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $CLAUDE_OLD_TOKEN" -H 'anthropic-version: 2023-06-01' \
     -H 'anthropic-beta: oauth-2025-04-20' -H 'content-type: application/json' \
     -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"."}]}' \
     https://api.anthropic.com/v1/messages; unset CLAUDE_OLD_TOKEN
   ```

   A revoked token answers `401`. A `200` means the token still works and spent one probe's worth
   of usage.

4. **Remove it from Settings** with **Remove**, so the database stops holding a dead secret. The
   card returns to the status-line spool.

---

## 4. DeepSeek, OpenRouter, and OpenCode Go

Both need a key, and both keys are entered in the dashboard. Open it, select
**Settings** next to **Reload view**, paste the **DeepSeek API Key** and the
**OpenRouter Management Key**, and select **Save**. A field left empty keeps its
saved key. Surrounding spaces and a trailing newline are removed; a key with a
space inside it is refused.

The keys are stored in the dashboard's SQLite database, in plaintext, protected by
the database's owner-only (`0600`) mode, so `pnpm run db:backup` files contain them
too (§1). Every collection path reads them from there at the start of each run:
the systemd collector, `pnpm run collect`, and a card's **Refresh**. A saved key is
used from the next collection, and **Refresh** on a card collects now. Saving does
not check the key with the provider: a rejected key shows up on the next
collection as `auth_rejected`, or as `insufficient_scope` for an OpenRouter
inference key.

The dashboard never shows a saved key again. For each provider it receives only
whether a key is saved, its last four characters (for keys of at least 16
characters), and when it was saved. **Remove** deletes the dashboard's copy at
once. Neither action creates, changes, or revokes anything at the provider. The
settings API requires a same-origin request, reads included.

The environment variables `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` are
no longer read from `collector.env`, your shell, or a repository `.env.local`.
While either is still set, `pnpm run collect` logs one warning that names the
variables and never their values.

### Upgrading from keys in `collector.env`

Only an install that predates the Settings dialog needs these steps; a fresh
install saves the keys in Settings directly. After an upgrade from a build that
read keys from the environment, the DeepSeek and OpenRouter cards read
`unavailable` until the keys are saved in Settings:

1. Deploy the new build ([Production checkout](production-checkout.md)).
2. Open the dashboard, select **Settings**, and save both keys.
3. Select **Refresh** on the DeepSeek and OpenRouter cards. Both should turn
   `Healthy`.
4. Delete the `DEEPSEEK_API_KEY` and `OPENROUTER_MANAGEMENT_KEY` lines from
   `~/.config/ai-usage-dashboard/collector.env` and from any repository
   `.env.local`. The file may keep its `AUD_*` settings.

### OpenRouter needs a _Management_ key

`GET /api/v1/credits` rejects ordinary inference keys with **HTTP 403**. Create a
management key at <https://openrouter.ai/settings/management-keys>.

> A management key can create, modify and delete your API keys. Treat it as a
> high-impact administrative credential: use a key dedicated to this dashboard,
> keep the database and its backups owner-only, and rotate the key if it is ever
> exposed. This application only ever issues `GET` requests with it, and never
> sends it to the browser (Settings receives at most its last four characters) —
> but the key itself is not read-only.

### What each provider reports

| Provider   | Reports                                                | Does **not** report                      |
| ---------- | ------------------------------------------------------ | ---------------------------------------- |
| DeepSeek   | balance per currency (`total`, `granted`, `topped up`) | any usage figure — the endpoint has none |
| OpenRouter | total credits, total usage, remaining (USD)            | per-model breakdown                      |

DeepSeek balance movement is labelled **balance change**, never usage: a balance
also moves on top-ups and expiring grants, so calling it spend would be a
fabricated number.

### OpenCode Go

OpenCode Go needs an OpenCode API key, saved the same way as the keys above: select
**Settings**, paste it into **OpenCode Go API Key**, select **Save**, then **Refresh**
on the OpenCode Go card. Keys are created in the OpenCode console
(<https://opencode.ai/auth>). The dashboard never reads OpenCode's own
`~/.local/share/opencode/auth.json`, so a key already used by the OpenCode CLI must be
pasted here to be used.

The collector reads `GET https://opencode.ai/zen/go/v1/usage` on every run. The
card shows three windows as the percentage **used** and its reset time:

| Window  | Label   | Resets                                              |
| ------- | ------- | --------------------------------------------------- |
| rolling | 5 hour  | five hours after the window opened                  |
| weekly  | 7 day   | Monday 00:00 UTC                                    |
| monthly | Monthly | on your billing anniversary, not the calendar month |

The card spans the full width of the grid. Beside the windows, a **Today** chart
draws each window's utilisation at the end of every local hour since midnight, from
the dashboard's own readings. An hour with no reading stays a gap, never a zero, and
hours are never summed. On the night the clocks go back, the repeated hour appears twice,
each labelled with its zone name, such as `1:00 EDT` and `1:00 EST`; an hour the clocks
skip is absent. A zone that moves its clocks by thirty minutes, such as Lord Howe, splits
that hour at the change, so the chart can show a `1:30` or `2:30` hour. The chart needs no
extra request to OpenCode.

It shows **percentages only**. OpenCode does not report the dollar limits, whether
the plan is Go or Go Plus, or your Zen balance, and the dashboard does not estimate
any of them. A window OpenCode marks `rate-limited` sets the card's advisory to
**Switch suggested**. If **Use balance** is enabled in the console, requests may
still succeed on Zen credit.

A card can read one point lower than the OpenCode console. The usage endpoint rounds
each percentage down to a whole number, while the console rounds to the nearest, so
40.6 % used shows as 40 % here and 41 % there. The dashboard stores the value exactly
as the endpoint reports it.

| Card shows                       | Meaning                                                |
| -------------------------------- | ------------------------------------------------------ |
| `unavailable` · `not_configured` | no key is saved                                        |
| `error` · `auth_rejected`        | OpenCode rejected the key (HTTP 401)                   |
| `unavailable` · `not_entitled`   | the key is valid but has no Go subscription (HTTP 403) |
| `error` · `schema_mismatch`      | the response changed shape; nothing from it was stored |

> The same key can run models and spend a Zen balance. Treat it like the OpenRouter
> Management key: keep the database and its backups owner-only, and rotate the key
> in the console if it is ever exposed. The dashboard only issues `GET` requests to
> the usage endpoint with it, and Settings never receives more than its last four
> characters.

The endpoint is not yet in OpenCode's public docs; it was added in
[anomalyco/opencode#16513](https://github.com/anomalyco/opencode/pull/16513). A shape
change shows up as `schema_mismatch` rather than as a wrong number.

---

## 5. Scheduled collection (systemd)

Nothing is installed or enabled without an explicit flag.

The units run from whichever checkout the installer runs in. For the production
timer and web unit, run every `scripts/install-systemd.sh --install` below from
the [production checkout](production-checkout.md).

```bash
# Render the units so you can read them first (this is the default).
pnpm run systemd:install

# Copy them into ~/.config/systemd/user/
scripts/install-systemd.sh --install

# Copy, enable and start the 5-minute timer.
scripts/install-systemd.sh --install --enable
```

Manage it:

```bash
scripts/install-systemd.sh --status      # timer state + last 20 log lines
scripts/install-systemd.sh --disable     # stop and disable
systemctl --user list-timers ai-usage-dashboard-collector.timer
journalctl --user -u ai-usage-dashboard-collector.service -f
```

To survive logout and reboot:

```bash
loginctl enable-linger "$USER"
```

The generated unit uses absolute paths for `node` and `tsx` (a user service has
no `PATH` from your shell), `UMask=0077`, a bounded `TimeoutStartSec`, and a
restricted sandbox (`ProtectSystem=strict`, `ProtectHome=read-only`, with only
the data directory and `CODEX_HOME` writable). Absolute paths alone are not
enough for Codex: the adapter spawns `codex` by name, and an nvm-installed
`codex` is a `#!/usr/bin/env node` script, so the installer also bakes a `PATH`
covering the `node` and `codex` directories found at install time. `codex
app-server` exits early when `~/.codex` is read-only, hence the second writable
path. Re-run the installer after switching Node versions with nvm. The timer uses `Persistent=true` so one missed run
is caught up after a reboot rather than leaving the dashboard stale for a full
interval.

The installer resolves the environment file, `AUD_DATA_DIR`,
`AUD_COLLECT_INTERVAL_MINUTES`, `AUD_HOST` and `AUD_PORT` the way the collector
does — shell exports, then `collector.env`, then defaults — and bakes them into
the units, so the writable path, the timer, the collector, and the web server's
bind address cannot point at different places or differ from what the installer
reports. An invalid value stops the installer before anything is rendered.
**Re-run the installer after changing any of these settings**, in the shell or in
`collector.env`, and after pulling a change to `systemd/*.template`: the installed
units keep the values and text they were rendered with. To re-render without
restarting anything, run `scripts/install-systemd.sh --install`, adding
`--with-web` when the web unit is installed; `--install` copies the units and
reloads systemd but starts and restarts nothing.

Values are substituted literally and escaped for systemd, so a path containing
`&`, `|` or `%` is rendered unchanged. A path the unit cannot carry safely —
one containing whitespace, a quote, a backslash or a control character — is
refused with an error instead of being rendered into a unit that points
elsewhere; move the data directory, repository or Node installation to a path
without them.

**Exit codes:** `0` every provider was success or unavailable; `1` at least one
provider errored (the run still persisted everything else); `2` the run could
not start. A provider being unavailable is a normal steady state and never makes
the unit look broken.

---

## 6. Running the dashboard

```bash
pnpm run build
pnpm run start      # http://127.0.0.1:3838
```

The server binds explicitly to `127.0.0.1`. `AUD_HOST` accepts only loopback
values and **fails at startup** on anything else — exposing this dashboard needs
authentication, TLS and an origin policy first, and none of those exist yet.

Manual refresh uses `POST`, requires a same-origin request, and is rate limited
to 6 refreshes per provider per minute.

### Development server

`pnpm run dev` is safe to run while the production dashboard is up. With no
development variables set it:

- binds `127.0.0.1:3839` (still `AUD_HOST`, but never `AUD_PORT`);
- opens its own database in `~/.local/share/ai-usage-dashboard-dev/`, or
  `$XDG_DATA_HOME/ai-usage-dashboard-dev` when that is absolute, and never the
  production `AUD_DATA_DIR`, even when `collector.env` sets it;
- refuses manual refresh with `409 refresh_disabled` before the rate limiter, the
  database, or any provider is touched. The card shows that message;
- reads DeepSeek and OpenRouter keys only from its own database. A key saved in
  **Settings** there lands in the development database, never the production
  one, and saving or removing a key works whatever the refresh setting.

The development database starts empty, and production data is never copied into
it. To see every card state:

```bash
pnpm run seed:dev     # replaces the seeded runs in the development database only
```

To let manual refresh collect for real, using the keys saved in the development
server's Settings and writing only the development database:

```bash
AUD_DEV_LIVE_REFRESH=1 pnpm run dev
```

`AUD_DEV_PORT`, `AUD_DEV_DATA_DIR` and `AUD_DEV_LIVE_REFRESH` (§7) are read only by
`pnpm run dev` and `pnpm run seed:dev`. An invalid value, an `AUD_DEV_PORT` equal
to the production `AUD_PORT`, or an `AUD_DEV_DATA_DIR` that resolves to the
production data directory (through symlinks, even before either directory
exists) or cannot be resolved at all (a symlink loop) stops them with exit code `2`
before Next.js starts or a database opens. `AUD_DEV_LIVE_REFRESH` accepts only
`0` or `1`; leave it unset rather than blank. Neither `pnpm run start`, `pnpm run collect`, nor the systemd
units read them. Pass a different port through `AUD_DEV_PORT`; a `--port` or
`--hostname` flag is refused.

### Start on boot (systemd)

To have the dashboard up whenever the machine is, install the web unit next to
the collector. It serves an existing production build, so it is installed from
the production checkout by the [deploy procedure](production-checkout.md), which builds first.

The unit runs the same `scripts/next.ts start` path as `pnpm run start`, with the
collector's sandbox and resolved settings, so it reads the database the timer
writes. Manual refresh runs inside it, which is why the data directory and
`CODEX_HOME` are writable. It restarts on failure, at most five starts in five
minutes, and with linger enabled (§5) it starts at boot without a login.

It never builds by itself — a slow or failing build at boot would leave the
dashboard down. At boot it serves whatever `.next` the production checkout holds,
which is always the build of the deployed commit.

Stop any `pnpm run start` first: the installer refuses to start the unit while
another process holds the port. A default `pnpm run dev` on `3839` can keep
running. `--status` includes the web unit once it is installed, and
`--disable --with-web` stops it along with the timer.
Follow its logs with `journalctl --user -u ai-usage-dashboard-web.service -f`.

### Production checkout

Production deploys and rollbacks run from a dedicated checkout, never the development repository.
The deploy, failure, and rollback procedure lives in
[Production checkout](production-checkout.md).

---

## 7. Configuration reference

Every value has a safe default; all are optional.

| Variable                           | Default                                      | Notes                                                                               |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AUD_DATA_DIR`                     | `~/.local/share/ai-usage-dashboard`          | database + spool; absolute or `~/…`                                                 |
| `AUD_TIMEZONE`                     | system timezone, `UTC` fallback              | the zone Node resolves; only affects calendar-day boundaries in history             |
| `AUD_HOST`                         | `127.0.0.1`                                  | loopback only; anything else is rejected                                            |
| `AUD_PORT`                         | `3838`                                       | `pnpm run start` and the web unit bind to it                                        |
| `AUD_DEV_PORT`                     | `3839`                                       | `pnpm run dev` only; must differ from `AUD_PORT`                                    |
| `AUD_DEV_DATA_DIR`                 | `~/.local/share/ai-usage-dashboard-dev`      | `pnpm run dev` / `seed:dev` only; absolute or `~/…`; never the production directory |
| `AUD_DEV_LIVE_REFRESH`             | `0`                                          | `0` or `1` only; `1` lets development refresh collect; see §6                       |
| `AUD_THRESHOLDS`                   | —                                            | JSON advisory overrides; see Thresholds below                                       |
| `AUD_RETENTION_DAYS`               | `90`                                         |                                                                                     |
| `AUD_COLLECT_INTERVAL_MINUTES`     | `5`                                          | also drives the freshness budget                                                    |
| `AUD_CLAUDE_POLL_INTERVAL_MINUTES` | `5`                                          | minimum spacing of Claude quota probes (§3); below `5` is rejected, not clamped     |
| `AUD_LOG_LEVEL`                    | `info`                                       | `debug` \| `info` \| `warn` \| `error`                                              |
| `AUD_ENV_FILE`                     | `~/.config/ai-usage-dashboard/collector.env` | optional `AUD_*` settings file, absolute or `~/…`; never keys (§4)                  |

### Thresholds

Defaults live in `src/lib/config.ts`. Quota thresholds are expressed as
**remaining** percent; balance thresholds are keyed `provider:CURRENCY` so USD
and CNY never share a limit.

| Key                   | `watch`          | `switch_suggested` |
| --------------------- | ---------------- | ------------------ |
| quota (all providers) | ≤ 20 % remaining | ≤ 10 % remaining   |
| `deepseek:USD`        | ≤ 5              | ≤ 1                |
| `deepseek:CNY`        | ≤ 35             | ≤ 7                |
| `openrouter:USD`      | ≤ 5              | ≤ 1                |

Override any of them with `AUD_THRESHOLDS`, a JSON object merged over the
defaults key by key (set it in your shell or in `collector.env`):

```bash
AUD_THRESHOLDS='{"quota":{"codex:secondary":{"watchAtOrBelowPercent":30,"switchAtOrBelowPercent":15}},"balance":{"deepseek:USD":{"watchAtOrBelow":"10","switchAtOrBelow":"2"}}}'
```

A quota window uses the most specific key present: `provider:bucket:window`,
then `provider:window`, then `provider`, then `default`. Balance keys are
`provider:CURRENCY`, with amounts as decimal strings so they compare exactly.
An override that does not parse, names an unknown provider, or sets `switch`
above `watch` stops startup with a configuration error instead of being ignored.

---

## 8. Reading the dashboard

### Card status

| Status        | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `healthy`     | last collection succeeded and the observation is within its freshness budget         |
| `stale`       | it succeeded before, but the data is too old **or** a quota window has reset since   |
| `unavailable` | not configured, not entitled, or nothing collected yet — a normal state, not a fault |
| `error`       | the source should have worked and an attempt failed                                  |

`error` and `stale` cards still show their last known numbers, with an explicit
_"these are not current"_ banner and the data's age.

### Advisories

`ok`, `watch`, `switch_suggested`, `unknown` — each with the reasons and the
exact threshold that fired.

**A card that is not `healthy` always yields `unknown`.** A `switch_suggested`
computed from a two-day-old percentage would be a guess presented as a fact, so
the dashboard refuses to make one.

### History

Each metric is aggregated according to what it actually is:

- **quota** — a gauge that resets. Charted as daily latest/min/max utilisation
  per window, never summed into a daily total.
- **OpenRouter `total_usage`** — a cumulative counter. Only a delta is
  meaningful, and a delta needs a reading from _before_ the period began. Without
  one you get "Insufficient history", not a zero.
- **DeepSeek balance** — labelled **balance change**, never usage.

A decreasing cumulative counter is reported as a **counter reset**, not as
negative usage.

---

## 9. Verification

```bash
pnpm run verify          # format + lint + typecheck + unit + integration
pnpm run test:e2e        # browser smoke, desktop and mobile
pnpm run test:live       # opt-in; skips any gate whose key is not saved
```

`pnpm run test:live` talks to the real CLI and real endpoints, with the keys saved
in the database `AUD_DATA_DIR` names. It asserts shape and reachability only,
prints no observed value or key, and never writes a fixture. With a Claude token
saved, it sends one quota probe (§3) through the same five-minute claim as the
collector, writing only that claim, and skips inside the interval.

Confirm the listener:

```bash
pnpm run start &
ss -ltnp | grep 3838      # expect 127.0.0.1:3838 and nothing else
```

---

## 10. Troubleshooting

**Claude says "no status-line event has been recorded yet"** — the bridge is not
installed, or no Claude session has produced an API response since it was.
Install it, send one prompt in a Claude session, then `pnpm run collect`.

**Claude says "the status line ran but this account exposed no rate_limits"** —
the bridge is working. This account or plan does not publish quota.

**Claude shows `rate_limited`, `auth_rejected`, or `schema_mismatch`** — the optional quota probe
(§3) failed and the status-line spool had nothing usable to fall back on. `rate_limited` clears on
its own at a later interval; do not refresh repeatedly, because the next probe is not allowed before
the interval anyway. `auth_rejected` means the saved token was revoked or has expired: mint a new
one and save it, or remove it to return to the spool. `schema_mismatch` means the rate-limit headers
changed shape, or Claude Haiku 4.5, the probe's model, was retired (§3). Claude reads from the spool again once the bridge
has recorded an event.

**OpenRouter shows `insufficient_scope`** — you used an inference key. The
credits endpoint needs a Management key.

**DeepSeek or OpenRouter shows `not_configured`** — no key is saved in the
database this dashboard reads. Save it in **Settings** (§4). A key in
`collector.env`, your shell, or `.env.local` is ignored, and a key saved on
`pnpm run dev` lands only in the development database.

**The timer runs but nothing updates** — check that the unit's `AUD_DATA_DIR`
matches its `ReadWritePaths` and the directory the dashboard reads (re-run the
installer after changing it):

```bash
systemctl --user cat ai-usage-dashboard-collector.service
journalctl --user -u ai-usage-dashboard-collector.service -n 50
```

**The dashboard says "database disk image is malformed"** — check the file on
disk first. `pnpm run db:backup` verifies the copy it writes, so a backup that
succeeds means the database is intact. Then the web server has lost track of the
database's WAL, a bug in builds before 2026-09-14. Redeploy it from the production
checkout ([Production checkout](production-checkout.md)); the procedure rebuilds `.next` and
restarts the web unit.

If the backup fails its integrity check, restore an earlier backup (§1).

**`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`** — a dependency has an install script and
its exact version is not under `allowBuilds` in `pnpm-workspace.yaml`, usually because an upgrade
changed the version of `better-sqlite3`, `/oxide`, `esbuild` or `unrs-resolver`. Review
that version, then run `pnpm approve-builds`. It writes bare package names, which would let every
future version run its script unreviewed, so rewrite each entry it adds as `name` and drop
the entry for the version it replaces. Approvals stay pinned to exact versions.

---

## 11. What this application never does

- read `~/.codex/auth.json`, extract an OAuth token, or call a provider backend
  with an extracted credential;
- store a raw provider payload, an email, an account ID, or the full status-line
  input. The only keys it stores are the DeepSeek and OpenRouter keys and the
  optional Claude token saved in Settings, and only in its database;
- read `~/.claude/.credentials.json` from the collector, or send the Claude quota
  probe without a token you saved, while a session is reporting, more than once
  per five minutes, or again after a refusal within the same interval;
- send a full DeepSeek or OpenRouter key, or any other credential, to the
  browser. Settings receives at most a key's last four characters;
- bind to anything but loopback;
- change your plan, buy credit, consume a reset credit, create, modify, or delete
  a key at the provider, or take any other billing action — it only ever issues
  reads to providers, apart from the optional Claude quota probe's one-token
  request, which counts toward your subscription usage (§3). Saving or removing a key in Settings changes only the
  dashboard's local copy;
- convert subscription quota into a currency estimate, or mix currencies;
- claim DeepSeek usage from a balance change.
