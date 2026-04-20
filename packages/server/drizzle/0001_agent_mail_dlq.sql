-- Migration: agent_mail_dlq table
--
-- Dead-letter queue for undeliverable agent mail messages.
-- Rows land here when DrizzleMailboxStore.save() is blocked by the per-recipient
-- rate limiter (or any future transient failure path). A worker drains rows
-- where next_retry_at <= now() and dead_at IS NULL. After MAX_DLQ_ATTEMPTS
-- failed retries, dead_at is set and the row is skipped until manually
-- redelivered via POST /api/mailbox/dlq/:id/redeliver.
--
-- Timestamps are epoch milliseconds to match agent_mailbox.

CREATE TABLE IF NOT EXISTS "agent_mail_dlq" (
    "id" text PRIMARY KEY NOT NULL,
    "original_message_id" text NOT NULL,
    "from_agent" text NOT NULL,
    "to_agent" text NOT NULL,
    "subject" text NOT NULL,
    "body" jsonb NOT NULL,
    "fail_reason" text NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "next_retry_at" integer NOT NULL,
    "created_at" integer NOT NULL,
    "dead_at" integer
);

CREATE INDEX IF NOT EXISTS "agent_mail_dlq_next_retry_at_idx"
    ON "agent_mail_dlq" ("next_retry_at");

CREATE INDEX IF NOT EXISTS "agent_mail_dlq_to_agent_idx"
    ON "agent_mail_dlq" ("to_agent");
