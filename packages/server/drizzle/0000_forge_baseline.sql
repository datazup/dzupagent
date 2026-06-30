-- Forge baseline tables.
--
-- Earlier generated migrations in this directory were additive patches against
-- an already-existing Forge schema. Fresh dev databases need the baseline
-- tables first so those later ALTER/UPDATE migrations have something to target.
--
-- Datazup local/dev stacks use plain PostgreSQL for relational data and Qdrant
-- for embeddings and semantic search. Do not require a vector extension in
-- this baseline.

CREATE TABLE IF NOT EXISTS "dzip_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "instructions" text NOT NULL,
  "model_tier" varchar(50) NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb,
  "guardrails" jsonb,
  "approval" varchar(20) NOT NULL DEFAULT 'auto',
  "version" integer NOT NULL DEFAULT 1,
  "active" boolean NOT NULL DEFAULT true,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dzip_agents_tenant_id_idx" ON "dzip_agents" ("tenant_id");

CREATE TABLE IF NOT EXISTS "forge_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "dzip_agents"("id"),
  "status" varchar(30) NOT NULL DEFAULT 'queued',
  "input" jsonb,
  "output" jsonb,
  "plan" jsonb,
  "token_usage_input" integer DEFAULT 0,
  "token_usage_output" integer DEFAULT 0,
  "cost_cents" real DEFAULT 0,
  "error" text,
  "owner_id" text,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp
);
CREATE INDEX IF NOT EXISTS "forge_runs_status_idx" ON "forge_runs" ("status");
CREATE INDEX IF NOT EXISTS "forge_runs_owner_id_idx" ON "forge_runs" ("owner_id");
CREATE INDEX IF NOT EXISTS "forge_runs_tenant_id_idx" ON "forge_runs" ("tenant_id");

CREATE TABLE IF NOT EXISTS "forge_run_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "forge_runs"("id") ON DELETE CASCADE,
  "level" varchar(10) NOT NULL,
  "phase" varchar(50),
  "message" text NOT NULL,
  "data" jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "timestamp" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "forge_run_logs_tenant_id_idx" ON "forge_run_logs" ("tenant_id");

