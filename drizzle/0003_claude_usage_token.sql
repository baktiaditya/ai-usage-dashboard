-- ---------------------------------------------------------------------------
-- 0003_claude_usage_token — optional Claude token, and the Claude probe claim
--
-- Plan §3.1 and §3.5: when the user opts into the Claude quota probe, the token
-- they mint with `claude setup-token` is saved from dashboard Settings like the
-- DeepSeek and OpenRouter keys. That corrects the header of 0002, which still
-- says Claude "never gets a row". 0002 has already run on existing databases,
-- so it stays as written and this migration carries the correction.
--
-- SQLite cannot alter a CHECK constraint in place, so provider_credentials is
-- rebuilt: create it with the widened check, copy every saved key, drop the old
-- table, rename. Nothing references provider_credentials, so the rebuild is safe
-- with foreign_keys = ON.
--
-- claude_poll_state is a durable singleton holding when the Claude quota probe
-- was last claimed. The scheduled collector is a fresh
-- process on every run and manual refresh runs in the web server, so only a
-- row both can see enforces the five-minute cadence. It is claimed before the
-- request, so a refusal, a network failure or a crash still spends the
-- interval. Its timestamp is canonical UTC ISO-8601, so text comparison is
-- chronological.
-- ---------------------------------------------------------------------------

CREATE TABLE provider_credentials_rebuild (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('deepseek', 'openrouter', 'claude')),
  secret     TEXT NOT NULL CHECK (length(secret) > 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO provider_credentials_rebuild (provider, secret, updated_at)
SELECT provider, secret, updated_at
FROM provider_credentials;

DROP TABLE provider_credentials;

ALTER TABLE provider_credentials_rebuild RENAME TO provider_credentials;

CREATE TABLE claude_poll_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempted_at TEXT NOT NULL
) STRICT;
