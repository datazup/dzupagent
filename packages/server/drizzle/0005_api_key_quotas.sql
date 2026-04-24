-- MC-S01: Per-key token budget enforcement.
--
-- Adds two nullable quota columns to api_keys so operators can cap per-run
-- token usage and per-hour run count on a per-key basis. Both columns are
-- nullable and default to NULL — existing rows stay unrestricted, preserving
-- backward compatibility with deployments that have not yet rolled out
-- quota enforcement.
--
-- max_tokens_per_run:  hard cap on total LLM input+output tokens for a
--                      single run. Injected into `guardrails.maxTokens` on
--                      run creation so the agent halts before the cap.
-- max_runs_per_hour:   soft cap tracked by the in-memory sliding-window
--                      ResourceQuotaManager. Run creation returns 429 when
--                      the window budget is exhausted.
--
-- Both caps are optional — leaving either NULL disables the check for that
-- dimension on the key.

ALTER TABLE "api_keys"
    ADD COLUMN IF NOT EXISTS "max_tokens_per_run" integer;

ALTER TABLE "api_keys"
    ADD COLUMN IF NOT EXISTS "max_runs_per_hour" integer;
