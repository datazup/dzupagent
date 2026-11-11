-- A2A v1 operation ledger (M3a recovery). Additive and idempotent; never alters a2a_v1_tasks columns.
CREATE TABLE IF NOT EXISTS "a2a_v1_operations" (
    "tenant_id" text NOT NULL,
    "owner_key" text NOT NULL,
    "task_id" text NOT NULL,
    "generation" integer NOT NULL,
    "operation_key" text NOT NULL,
    "message_id" text NOT NULL,
    "boot_id" text NOT NULL,
    "state" varchar(16) NOT NULL DEFAULT 'started',
    "recovery_state" varchar(24),
    "claim_kind" varchar(8),
    "claim_token" text,
    "recovery_receipt" text,
    "recovery_updated_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenant_id", "owner_key", "task_id", "generation"),
    CONSTRAINT "a2a_v1_operations_receipt_cap" CHECK ("recovery_receipt" IS NULL OR length("recovery_receipt") <= 4096)
);
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_v1_operations_key_uidx"
    ON "a2a_v1_operations" ("operation_key");
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_v1_operations_message_uidx"
    ON "a2a_v1_operations" ("tenant_id", "owner_key", "task_id", "message_id");
CREATE INDEX IF NOT EXISTS "a2a_v1_operations_scan_idx"
    ON "a2a_v1_operations" ("boot_id", "state", "recovery_state");
-- Closes the minors deferral: status ordering with NULLS LAST (the existing index is kept).
CREATE INDEX IF NOT EXISTS "a2a_v1_tasks_scope_status_nl_idx"
    ON "a2a_v1_tasks" ("tenant_id", "owner_key", "status_timestamp" DESC NULLS LAST, "id" DESC);
