-- Migration: run_artifacts and api_keys tables
--
-- run_artifacts: Artifacts produced by a run — files, URLs, or binary blobs
-- surfaced through the `/runs/:id/artifacts` endpoint. Rows are cascade-deleted
-- when the parent run is removed.
--
-- api_keys: API keys used for authenticating clients against the server.
-- The raw key is never stored — only the SHA-256 hex digest (64 chars). The
-- raw value is returned exactly once at creation time. Keys can be scoped to
-- an owner, time-limited via `expires_at`, and revoked via `revoked_at`.
--
-- This migration is additive. It does not drop, alter, or touch any existing
-- tables (dzip_agents, forge_runs, forge_run_logs, agent_mail_dlq, etc.).

CREATE TABLE IF NOT EXISTS "run_artifacts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "run_id" uuid NOT NULL REFERENCES "forge_runs"("id") ON DELETE CASCADE,
    "name" varchar(255) NOT NULL,
    "mime_type" varchar(255),
    "size" integer,
    "url" text,
    "metadata" jsonb DEFAULT '{}'::jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "run_artifacts_run_id_idx"
    ON "run_artifacts" ("run_id");

CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "key_hash" varchar(64) NOT NULL UNIQUE,
    "owner_id" varchar(255) NOT NULL,
    "name" varchar(255),
    "rate_limit_tier" varchar(50) DEFAULT 'standard' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "expires_at" timestamp,
    "revoked_at" timestamp,
    "last_used_at" timestamp,
    "metadata" jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "api_keys_owner_id_idx"
    ON "api_keys" ("owner_id");

CREATE INDEX IF NOT EXISTS "api_keys_key_hash_idx"
    ON "api_keys" ("key_hash");
