-- Migration: formalize the 'halted' RunStatus variant
--
-- Session Q: prior to this migration, runs that ended via a clean halt (e.g.
-- token exhaustion surfaced by the DzupAgent stream's
-- `run:halted:token-exhausted` event) were recorded as status='completed' with
-- a `halted:true` flag in `metadata`. The application layer now emits a proper
-- 'halted' terminal status, which is also reflected in the `RunStatus` union
-- type in `@dzupagent/core`.
--
-- The `forge_runs.status` column is a free-form `varchar(30)` with no CHECK
-- constraint today. 'halted' fits comfortably (6 chars) so no schema change to
-- the column is required. This migration:
--
--   1. Backfills any runs whose metadata was flagged `halted:true` but whose
--      status is still 'completed' — these rows were written by the pre-Session-Q
--      run-worker. After backfill the canonical representation is status='halted'
--      AND metadata.halted=true (both are kept for backward compatibility).
--
--   2. Adds an index on `status` (idempotent) so dashboards/analytics that
--      filter by terminal status (e.g. "show all halted runs") remain fast once
--      the new variant becomes common.
--
-- Forward-compatible: older readers ignoring unknown statuses will simply skip
-- halted rows; they will NOT mis-categorize them as 'completed'.

-- 1. Backfill legacy halted runs
UPDATE "forge_runs"
SET "status" = 'halted'
WHERE "status" = 'completed'
  AND "metadata" IS NOT NULL
  AND ("metadata" ->> 'halted') = 'true';

-- 2. Index for filtering by status
CREATE INDEX IF NOT EXISTS "forge_runs_status_idx"
    ON "forge_runs" ("status");
