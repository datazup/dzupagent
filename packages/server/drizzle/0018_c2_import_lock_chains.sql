-- ADR-0001 C2: durable DSL v2 import-lock revision chains.
--
-- One row per flow document, holding the serialized chain. `document` is TEXT
-- rather than JSONB on purpose: the store above this table verifies lineage
-- digests over the exact bytes it wrote, and JSONB normalizes key order and
-- whitespace on the round-trip, which would invalidate those digests. The
-- column is an opaque blob and must stay one.
--
-- Keyed by the author-supplied flow_id directly. Unlike the filesystem backend,
-- which hashes the id to keep it out of a path, a bound SQL parameter has no
-- traversal semantics, so the natural key is safe.
--
-- No tenant_id: a flow id is already globally unique within a deployment, and a
-- redundant scope column would only invite drift. Additive + idempotent.

CREATE TABLE IF NOT EXISTS "flow_import_lock_chains" (
  "flow_id"     TEXT PRIMARY KEY,
  "document"    TEXT NOT NULL,
  "created_at"  BIGINT NOT NULL,
  "updated_at"  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "flow_import_lock_chains_updated_at_idx" ON "flow_import_lock_chains" ("updated_at");
