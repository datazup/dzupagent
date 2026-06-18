-- S4 (Stage 4-A): tenant_id sweep across Drizzle tables.
--
-- Tightens tenant scoping so every meaningfully-tenant-scoped table carries a
-- NOT NULL tenant_id. Two classes of change:
--
--   1. Tables missing tenant_id entirely -> ADD COLUMN NOT NULL DEFAULT
--      'default'. The default backfills existing rows so the NOT NULL
--      constraint is satisfiable without a separate UPDATE pass:
--        forge_run_logs, run_artifacts, a2a_task_messages, cluster_roles,
--        worker_nodes, run_traces, trace_steps, dzupagent_audit_log, flow_jobs.
--
--   2. Tables with a nullable tenant_id -> SET NOT NULL + SET DEFAULT 'default':
--        deployment_history, forge_node_ledger.
--
-- Skipped: forge_vectors (shared embedding store, no meaningful tenant scope).
--
-- Additive and idempotent (IF NOT EXISTS / IF NOT NULL is implied by repeat
-- safety of SET NOT NULL once backfilled). Store-layer filtering by tenant_id
-- lands in Stage 4-B; this migration only widens the schema.

-- ---------------------------------------------------------------------------
-- 1. Add tenant_id to tables that lack it.
-- ---------------------------------------------------------------------------

ALTER TABLE "forge_run_logs"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "forge_run_logs_tenant_id_idx"
    ON "forge_run_logs" ("tenant_id");

ALTER TABLE "run_artifacts"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "run_artifacts_tenant_id_idx"
    ON "run_artifacts" ("tenant_id");

ALTER TABLE "a2a_task_messages"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "a2a_task_messages_tenant_id_idx"
    ON "a2a_task_messages" ("tenant_id");

-- cluster_roles is a small child lookup (queried via cluster_id); column only.
ALTER TABLE "cluster_roles"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

ALTER TABLE "worker_nodes"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "worker_nodes_tenant_id_idx"
    ON "worker_nodes" ("tenant_id");

ALTER TABLE "run_traces"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "run_traces_tenant_id_idx"
    ON "run_traces" ("tenant_id");

-- trace_steps is a child of run_traces (queried via run_id); column only.
ALTER TABLE "trace_steps"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

ALTER TABLE "dzupagent_audit_log"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "dzupagent_audit_log_tenant_id_idx"
    ON "dzupagent_audit_log" ("tenant_id");

ALTER TABLE "flow_jobs"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "flow_jobs_tenant_id_idx"
    ON "flow_jobs" ("tenant_id");

-- ---------------------------------------------------------------------------
-- 2. Tighten nullable tenant_id -> NOT NULL DEFAULT 'default'.
-- ---------------------------------------------------------------------------

-- Backfill any NULLs first so SET NOT NULL succeeds.
UPDATE "deployment_history" SET "tenant_id" = 'default' WHERE "tenant_id" IS NULL;
ALTER TABLE "deployment_history" ALTER COLUMN "tenant_id" SET DEFAULT 'default';
ALTER TABLE "deployment_history" ALTER COLUMN "tenant_id" SET NOT NULL;

UPDATE "forge_node_ledger" SET "tenant_id" = 'default' WHERE "tenant_id" IS NULL;
ALTER TABLE "forge_node_ledger" ALTER COLUMN "tenant_id" SET DEFAULT 'default';
ALTER TABLE "forge_node_ledger" ALTER COLUMN "tenant_id" SET NOT NULL;
