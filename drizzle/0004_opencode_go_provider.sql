-- ---------------------------------------------------------------------------
-- 0004_opencode_go_provider — OpenCode Go joins as a fifth provider
--
-- Plan §3.1 and §3.5: OpenCode Go is a quota provider whose API key is saved
-- from dashboard Settings. Every provider CHECK must admit 'opencode_go', and
-- SQLite cannot alter a CHECK in place, so three tables are rebuilt.
--
-- Unlike 0001 and 0003, two of these tables are referenced: provider_snapshots
-- points at collector_attempts, and quota_windows and credit_balances point at
-- provider_snapshots, all ON DELETE CASCADE. Dropping a parent with
-- foreign_keys = ON would delete every child row, which is the whole history.
-- runMigrations therefore applies migrations with enforcement off and runs
-- PRAGMA foreign_key_check before commit, per SQLite's documented rebuild:
-- https://www.sqlite.org/lang_altertable.html#otheralter
--
-- Each table follows that order exactly: create <table>_rebuild, copy every row
-- with its id, drop the old table, rename the new one into place. The old table
-- is never renamed aside, because a rename rewrites child foreign keys to follow
-- it. Every column, constraint and index is otherwise copied verbatim from 0000
-- (and 0003 for provider_credentials). AUTOINCREMENT continues from the highest
-- copied id.
-- ---------------------------------------------------------------------------

CREATE TABLE collector_attempts_rebuild (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES collector_runs (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'deepseek', 'openrouter', 'opencode_go')),
  outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'unavailable', 'error')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  error_code   TEXT,
  safe_message TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  -- A failed attempt must explain itself; a successful one must not carry an
  -- error code that the UI would then have to ignore.
  CHECK (
    (outcome = 'success' AND error_code IS NULL) OR
    (outcome <> 'success' AND error_code IS NOT NULL)
  )
) STRICT;

INSERT INTO collector_attempts_rebuild
  (id, run_id, provider, outcome, started_at, finished_at, error_code, safe_message, retry_count)
SELECT id, run_id, provider, outcome, started_at, finished_at, error_code, safe_message, retry_count
FROM collector_attempts;

DROP TABLE collector_attempts;

ALTER TABLE collector_attempts_rebuild RENAME TO collector_attempts;

CREATE INDEX idx_collector_attempts_provider_started
  ON collector_attempts (provider, started_at DESC);
CREATE INDEX idx_collector_attempts_run ON collector_attempts (run_id);

CREATE TABLE provider_snapshots_rebuild (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_attempt_id INTEGER NOT NULL REFERENCES collector_attempts (id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'deepseek', 'openrouter', 'opencode_go')),
  kind                TEXT NOT NULL CHECK (kind IN ('quota', 'credit')),
  source_observed_at  TEXT NOT NULL,
  collected_at        TEXT NOT NULL,
  source_version      TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  source_event_id     TEXT,
  usage_allowed       INTEGER CHECK (usage_allowed IN (0, 1)),
  limit_reached_code  TEXT
) STRICT;

INSERT INTO provider_snapshots_rebuild
  (id, collector_attempt_id, provider, kind, source_observed_at, collected_at, source_version,
   schema_version, source_event_id, usage_allowed, limit_reached_code)
SELECT id, collector_attempt_id, provider, kind, source_observed_at, collected_at, source_version,
       schema_version, source_event_id, usage_allowed, limit_reached_code
FROM provider_snapshots;

DROP TABLE provider_snapshots;

ALTER TABLE provider_snapshots_rebuild RENAME TO provider_snapshots;

-- Partial uniqueness: polled sources (NULL event id) are never deduplicated,
-- event sources are. Re-ingesting the same Claude status-line event is a no-op.
CREATE UNIQUE INDEX uq_provider_snapshots_event
  ON provider_snapshots (provider, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX idx_provider_snapshots_provider_observed
  ON provider_snapshots (provider, source_observed_at DESC);
CREATE INDEX idx_provider_snapshots_collected ON provider_snapshots (collected_at);

CREATE TABLE provider_credentials_rebuild (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('deepseek', 'openrouter', 'claude', 'opencode_go')),
  secret     TEXT NOT NULL CHECK (length(secret) > 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO provider_credentials_rebuild (provider, secret, updated_at)
SELECT provider, secret, updated_at
FROM provider_credentials;

DROP TABLE provider_credentials;

ALTER TABLE provider_credentials_rebuild RENAME TO provider_credentials;
