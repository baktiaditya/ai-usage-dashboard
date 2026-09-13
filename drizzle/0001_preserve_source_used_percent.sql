-- ---------------------------------------------------------------------------
-- 0001_preserve_source_used_percent — store usedPercent as the source reported it
--
-- 0000 constrained used_percent to 0..100, which forced the repository to clamp
-- before insert. The plan requires the opposite: the source value is kept for
-- fidelity and diagnostics, and only the derived remaining percentage is
-- clamped, at presentation time. A provider drifting to 120 must be visible as
-- 120, not silently recorded as 100.
--
-- SQLite cannot drop a CHECK constraint, so the table is rebuilt. Nothing
-- references quota_windows, so the rebuild is safe with foreign_keys = ON.
-- Existing rows keep their ids; AUTOINCREMENT continues from the highest one.
-- ---------------------------------------------------------------------------

CREATE TABLE quota_windows_rebuild (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id             INTEGER NOT NULL REFERENCES provider_snapshots (id) ON DELETE CASCADE,
  bucket_id               TEXT NOT NULL,
  window_kind             TEXT NOT NULL,
  used_percent            REAL NOT NULL,
  window_duration_minutes INTEGER,
  reset_at                TEXT,
  UNIQUE (snapshot_id, bucket_id, window_kind)
) STRICT;

INSERT INTO quota_windows_rebuild
  (id, snapshot_id, bucket_id, window_kind, used_percent, window_duration_minutes, reset_at)
SELECT id, snapshot_id, bucket_id, window_kind, used_percent, window_duration_minutes, reset_at
FROM quota_windows;

DROP TABLE quota_windows;

ALTER TABLE quota_windows_rebuild RENAME TO quota_windows;

CREATE INDEX idx_quota_windows_snapshot ON quota_windows (snapshot_id);
