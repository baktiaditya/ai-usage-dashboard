# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's security advisories: open the repository's
**Security** tab and select **Report a vulnerability**. Do not open a public issue for a suspected
vulnerability. Include the affected version or commit, a description, reproduction steps, and the
impact you expect. This is a single-maintainer project, so please allow time for a fix before any
public disclosure.

## Supported versions

Security fixes target the latest commit on `main`. There are no maintained release branches.

## What this application stores

The dashboard is a loopback-only, single-user application. It stores four credentials in plaintext
in its SQLite database (`usage.db`), protected by the database file's owner-only (`0600`) mode and
the data directory's `0700` mode:

- the DeepSeek API key;
- the OpenRouter Management key, an administrative credential that can create, modify, and delete
  your OpenRouter API keys;
- the OpenCode API key, which can also authorise inference and spend a Zen balance;
- the optional Claude `setup-token` token.

They are entered in the dashboard's **Settings** dialog and read from the database at the start of
each collection; they are never read from environment files. `pnpm run db:backup` writes a `0600`
copy that contains the same plaintext secrets. Keep every backup owner-only, store copies somewhere
as protected as the original, and delete ones you no longer need. Removing a key in Settings
deletes only the dashboard's copy; revoke it at the provider too if it may have been exposed.

The browser never receives a key: the settings API returns only whether one is saved, its last four
characters (for keys long enough that this reveals little), and when it was saved. Every settings
route requires a same-origin request.

## Claude quota probe

When you save a Claude token, the optional quota probe sends a minimal
`POST https://api.anthropic.com/v1/messages` request (to Claude Haiku, one output token) to read
the subscription rate-limit headers. **Each probe is real inference and spends a few tokens of your
Claude subscription usage.** It is rate limited to at most one probe per five minutes and is never
retried within an interval.

## Scope

- The server binds only to loopback and rejects a non-loopback `AUD_HOST` at startup; exposing it
  beyond the machine is explicitly unsupported until authentication, TLS, and an origin policy
  exist.
- Adapters allowlist fields and discard raw provider payloads; account IDs, emails, session IDs,
  and transcript paths are never persisted.
- A redaction pass runs before log writes, persisted diagnostics, API responses, and rendered
  strings.