CREATE TABLE IF NOT EXISTS "deployment_history" (
  "id" text PRIMARY KEY NOT NULL,
  "confidence_score" real NOT NULL,
  "gate_decision" text NOT NULL,
  "signals_snapshot" jsonb,
  "deployed_at" timestamp NOT NULL DEFAULT now(),
  "deployed_by" text,
  "environment" text NOT NULL,
  "rollback_available" boolean NOT NULL DEFAULT false,
  "outcome" text,
  "completed_at" timestamp,
  "notes" text,
  "tenant_id" text NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS "deployment_history_environment_idx" ON "deployment_history" ("environment");
CREATE INDEX IF NOT EXISTS "deployment_history_deployed_at_idx" ON "deployment_history" ("deployed_at");
CREATE INDEX IF NOT EXISTS "deployment_history_tenant_id_idx" ON "deployment_history" ("tenant_id");

CREATE TABLE IF NOT EXISTS "a2a_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_name" varchar(255) NOT NULL,
  "state" varchar(30) NOT NULL DEFAULT 'submitted',
  "input" jsonb,
  "output" jsonb,
  "error" text,
  "metadata" jsonb,
  "push_notification_config" jsonb,
  "artifacts" jsonb DEFAULT '[]'::jsonb,
  "owner_id" text,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "a2a_tasks_owner_id_idx" ON "a2a_tasks" ("owner_id");
CREATE INDEX IF NOT EXISTS "a2a_tasks_tenant_id_idx" ON "a2a_tasks" ("tenant_id");

CREATE TABLE IF NOT EXISTS "a2a_task_messages" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "a2a_tasks"("id") ON DELETE CASCADE,
  "role" varchar(20) NOT NULL,
  "parts" jsonb NOT NULL,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "a2a_task_messages_task_id_idx" ON "a2a_task_messages" ("task_id");
CREATE INDEX IF NOT EXISTS "a2a_task_messages_tenant_id_idx" ON "a2a_task_messages" ("tenant_id");

CREATE TABLE IF NOT EXISTS "trigger_configs" (
  "id" text PRIMARY KEY NOT NULL,
  "type" varchar(20) NOT NULL,
  "agent_id" text NOT NULL,
  "schedule" text,
  "webhook_secret" text,
  "after_agent_id" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "metadata" jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "trigger_configs_tenant_id_idx" ON "trigger_configs" ("tenant_id");

CREATE TABLE IF NOT EXISTS "schedule_configs" (
  "id" text PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "cron_expression" text NOT NULL,
  "workflow_text" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "metadata" jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "next_run_at" timestamp,
  "running" boolean NOT NULL DEFAULT false,
  "claimed_by" text,
  "last_claimed_at" timestamp,
  "last_fired_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "schedule_configs_tenant_id_idx" ON "schedule_configs" ("tenant_id");

CREATE TABLE IF NOT EXISTS "run_reflections" (
  "run_id" varchar(255) PRIMARY KEY NOT NULL,
  "completed_at" timestamp NOT NULL,
  "duration_ms" integer NOT NULL,
  "total_steps" integer NOT NULL,
  "tool_call_count" integer NOT NULL,
  "error_count" integer NOT NULL,
  "patterns" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "quality_score" real NOT NULL,
  "owner_id" text,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "run_reflections_owner_id_idx" ON "run_reflections" ("owner_id");
CREATE INDEX IF NOT EXISTS "run_reflections_tenant_id_idx" ON "run_reflections" ("tenant_id");

CREATE TABLE IF NOT EXISTS "agent_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "version" text NOT NULL,
  "tags" text[] NOT NULL DEFAULT '{}',
  "author" text,
  "readme" text,
  "published_at" timestamp,
  "is_public" boolean NOT NULL DEFAULT true,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agent_catalog_author_idx" ON "agent_catalog" ("author");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_catalog_tenant_slug_idx" ON "agent_catalog" ("tenant_id", "slug");
CREATE INDEX IF NOT EXISTS "agent_catalog_tenant_id_idx" ON "agent_catalog" ("tenant_id");

CREATE TABLE IF NOT EXISTS "agent_clusters" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_type" varchar(50) NOT NULL DEFAULT 'local',
  "workspace_options" jsonb DEFAULT '{}'::jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agent_clusters_tenant_id_idx" ON "agent_clusters" ("tenant_id");

CREATE TABLE IF NOT EXISTS "cluster_roles" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "cluster_id" text NOT NULL REFERENCES "agent_clusters"("id") ON DELETE CASCADE,
  "role_id" varchar(255) NOT NULL,
  "agent_id" text NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_roles_cluster_role_idx" ON "cluster_roles" ("cluster_id", "role_id");
CREATE INDEX IF NOT EXISTS "cluster_roles_cluster_id_idx" ON "cluster_roles" ("cluster_id");

CREATE TABLE IF NOT EXISTS "agent_mailbox" (
  "id" text PRIMARY KEY NOT NULL,
  "from_agent" text NOT NULL,
  "to_agent" text NOT NULL,
  "subject" text NOT NULL,
  "body" jsonb NOT NULL,
  "created_at" integer NOT NULL,
  "read_at" integer,
  "ttl_seconds" integer,
  "tenant_id" text NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS "agent_mailbox_to_agent_created_at_idx" ON "agent_mailbox" ("to_agent", "created_at");
CREATE INDEX IF NOT EXISTS "agent_mailbox_tenant_id_idx" ON "agent_mailbox" ("tenant_id");

CREATE TABLE IF NOT EXISTS "forge_node_ledger" (
  "idempotency_key" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "node_id" text NOT NULL,
  "tenant_id" text NOT NULL DEFAULT 'default',
  "attempt" integer NOT NULL DEFAULT 1,
  "fence_token" integer NOT NULL DEFAULT 1,
  "owner" text NOT NULL,
  "status" text NOT NULL,
  "lease_expires_at" bigint NOT NULL,
  "started_at" bigint NOT NULL,
  "completed_at" bigint,
  "output_ref" text,
  "output" jsonb,
  "duration_ms" integer,
  "error" text
);
CREATE INDEX IF NOT EXISTS "forge_node_ledger_run_id_idx" ON "forge_node_ledger" ("run_id");
CREATE INDEX IF NOT EXISTS "forge_node_ledger_status_lease_idx" ON "forge_node_ledger" ("status", "lease_expires_at");

CREATE TABLE IF NOT EXISTS "run_traces" (
  "run_id" varchar(255) PRIMARY KEY NOT NULL,
  "agent_id" varchar(255) NOT NULL,
  "started_at" integer NOT NULL,
  "completed_at" integer,
  "total_steps" integer NOT NULL DEFAULT 0,
  "tenant_id" text NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS "run_traces_tenant_id_idx" ON "run_traces" ("tenant_id");

CREATE TABLE IF NOT EXISTS "trace_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" varchar(255) NOT NULL REFERENCES "run_traces"("run_id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "timestamp" integer NOT NULL,
  "type" varchar(30) NOT NULL,
  "content" jsonb NOT NULL,
  "metadata" jsonb,
  "duration_ms" integer,
  "tenant_id" text NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS "trace_steps_run_id_idx" ON "trace_steps" ("run_id");
CREATE INDEX IF NOT EXISTS "trace_steps_run_step_idx" ON "trace_steps" ("run_id", "step_index");

CREATE TABLE IF NOT EXISTS "dzupagent_audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "seq" bigint NOT NULL,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_name" text,
  "action" text NOT NULL,
  "resource" text,
  "result" text NOT NULL,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "previous_hash" text NOT NULL DEFAULT '',
  "hash" text NOT NULL DEFAULT '',
  "trace_id" text,
  "span_id" text,
  "tenant_id" text NOT NULL DEFAULT 'default'
);
CREATE UNIQUE INDEX IF NOT EXISTS "dzupagent_audit_log_seq_unique" ON "dzupagent_audit_log" ("seq");
CREATE INDEX IF NOT EXISTS "dzupagent_audit_log_action_idx" ON "dzupagent_audit_log" ("action");
CREATE INDEX IF NOT EXISTS "dzupagent_audit_log_actor_id_idx" ON "dzupagent_audit_log" ("actor_id");
CREATE INDEX IF NOT EXISTS "dzupagent_audit_log_ts_idx" ON "dzupagent_audit_log" ("ts");
CREATE INDEX IF NOT EXISTS "dzupagent_audit_log_tenant_id_idx" ON "dzupagent_audit_log" ("tenant_id");
