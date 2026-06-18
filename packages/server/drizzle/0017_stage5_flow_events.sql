-- Stage 5: append-only event log for the event-history replay runtime.
--
-- Every orchestrator decision is appended as a discrete, typed, sequenced
-- event before it takes effect. On process restart the orchestrator re-runs
-- from the top in replay mode: completed nodes short-circuit by returning their
-- recorded `node_completed` output without re-executing the activity.
--
-- `sequence` is monotonic per run (1-based); UNIQUE (run_id, sequence) gives
-- idempotent appends and a stable replay order. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "flow_events" (
  "event_id"   TEXT NOT NULL,
  "run_id"     TEXT NOT NULL,
  "sequence"   BIGINT NOT NULL,
  "event_type" TEXT NOT NULL,
  "node_id"    TEXT,
  "payload"    JSONB,
  "tenant_id"  TEXT NOT NULL DEFAULT 'default',
  "created_at" BIGINT NOT NULL,
  PRIMARY KEY ("event_id"),
  UNIQUE ("run_id", "sequence")
);

CREATE INDEX IF NOT EXISTS "idx_flow_events_run_seq" ON "flow_events" ("run_id", "sequence");
CREATE INDEX IF NOT EXISTS "idx_flow_events_tenant_id" ON "flow_events" ("tenant_id");
