# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-10

### Added

- macOS scheduling: per-user launchd LaunchAgents run the collector, and optionally the
  dashboard at login, through `scripts/install-launchd.sh`; an isolated real-Mac harness and a
  macOS 15 ARM64 CI job join the Linux verification. Collection while logged out is out of
  scope, and the user-assisted sleep/wake, logout/login, Login Items, and keyring checks
  remain open.
- Phone access over Tailscale: `AUD_ALLOWED_ORIGINS` lets an exact `https` origin pass the
  same-origin guard, so Refresh and Settings work from a phone through `tailscale serve` while
  the server stays bound to loopback (Setup §6).

### Fixed

- A macOS-only crash is prevented before it can happen: Node 24's bundled undici throws
  `EINVAL` from its HTTP/1.1 writer when a peer has reset the connection, which terminated the
  collector or the web server with an uncaught exception. The error is now ignored — it is a
  best-effort QoS hint — while every other error still surfaces.

## [0.2.0] - 2026-10-04

### Added

- Managed Linux installer: `curl … | bash` provisions a private, checksum-verified Node and
  Corepack runtime, detached release checkouts, and hardened user systemd units, without
  touching your default Node, nvm, shell profiles, or a manual checkout. The
  `ai-usage-dashboard` launcher adds `status`, `update` (staged, with database backup and
  automatic rollback), `uninstall` (keeps data and keys), and `claude-statusline`.
- `db:restore` on macOS: the in-use guard falls back to `lsof` where `/proc` is unavailable.

### Changed

- A Codex CLI that is not installed or not on `PATH` now reads `unavailable` with an install
  hint instead of an error, and no longer makes `pnpm run collect` exit `1`.

### Fixed

- A CLI that exits before reading its input no longer crashes the collector with an unhandled
  `EPIPE`; the attempt is recorded as `process_failed`.

## [0.1.0] - 2026-10-03

First public release.

### Added

- Loopback-only dashboard with five provider cards: Codex, Claude Code, and OpenCode Go
  (subscription quota), plus DeepSeek and OpenRouter (prepaid balance).
- One-shot collector (`pnpm run collect`) shared by the systemd timer and manual refresh, with
  SQLite WAL storage, an audit trail for every attempt, 90-day retention, and per-source freshness.
- Optional Claude quota probe, at most one probe per five minutes, which spends a few tokens of
  subscription usage.
- Settings dialog that saves the DeepSeek, OpenRouter, and OpenCode Go keys and the optional Claude
  token into the owner-only database.
- `db:backup` and `db:restore` with an integrity check and a pre-restore copy.
- systemd collector timer and optional web unit, plus a development server on an isolated port and
  data directory.
- MIT license, third-party notices for the Lobe Icons marks, contributing and security policies,
  GitHub issue templates, and CI that runs `pnpm run verify`.

[0.3.0]: https://github.com/baktiaditya/ai-usage-dashboard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/baktiaditya/ai-usage-dashboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/baktiaditya/ai-usage-dashboard/releases/tag/v0.1.0
