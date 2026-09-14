-- ---------------------------------------------------------------------------
-- 0000_initial — collector audit trail, immutable observations, derived nothing
--
-- Type policy:
--   * timestamps  TEXT, UTC ISO-8601 ("2026-09-12T04:00:00.000Z"); lexical order
--                 equals chronological order, so range scans work without
--                 parsing.
--   * money       TEXT, canonical decimal string. SQLite REAL is never used for
--                 money — see src/lib/money.ts.
--   * percentages REAL. A quota gauge is a measurement, not an amount, and no
--                 exact-sum invariant applies to it.
--   * booleans    INTEGER 0/1, nullable where "the source did not say" is a
--                 meaningful third state.
--
-- Nothing derived is stored: card status, freshness and advisories are all
-- computed at query time from these immutable rows plus configuration.
-- ---------------------------------------------------------------------------

-- `schema_migrations` is created and owned by the migration runner itself
-- (src/lib/db/client.ts) before any migration executes, so it is deliberately
-- absent here.

-- One row per invocation of the collector, whatever triggered it.
CREATE TABLE collector_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
) STRICT;

CREATE INDEX idx_collector_runs_started_at ON collector_runs (started_at DESC);

-- One row per provider per run. Success/failure counts are derived from these
-- rows rather than denormalised onto the run, so they cannot drift apart.
CREATE TABLE collector_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES collector_runs (id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'deepseek', 'openrouter')),
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

CREATE INDEX idx_collector_attempts_provider_started
  ON collector_attempts (provider, started_at DESC);
CREATE INDEX idx_collector_attempts_run ON collector_attempts (run_id);

-- An immutable observation. Every successful poll is its own historical row;
-- only event-driven sources deduplicate, via source_event_id.
CREATE TABLE provider_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_attempt_id INTEGER NOT NULL REFERENCES collector_attempts (id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'deepseek', 'openrouter')),
  kind                TEXT NOT NULL CHECK (kind IN ('quota', 'credit')),
  source_observed_at  TEXT NOT NULL,
  collected_at        TEXT NOT NULL,
  source_version      TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  source_event_id     TEXT,
  usage_allowed       INTEGER CHECK (usage_allowed IN (0, 1)),
  limit_reached_code  TEXT
) STRICT;

-- Partial uniqueness: polled sources (NULL event id) are never deduplicated,
-- event sources are. Re-ingesting the same Claude status-line event is a no-op.
CREATE UNIQUE INDEX uq_provider_snapshots_event
  ON provider_snapshots (provider, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX idx_provider_snapshots_provider_observed
  ON provider_snapshots (provider, source_observed_at DESC);
CREATE INDEX idx_provider_snapshots_collected ON provider_snapshots (collected_at);

CREATE TABLE quota_windows (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id             INTEGER NOT NULL REFERENCES provider_snapshots (id) ON DELETE CASCADE,
  bucket_id               TEXT NOT NULL,
  window_kind             TEXT NOT NULL,
  used_percent            REAL NOT NULL CHECK (used_percent >= 0.0 AND used_percent <= 100.0),
  window_duration_minutes INTEGER,
  reset_at                TEXT,
  UNIQUE (snapshot_id, bucket_id, window_kind)
) STRICT;

CREATE INDEX idx_quota_windows_snapshot ON quota_windows (snapshot_id);

CREATE TABLE credit_balances (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id        INTEGER NOT NULL REFERENCES provider_snapshots (id) ON DELETE CASCADE,
  currency           TEXT NOT NULL,
  total_balance      TEXT,
  granted_balance    TEXT,
  topped_up_balance  TEXT,
  total_credits      TEXT,
  total_usage        TEXT,
  remaining_credit   TEXT,
  is_available       INTEGER CHECK (is_available IN (0, 1)),
  UNIQUE (snapshot_id, currency)
) STRICT;

CREATE INDEX idx_credit_balances_snapshot ON credit_balances (snapshot_id);
