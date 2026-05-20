-- RUN-REFLECTION-STORE-WIDEN: tenant + owner scope on run_reflections.
--
-- Closes the defense-in-depth TODO from the SEC-M-03 batch-4 reflection-route
-- sweep. Before this migration, the reflections HTTP routes did a per-candidate
-- `runStore.get()` lookup to enforce tenant/owner scoping because
-- `RunReflectionStore` had no native filter. Pushing the filter into the store
-- requires the rows to carry the scope.
--
-- Additive only:
--   * run_reflections.owner_id   — API key id that owns the originating run.
--                                  Nullable; pre-migration rows stay visible
--                                  under `includeLegacyOwnerless` semantics
--                                  matching routing-stats and a2a_tasks.
--   * run_reflections.tenant_id  — Tenant scope stamped at save time. NOT
--                                  NULL DEFAULT 'default' so pre-migration
--                                  rows remain filterable by single-tenant
--                                  deployments (matches 0005_rbac_tenant.sql
--                                  and 0006_a2a_owner_tenant.sql).
--
-- The primary key (`run_id`) is unchanged. Cross-owner / cross-tenant reads
-- continue to surface as 404 at the route layer to prevent enumeration.

ALTER TABLE "run_reflections"
    ADD COLUMN IF NOT EXISTS "owner_id" text;

CREATE INDEX IF NOT EXISTS "run_reflections_owner_id_idx"
    ON "run_reflections" ("owner_id");

ALTER TABLE "run_reflections"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "run_reflections_tenant_id_idx"
    ON "run_reflections" ("tenant_id");
