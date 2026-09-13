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

```bash
npm install          # some deps build native code; approve when npm asks
npm run db:migrate   # creates the SQLite database and applies migrations
npm run collect      # one collection pass
npm run dev          # http://127.0.0.1:3838
```

`npm run db:migrate` prints where the database lives and which migrations ran.

`npm install` also wires the git hooks (`prepare` → Husky). Every commit
then runs `pre-commit` — Prettier over staged files, plus `typecheck` and the
tests related to staged files when any `*.ts`/`*.tsx` is staged — and
`commit-msg`, which enforces [Conventional Commits](https://www.conventionalcommits.org/)
with a subject of at most 72 characters. Docs-only commits skip the
type/test step but still get formatted and linted for message shape.

### Where data lives

Nothing runtime-related is stored inside the repository.

| What                  | Default path                                                     | Mode                   |
| --------------------- | ---------------------------------------------------------------- | ---------------------- |
| Database              | `~/.local/share/ai-usage-dashboard/usage.db`                     | `0600`                 |
| Claude spool          | `~/.local/share/ai-usage-dashboard/spool/claude-statusline.json` | `0600`                 |
| Data directory        | `~/.local/share/ai-usage-dashboard/`                             | `0700`                 |
| Collector credentials | `~/.config/ai-usage-dashboard/collector.env`                     | `0600` (you create it) |

Override the base directory with `AUD_DATA_DIR`, using an absolute path or `~/…`.
A relative path is rejected at startup, because each process would resolve it
against its own working directory and open a different database. The default
honours `XDG_DATA_HOME` when that is absolute, and ignores it otherwise.

---

## 2. Codex

Nothing to configure. The adapter spawns `codex app-server`, performs the
official JSON-RPC handshake, and calls `account/rateLimits/read`.

Authentication stays entirely inside the Codex CLI. This application never reads
`~/.codex/auth.json`, never extracts a token, and never calls the OpenAI backend
directly. If `codex` is logged in, the card works.

Verify:

```bash
codex --version
npm run collect
```

---

## 3. Claude Code

Claude quota is **pushed**, not polled. The status line is the only documented
interface that carries `rate_limits`, so a small bridge script records it.

The bridge receives the full status-line payload — which includes `session_id`,
`transcript_path`, `cwd`, workspace/repo identity and session cost — and writes
**only** the rate-limit percentages, their reset times, and an observation
timestamp. Everything else is discarded in the process that saw it, so it never
reaches the collector, the database, or the browser.

### Install

```bash
npm run claude:install-statusline            # dry run: shows exactly what it would write
npm run claude:install-statusline -- --apply
```

Then **start a Claude Code session and send one prompt**. `rate_limits` only
appears after a session's first API response, so an idle session records nothing.

```bash
npm run collect     # ingests the spool
```

### If you already have a status line

The installer **will not overwrite it**. It stops and prints your options:

```bash
# Compose: the bridge runs your existing command and prints its output verbatim.
npm run claude:install-statusline -- --apply --wrap-existing

# Or configure it yourself:
npm run claude:install-statusline -- --print
```

Your previous `settings.json` is copied to `settings.json.backup-<timestamp>`
before anything is written.

### Remove

```bash
npm run claude:install-statusline -- --uninstall --apply
```

This refuses to remove a status line it did not install.

### Requirements

`rate_limits` is emitted for Claude.ai Pro/Max accounts (and gateways with a
spend limit). If your account does not expose it, the bridge still runs and the
card reads `unavailable` with the reason _"the status line ran but this account
exposed no rate_limits"_ — which is a different, and more useful, message than
"no event yet".

---

## 4. DeepSeek and OpenRouter

Both read a key from the collector's environment. A user systemd service does
**not** inherit your shell environment, so put them in a file:

```bash
mkdir -p ~/.config/ai-usage-dashboard
install -m 0600 /dev/null ~/.config/ai-usage-dashboard/collector.env
$EDITOR ~/.config/ai-usage-dashboard/collector.env
```

```ini
DEEPSEEK_API_KEY=...
OPENROUTER_MANAGEMENT_KEY=...
```

Every entry point loads this file itself: the systemd collector, `npm run
collect`, `npm run test:live`, and the dashboard's manual refresh. A variable
already set takes precedence over the file — an export in your shell, or a value
the installer baked into the unit (§5). Set `AUD_ENV_FILE` to use a different
path.

### OpenRouter needs a _Management_ key

`GET /api/v1/credits` rejects ordinary inference keys with **HTTP 403**. Create a
management key at <https://openrouter.ai/settings/management-keys>.

> A management key can create, modify and delete your API keys. Treat it as a
> high-impact administrative credential: keep the file `0600`, use a key
> dedicated to this dashboard, and rotate it if it is ever exposed. This
> application only ever issues `GET` requests with it, and never sends it to the
> browser — but the key itself is not read-only.

### What each provider reports

| Provider   | Reports                                                | Does **not** report                      |
| ---------- | ------------------------------------------------------ | ---------------------------------------- |
| DeepSeek   | balance per currency (`total`, `granted`, `topped up`) | any usage figure — the endpoint has none |
| OpenRouter | total credits, total usage, remaining (USD)            | per-model breakdown                      |

DeepSeek balance movement is labelled **balance change**, never usage: a balance
also moves on top-ups and expiring grants, so calling it spend would be a
fabricated number.

---

## 5. Scheduled collection (systemd)

Nothing is installed or enabled without an explicit flag.

```bash
# Render the units so you can read them first (this is the default).
npm run systemd:install

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

The installer resolves the environment file, `AUD_DATA_DIR`, and
`AUD_COLLECT_INTERVAL_MINUTES` the way the collector does — shell exports, then
`collector.env`, then defaults — and bakes them into the unit, so the writable
path, the timer, and the collector cannot point at different places. An invalid
value stops the installer before anything is rendered. **Re-run the installer
after changing either setting**, in the shell or in `collector.env`.

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
npm run build
npm run start      # http://127.0.0.1:3838
```

The server binds explicitly to `127.0.0.1`. `AUD_HOST` accepts only loopback
values and **fails at startup** on anything else — exposing this dashboard needs
authentication, TLS and an origin policy first, and none of those exist yet.

Manual refresh uses `POST`, requires a same-origin request, and is rate limited
to 6 refreshes per provider per minute.

---

## 7. Configuration reference

Every value has a safe default; all are optional.

| Variable                       | Default                                      | Notes                                           |
| ------------------------------ | -------------------------------------------- | ----------------------------------------------- |
| `AUD_DATA_DIR`                 | `~/.local/share/ai-usage-dashboard`          | database + spool; absolute or `~/…`             |
| `AUD_TIMEZONE`                 | `Asia/Jakarta`                               | only affects calendar-day boundaries in history |
| `AUD_HOST`                     | `127.0.0.1`                                  | loopback only; anything else is rejected        |
| `AUD_PORT`                     | `3838`                                       | `npm run dev` / `npm run start` bind to it      |
| `AUD_THRESHOLDS`               | —                                            | JSON advisory overrides; see Thresholds below   |
| `AUD_RETENTION_DAYS`           | `90`                                         |                                                 |
| `AUD_COLLECT_INTERVAL_MINUTES` | `5`                                          | also drives the freshness budget                |
| `AUD_LOG_LEVEL`                | `info`                                       | `debug` \| `info` \| `warn` \| `error`          |
| `AUD_ENV_FILE`                 | `~/.config/ai-usage-dashboard/collector.env` | credential file, absolute or `~/…`; see §4      |
| `DEEPSEEK_API_KEY`             | —                                            | absent ⇒ `unavailable`                          |
| `OPENROUTER_MANAGEMENT_KEY`    | —                                            | absent ⇒ `unavailable`                          |

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
npm run verify          # format + lint + typecheck + unit + integration
npm run test:e2e        # browser smoke, desktop and mobile
npm run test:live       # opt-in; skips any gate whose credential is absent
```

`npm run test:live` talks to the real CLI and real endpoints. It asserts shape
and reachability only, prints no observed value, and never writes a fixture.

Confirm the listener:

```bash
npm run start &
ss -ltnp | grep 3838      # expect 127.0.0.1:3838 and nothing else
```

---

## 10. Troubleshooting

**Claude says "no status-line event has been recorded yet"** — the bridge is not
installed, or no Claude session has produced an API response since it was.
Install it, send one prompt in a Claude session, then `npm run collect`.

**Claude says "the status line ran but this account exposed no rate_limits"** —
the bridge is working. This account or plan does not publish quota.

**OpenRouter shows `insufficient_scope`** — you used an inference key. The
credits endpoint needs a Management key.

**DeepSeek or OpenRouter shows `not_configured`** — the collector did not see
the key. A user systemd service does not inherit your shell environment; put it
in `~/.config/ai-usage-dashboard/collector.env`.

**The timer runs but nothing updates** — check that the unit's `AUD_DATA_DIR`
matches its `ReadWritePaths` and the directory the dashboard reads (re-run the
installer after changing it):

```bash
systemctl --user cat ai-usage-dashboard-collector.service
journalctl --user -u ai-usage-dashboard-collector.service -n 50
```

**`npm install` warns about install scripts** — `better-sqlite3` compiles a
native module. Approve it with `npm approve-scripts better-sqlite3`.

---

## 11. What this application never does

- read `~/.codex/auth.json`, extract an OAuth token, or call a provider backend
  with an extracted credential;
- store a raw provider payload, an API key, an email, an account ID, or the full
  status-line input;
- send any credential to the browser;
- bind to anything but loopback;
- change your plan, buy credit, consume a reset credit, create or modify an API
  key, or take any other billing action — it only ever issues reads;
- convert subscription quota into a currency estimate, or mix currencies;
- claim DeepSeek usage from a balance change.
