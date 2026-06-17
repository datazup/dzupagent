-- P1 residual: worker_nodes — stable per-node identity, heartbeat, and a
-- queryable fleet view for capacity observability and dead-node reaping.
-- `id` is caller-supplied (stable per-process id), so a restart upserts onto
-- the same row. Timestamps are epoch milliseconds (BIGINT).
CREATE TABLE IF NOT EXISTS "worker_nodes" (
  "id"                TEXT PRIMARY KEY,
  "tenant_scope"      TEXT NOT NULL DEFAULT 'shared',
  "status"            TEXT NOT NULL DEFAULT 'starting',
  "capacity"          INTEGER NOT NULL DEFAULT 1,
  "in_flight"         INTEGER NOT NULL DEFAULT 0,
  "started_at"        BIGINT NOT NULL,
  "last_heartbeat_at" BIGINT NOT NULL,
  "meta"              JSONB
);
CREATE INDEX IF NOT EXISTS "worker_nodes_status_idx"
  ON "worker_nodes"("status");
CREATE INDEX IF NOT EXISTS "worker_nodes_tenant_scope_idx"
  ON "worker_nodes"("tenant_scope");
