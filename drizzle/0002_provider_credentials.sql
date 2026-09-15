-- ---------------------------------------------------------------------------
-- 0002_provider_credentials — provider keys saved from dashboard Settings
--
-- Plan §3.5: the DeepSeek API key and the OpenRouter Management key are entered
-- in the dashboard and kept here in plaintext, protected by the database file's
-- owner-only (0600) mode. Backups of this database therefore contain them.
--
-- A missing row means no key is saved. Codex and Claude authenticate through
-- their own CLIs and never get a row, which the provider CHECK enforces.
-- ---------------------------------------------------------------------------

CREATE TABLE provider_credentials (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('deepseek', 'openrouter')),
  secret     TEXT NOT NULL CHECK (length(secret) > 0),
  updated_at TEXT NOT NULL
) STRICT;
