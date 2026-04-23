-- RF-S02: Owner-scope forge_runs so list/get/cancel/pause/resume can reject
-- cross-API-key access. Nullable for backward compatibility with rows
-- created before tenant scoping was enforced.
ALTER TABLE forge_runs ADD COLUMN IF NOT EXISTS owner_id TEXT;

-- Index to keep per-owner listings and counts cheap once callers start
-- filtering by owner_id.
CREATE INDEX IF NOT EXISTS forge_runs_owner_id_idx ON forge_runs (owner_id);
