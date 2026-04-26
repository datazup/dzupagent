-- RF-SEC-05: A2A owner + tenant scope.
--
-- A2A task creation, listing, retrieval, and cancellation must be scoped by
-- the authenticated caller. We add:
--   * a2a_tasks.owner_id   — API key id that submitted the task (nullable
--                             so unauthenticated single-tenant deployments
--                             keep working).
--   * a2a_tasks.tenant_id  — Tenant scope carried by the authenticated key
--                             at submission time. Defaults to 'default' to
--                             match the rest of the multi-tenant rollout
--                             (see 0005_rbac_tenant.sql).
--
-- Cross-owner reads return 404 (not 403) at the route layer to prevent
-- existence enumeration. The columns are additive — pre-migration tasks
-- keep their NULL ownerId and stay visible to legacy callers.

ALTER TABLE "a2a_tasks"
    ADD COLUMN IF NOT EXISTS "owner_id" text;

CREATE INDEX IF NOT EXISTS "a2a_tasks_owner_id_idx"
    ON "a2a_tasks" ("owner_id");

ALTER TABLE "a2a_tasks"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "a2a_tasks_tenant_id_idx"
    ON "a2a_tasks" ("tenant_id");
