-- S4 (Stage 4-H): provider-awareness for the worker fleet.
--
-- Adds a nullable `providers` JSONB column to worker_nodes so the autoscaling
-- signal (GET /scale-target) can break capacity down by provider. A worker with
-- providers ['claude','openai'] serves both; absence (NULL) means all providers
-- (counted under the '*' wildcard in the scale-target breakdown).
--
-- Additive and idempotent (IF NOT EXISTS). No backfill needed — NULL is the
-- intended "all providers" sentinel.

ALTER TABLE "worker_nodes" ADD COLUMN IF NOT EXISTS "providers" JSONB;
