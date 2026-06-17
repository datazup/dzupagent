-- P4-SCHEDULE-HA: high-availability scheduling columns on schedule_configs.
--
-- Adds the five columns that the P4 HA scheduler needs to implement
-- distributed leader election and missed-fire detection without a separate
-- coordination table:
--
--   * next_run_at       — UTC timestamp of the next scheduled fire. Computed
--                         by the scheduler from the cron expression and stored
--                         so any node can skip ahead without recalculating.
--                         Nullable; NULL means the schedule has not yet been
--                         primed or has been disabled.
--
--   * running           — Boolean latch set to TRUE when a node has claimed
--                         and is actively executing this schedule. Prevents
--                         double-fire under concurrent node wake-ups.
--                         NOT NULL DEFAULT false so pre-migration rows are
--                         treated as idle.
--
--   * claimed_by        — Identifier of the node that currently holds the
--                         execution lease. Nullable; NULL when idle.
--
--   * last_claimed_at   — Timestamp when the current (or most recent) claim
--                         was taken. Used to detect stale leases from crashed
--                         nodes. Nullable; NULL for unclaimed rows.
--
--   * last_fired_at     — Timestamp of the most recent successful fire.
--                         Used for missed-fire detection on node start-up.
--                         Nullable; NULL for schedules that have never fired.
--
-- This migration is additive; it does not drop, alter, or touch any other
-- existing columns.

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "next_run_at" timestamp;

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "running" boolean NOT NULL DEFAULT false;

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "claimed_by" text;

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "last_claimed_at" timestamp;

ALTER TABLE "schedule_configs"
    ADD COLUMN IF NOT EXISTS "last_fired_at" timestamp;
