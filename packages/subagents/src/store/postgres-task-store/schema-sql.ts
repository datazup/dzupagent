import { sanitizeIdentifier } from "./sql-helpers.js";

export interface PostgresSubagentSchemaSqlOptions {
  taskTableName?: string;
  queueTableName?: string;
}

export function createPostgresSubagentSchemaSql(
  options: PostgresSubagentSchemaSqlOptions = {}
): string[] {
  const taskTable = sanitizeIdentifier(
    options.taskTableName ?? "subagent_tasks"
  );
  const queueTable = sanitizeIdentifier(
    options.queueTableName ?? "subagent_task_queue"
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${taskTable} (
  id text PRIMARY KEY,
  task_json jsonb NOT NULL,
  status text NOT NULL,
  parent_run_id text NOT NULL,
  ended_at bigint,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE INDEX IF NOT EXISTS ${taskTable}_parent_status_idx
  ON ${taskTable} (parent_run_id, status)`,
    `CREATE INDEX IF NOT EXISTS ${taskTable}_ended_at_idx
  ON ${taskTable} (ended_at)
  WHERE ended_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${queueTable} (
  task_id text PRIMARY KEY,
  enqueued_at bigint NOT NULL,
  available_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  lease_until bigint,
  last_claimed_at bigint
)`,
    `CREATE INDEX IF NOT EXISTS ${queueTable}_claim_idx
  ON ${queueTable} (available_at, lease_until, enqueued_at)`,
  ];
}
