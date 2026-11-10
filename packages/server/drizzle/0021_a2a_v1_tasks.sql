-- SDK v1 payloads must not share the legacy A2A task tables.
CREATE TABLE IF NOT EXISTS "a2a_v1_tasks" (
    "tenant_id" text NOT NULL,
    "owner_key" text NOT NULL,
    "id" text NOT NULL,
    "context_id" text NOT NULL,
    "state" varchar(40) NOT NULL,
    "status_timestamp" timestamptz,
    "task" jsonb NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("tenant_id", "owner_key", "id")
);
CREATE INDEX IF NOT EXISTS "a2a_v1_tasks_scope_context_idx"
    ON "a2a_v1_tasks" ("tenant_id", "owner_key", "context_id");
CREATE INDEX IF NOT EXISTS "a2a_v1_tasks_scope_status_idx"
    ON "a2a_v1_tasks" ("tenant_id", "owner_key", "status_timestamp" DESC, "id" DESC);
