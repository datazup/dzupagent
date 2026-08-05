-- SEC-H-06: give agent_mail_dlq the tenant_id column the S4 sweep missed.
--
-- `agent_mailbox` carries tenant_id (MC-S02) and every mailbox route scopes on
-- the caller's server-derived tenant. The dead-letter queue was omitted from
-- the 0014 tenant_id sweep, so tenancy was destroyed at the DLQ boundary:
--
--   1. DrizzleMailboxStore.save() hands a tenant-stamped MailMessage to
--      dlq.enqueue(), which had no column to store it in -> tenant dropped.
--   2. DrizzleDlqStore.redeliver(id) selected by primary key alone, so any
--      caller holding a DLQ id could redeliver another tenant's message
--      (cross-tenant IDOR via POST /api/mailbox/dlq/:id/redeliver).
--   3. redeliver() re-inserted into agent_mailbox without tenant_id, so the
--      restored row silently fell back to the 'default' tenant.
--
-- Follows the 0014 pattern: ADD COLUMN NOT NULL DEFAULT 'default' backfills
-- existing rows so NOT NULL is satisfiable without a separate UPDATE pass.
-- Pre-existing rows adopt 'default', matching agent_mailbox's own default.
--
-- Additive and idempotent (IF NOT EXISTS).
ALTER TABLE "agent_mail_dlq"
    ADD COLUMN IF NOT EXISTS "tenant_id" text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS "agent_mail_dlq_tenant_id_idx"
    ON "agent_mail_dlq" ("tenant_id");
