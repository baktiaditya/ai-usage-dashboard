# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/baktiaditya/ai-usage-dashboard/releases/tag/v0.1.0
