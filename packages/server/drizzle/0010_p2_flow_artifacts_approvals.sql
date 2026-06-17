-- P2 residuals: flow_artifacts (content-addressed outputs) and
-- flow_approvals (durable approval/clarification records).
CREATE TABLE IF NOT EXISTS "flow_artifacts" (
  "artifact_ref"    TEXT PRIMARY KEY,
  "tenant_id"       TEXT NOT NULL DEFAULT 'default',
  "content_digest"  TEXT NOT NULL,
  "content_type"    TEXT NOT NULL,
  "content"         JSONB,
  "storage_uri"     TEXT,
  "schema_ref"      TEXT,
  "created_at"      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "flow_artifacts_tenant_id_idx"
  ON "flow_artifacts"("tenant_id");
CREATE INDEX IF NOT EXISTS "flow_artifacts_content_digest_idx"
  ON "flow_artifacts"("content_digest");

CREATE TABLE IF NOT EXISTS "flow_approvals" (
  "tenant_id"        TEXT NOT NULL DEFAULT 'default',
  "run_id"           TEXT NOT NULL,
  "approval_id"      TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "request_payload"  JSONB NOT NULL DEFAULT '{}',
  "response_payload" JSONB,
  "resolved_at"      TIMESTAMP,
  PRIMARY KEY ("run_id", "approval_id")
);
CREATE INDEX IF NOT EXISTS "flow_approvals_tenant_id_idx"
  ON "flow_approvals"("tenant_id");
CREATE INDEX IF NOT EXISTS "flow_approvals_run_id_idx"
  ON "flow_approvals"("run_id");
