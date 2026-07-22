/**
 * Messaging-plane optional route families: A2A (agent-to-agent) and the
 * mailbox/cluster surfaces. A2A applies its own auth/RBAC gating and selects a
 * task store; the mailbox helper constructs the mail rate limiter, DLQ store,
 * and DLQ drain worker when `mailDelivery` is configured.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { OptionalRoutesContext } from "./context.js";

import type { MailboxStore } from "@dzupagent/agent/mailbox";
import { createA2ARoutes } from "../../routes/a2a.js";
import { buildAgentCard } from "../../a2a/agent-card.js";
import { InMemoryA2ATaskStore } from "../../a2a/task-handler.js";
import type { A2ATaskStore } from "../../a2a/task-handler.js";
import { createMailboxRoutes } from "../../routes/mailbox.js";
import { createClusterRoutes } from "../../routes/clusters.js";
import { authMiddleware } from "../../middleware/auth.js";
import { rbacMiddleware } from "../../middleware/rbac.js";
import { InMemoryMailboxStore } from "@dzupagent/agent/mailbox";
import {
  MailRateLimiter,
  type MailRateLimiterConfig,
} from "../../notifications/mail-rate-limiter.js";
import {
  MailDlqWorker,
  DEFAULT_DLQ_WORKER_INTERVAL_MS,
  DEFAULT_DLQ_WORKER_BATCH_SIZE,
} from "../../notifications/mail-dlq-worker.js";
import { DrizzleDlqStore } from "../../persistence/drizzle-dlq-store.js";
import { DrizzleMailboxStore } from "../../persistence/drizzle-mailbox-store.js";
import { createDefaultRbacConfig } from "../middleware.js";
import { registerShutdownDrainHook } from "../utils.js";

export function mountA2ARoutes(
  app: Hono<AppEnv>,
  ctx: OptionalRoutesContext
): void {
  const { runtimeConfig, effectiveAuth } = ctx;
  if (!runtimeConfig.a2a) {
    return;
  }
  const a2aConfig = runtimeConfig.a2a;
  const agentCard = buildAgentCard(a2aConfig.agentCardConfig);

  // Protect A2A routes (except /.well-known/agent.json which must remain
  // public per the A2A spec). The well-known path is mounted at the app
  // root below, so gating `/a2a/*` and `/a2a` leaves discovery
  // unauthenticated while requiring credentials for tasks and JSON-RPC.
  if (effectiveAuth) {
    app.use("/a2a", authMiddleware(effectiveAuth));
    app.use("/a2a/*", authMiddleware(effectiveAuth));
  }
  if (effectiveAuth && runtimeConfig.rbac !== false) {
    const rbacConfig = createDefaultRbacConfig(runtimeConfig);
    app.use("/a2a", rbacMiddleware(rbacConfig));
    app.use("/a2a/*", rbacMiddleware(rbacConfig));
  }

  // Select task store: Drizzle if env flag set, otherwise provided or in-memory
  let taskStore: A2ATaskStore;
  if (a2aConfig.taskStore) {
    taskStore = a2aConfig.taskStore;
  } else if (process.env["USE_DRIZZLE_A2A"] === "true") {
    // DrizzleA2ATaskStore requires a db instance passed via taskStore config
    // Fall back to in-memory if no store was explicitly provided
    taskStore = new InMemoryA2ATaskStore({
      pushNotificationUrlPolicy: a2aConfig.pushNotificationUrlPolicy,
    });
  } else {
    taskStore = new InMemoryA2ATaskStore({
      pushNotificationUrlPolicy: a2aConfig.pushNotificationUrlPolicy,
    });
  }

  const a2aRoutes = createA2ARoutes({
    agentCard,
    taskStore,
    onTaskSubmitted: a2aConfig.onTaskSubmitted,
    onTaskContinued: a2aConfig.onTaskContinued,
    pushNotificationUrlPolicy: a2aConfig.pushNotificationUrlPolicy,
  });
  app.route("", a2aRoutes);
}

/**
 * Mailbox routes are always mounted (default to {@link InMemoryMailboxStore}
 * when neither `mailboxStore` nor `mailDelivery` is provided), but the
 * cluster routes are only mounted when `clusterStore` is configured.
 *
 * When `mailDelivery` is supplied, this helper also constructs the mail
 * rate limiter, DLQ store, mailbox store, and starts a {@link MailDlqWorker}
 * — registering its `stop()` on the graceful-shutdown drain hook.
 */
export function mountMailboxAndClusterRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  let mailboxStore: MailboxStore;
  let dlqStore: DrizzleDlqStore | undefined;

  if (runtimeConfig.mailDelivery) {
    const mailCfg = runtimeConfig.mailDelivery;
    const rateLimiterCfg: MailRateLimiterConfig = mailCfg.rateLimiter ?? {};
    const rateLimiter = new MailRateLimiter(rateLimiterCfg);
    dlqStore = new DrizzleDlqStore(mailCfg.db);
    mailboxStore = new DrizzleMailboxStore(mailCfg.db, {
      rateLimiter,
      dlq: dlqStore,
    });

    // Start the DLQ drain worker and register shutdown cleanup.
    const worker = new MailDlqWorker({
      dlq: dlqStore,
      mailbox: mailboxStore,
      intervalMs: mailCfg.dlqWorkerIntervalMs ?? DEFAULT_DLQ_WORKER_INTERVAL_MS,
      batchSize: mailCfg.dlqBatchSize ?? DEFAULT_DLQ_WORKER_BATCH_SIZE,
    });
    worker.start();

    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, () => worker.stop());
    }
  } else {
    mailboxStore = runtimeConfig.mailboxStore ?? new InMemoryMailboxStore();
  }

  app.route("/api/mailbox", createMailboxRoutes({ mailboxStore, dlqStore }));

  if (runtimeConfig.clusterStore) {
    app.route(
      "/api/clusters",
      createClusterRoutes({
        clusterStore: runtimeConfig.clusterStore,
        mailboxStore,
      })
    );
  }
}
