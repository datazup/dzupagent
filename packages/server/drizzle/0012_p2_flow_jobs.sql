-- P2 Queue: flow_jobs — Postgres-native run queue (Option C).
-- Decouples run creation from execution without requiring Redis. Workers poll
-- pending rows ordered by (priority ASC, created_at ASC) and claim them
-- atomically via `FOR UPDATE SKIP LOCKED`, so multiple workers never grab the
-- same job. `id` is caller-supplied (uuid). Lower `priority` = higher priority.
CREATE TABLE IF NOT EXISTS "flow_jobs" (
  "id"         TEXT PRIMARY KEY,
  "run_id"     TEXT NOT NULL,
  "agent_id"   TEXT NOT NULL,
  "input"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metadata"   JSONB,
  "priority"   INTEGER NOT NULL DEFAULT 0,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "claimed_at" TIMESTAMP,
  "claimed_by" TEXT,
  "error"      TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);

-- Claim ordering: scan pending rows by priority then FIFO.
CREATE INDEX IF NOT EXISTS "flow_jobs_status_priority_created_at_idx"
  ON "flow_jobs"("status", "priority", "created_at");

-- Cancel-by-run lookup.
CREATE INDEX IF NOT EXISTS "flow_jobs_run_id_idx"
  ON "flow_jobs"("run_id");
