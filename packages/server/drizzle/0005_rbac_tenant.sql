-- MC-S02: RBAC role + tenant isolation.
--
-- Adds:
--   * api_keys.role         — 'user' | 'admin' (drives rbacMiddleware)
--   * api_keys.tenant_id    — tenant scope carried by the authenticated key
--   * tenant_id on downstream tables (forge_runs, dzip_agents,
--     schedule_configs, trigger_configs, agent_mailbox)
--
-- All columns default to literal strings so pre-migration rows keep working
-- under the single-tenant default. Stores filter listings by tenant_id so
-- two keys with different tenants cannot observe each other's data.
--
-- This migration is additive; it does not drop, alter, or touch any other
-- existing columns.

ALTER TABLE "api_keys"
    ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'user';

ALTER TABLE "api_keys"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "api_keys_tenant_id_idx"
    ON "api_keys" ("tenant_id");

ALTER TABLE "forge_runs"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "forge_runs_tenant_id_idx"
    ON "forge_runs" ("tenant_id");

ALTER TABLE "dzip_agents"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "dzip_agents_tenant_id_idx"
    ON "dzip_agents" ("tenant_id");

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "schedule_configs_tenant_id_idx"
    ON "schedule_configs" ("tenant_id");

ALTER TABLE "trigger_configs"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "trigger_configs_tenant_id_idx"
    ON "trigger_configs" ("tenant_id");

ALTER TABLE "agent_mailbox"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "agent_mailbox_tenant_id_idx"
    ON "agent_mailbox" ("tenant_id");
