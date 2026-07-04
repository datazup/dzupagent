CREATE TABLE IF NOT EXISTS subagent_tasks (
  id text PRIMARY KEY,
  task_json jsonb NOT NULL,
  status text NOT NULL,
  parent_run_id text NOT NULL,
  ended_at bigint,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subagent_tasks_parent_status_idx
  ON subagent_tasks (parent_run_id, status);

CREATE INDEX IF NOT EXISTS subagent_tasks_ended_at_idx
  ON subagent_tasks (ended_at)
  WHERE ended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS subagent_task_queue (
  task_id text PRIMARY KEY,
  enqueued_at bigint NOT NULL,
  available_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  lease_until bigint,
  last_claimed_at bigint
);

CREATE INDEX IF NOT EXISTS subagent_task_queue_claim_idx
  ON subagent_task_queue (available_at, lease_until, enqueued_at);
