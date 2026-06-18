-- OQ-3: provider-specific resume tokens for durable node execution.
--
-- The generic `forge_node_ledger` stays framework-clean and provider-agnostic.
-- Adapters that support resume (e.g. Claude session ids, Codex thread refs)
-- store their owned fields here, keyed by (run_id, node_id, adapter_id).
--
-- Framework-internal side table shared between adapter and ledger. Deliberately
-- NO tenant_id: run_id already scopes to a tenant via forge_runs.tenant_id, so
-- a redundant column would only invite drift. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "flow_node_adapter_meta" (
  "run_id"        TEXT NOT NULL,
  "node_id"       TEXT NOT NULL,
  "adapter_id"    TEXT NOT NULL,
  "session_ref"   TEXT,
  "resume_token"  TEXT,
  "meta"          JSONB,
  "created_at"    BIGINT NOT NULL,
  "updated_at"    BIGINT NOT NULL,
  PRIMARY KEY ("run_id", "node_id", "adapter_id")
);

CREATE INDEX IF NOT EXISTS "idx_node_adapter_meta_run" ON "flow_node_adapter_meta" ("run_id");
