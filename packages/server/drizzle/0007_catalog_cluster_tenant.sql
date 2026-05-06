-- Tenant isolation for catalog entries and clusters.
--
-- These tables were not included in 0005_rbac_tenant.sql, but their HTTP
-- routes are authenticated CRUD surfaces. Additive defaults preserve existing
-- single-tenant rows under the default scope.

ALTER TABLE "agent_catalog"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "agent_catalog_tenant_id_idx"
    ON "agent_catalog" ("tenant_id");

DROP INDEX IF EXISTS "agent_catalog_slug_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "agent_catalog_tenant_slug_idx"
    ON "agent_catalog" ("tenant_id", "slug");

ALTER TABLE "agent_clusters"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "agent_clusters_tenant_id_idx"
    ON "agent_clusters" ("tenant_id");
