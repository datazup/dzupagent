/**
 * Control-plane type definitions: server-hosted compatibility stores for
 * prompts, personas, presets, mailbox, clusters, marketplace, approval,
 * A2A, triggers, schedules, and mail delivery.
 *
 * These are the "frozen compatibility" route-family configs. New product
 * control-plane features should be composed by the consuming app via
 * `routePlugins` rather than added here.
 */
import type { ApprovalStateStore } from '@dzupagent/hitl-kit'
import type { PresetRegistry } from '@dzupagent/agent/presets'
import type { RunReflectionStore } from '@dzupagent/agent/reflection'
import type { MailboxStore } from '@dzupagent/agent/mailbox'

import type { MailRateLimiterConfig } from '../notifications/mail-rate-limiter.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'
import type { TriggerStore } from '../triggers/trigger-store.js'
import type { ScheduleStore } from '../schedules/schedule-store.js'
import type { ScheduleRouteConfig } from '../routes/schedules.js'
import type { PersonaStore } from '../personas/persona-store.js'
import type { PromptStore } from '../prompts/prompt-store.js'
import type { CatalogStore } from '../marketplace/catalog-store.js'
import type { ClusterStore } from '../persistence/drizzle-cluster-store.js'
import type { Notifier } from '../notifications/notifier.js'
import type { AgentCardConfig } from '../a2a/agent-card.js'
import type { A2ATaskStore } from '../a2a/task-handler.js'
import type { A2ARoutesConfig } from '../routes/a2a-types.js'
import type { PromptFeedbackLoop } from '../services/prompt-feedback-loop.js'
import type { LearningEventProcessor } from '../services/learning-event-processor.js'

/**
 * Optional mail delivery config. When provided, `createForgeApp` constructs a
 * {@link MailRateLimiter}, {@link DrizzleDlqStore}, and {@link DrizzleMailboxStore}
 * wired together, plus starts a {@link MailDlqWorker} that drains the DLQ on
 * a fixed interval. The resulting mailbox store overrides `mailboxStore` on
 * the server config.
 */
export interface MailDeliveryConfig {
  /** Drizzle DB client used by the DLQ store and mailbox store. */
  db: DrizzleStoreDatabase
  /** Token-bucket configuration. Defaults to 10 tokens / 10-per-minute refill. */
  rateLimiter?: MailRateLimiterConfig
  /** DLQ drain interval in milliseconds. Defaults to 10s. */
  dlqWorkerIntervalMs?: number
  /** DLQ batch size per drain. Defaults to 50. */
  dlqBatchSize?: number
}

/**
 * Structural type matching {@link PromptFeedbackLoop}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `PromptFeedbackLoop` directly. Not part of the package-root public
 * surface (`@dzupagent/server`).
 */
export interface PromptFeedbackLoopLike {
  start(): void
  stop(): void
}

/**
 * Structural type matching {@link LearningEventProcessor}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `LearningEventProcessor` directly. Not part of the package-root
 * public surface (`@dzupagent/server`).
 */
export interface LearningEventProcessorLike {
  start(): void
  stop(): void
}

/** A2A, trigger, and schedule route family config. */
export interface ForgeAutomationRouteFamilyConfig {
  a2a?: {
    agentCardConfig: AgentCardConfig
    taskStore?: A2ATaskStore
    onTaskSubmitted?: A2ARoutesConfig['onTaskSubmitted']
    onTaskContinued?: A2ARoutesConfig['onTaskContinued']
    pushNotificationUrlPolicy?: A2ARoutesConfig['pushNotificationUrlPolicy']
  }
  triggerStore?: TriggerStore
  scheduleStore?: ScheduleStore
  onScheduleTrigger?: ScheduleRouteConfig['onManualTrigger']
}

/**
 * Compatibility-only route-family config for legacy server-hosted control
 * planes: prompts, personas, presets, marketplace, reflections, mailbox,
 * clusters, closed-loop processors, and approval state.
 *
 * Do not add new product-control-plane fields here. New app-owned concepts
 * such as workspaces, projects, tasks/subtasks, operator dashboards, personas
 * as product UX, prompt-template product flows, marketplace UX, or memory
 * policy controls should define app-owned config and mount routes through
 * `routePlugins` or app-level Hono composition around `createForgeApp`.
 */
export interface ForgeControlPlaneRouteFamilyConfig {
  /** Compatibility-only prompt route store. New product prompt UX belongs in the consuming app. */
  promptStore?: PromptStore
  /** Compatibility-only persona route store. New product persona UX belongs in the consuming app. */
  personaStore?: PersonaStore
  /** Compatibility-only notification integration for existing server routes. */
  notifier?: Notifier
  /** Compatibility-only preset route registry. New product preset UX belongs in the consuming app. */
  presetRegistry?: PresetRegistry
  /** Compatibility-only reflection route store. */
  reflectionStore?: RunReflectionStore
  /** Compatibility-only mailbox route store. */
  mailboxStore?: MailboxStore
  /** Compatibility-only mailbox delivery wiring. */
  mailDelivery?: MailDeliveryConfig
  /** Compatibility-only cluster route store. */
  clusterStore?: ClusterStore
  /** Compatibility-only marketplace catalog route store. New product marketplace UX belongs in the consuming app. */
  catalogStore?: CatalogStore
  /** Compatibility-only closed-loop prompt processor lifecycle hook. */
  promptFeedbackLoop?: PromptFeedbackLoop | PromptFeedbackLoopLike
  /** Compatibility-only closed-loop learning processor lifecycle hook. */
  learningEventProcessor?: LearningEventProcessor | LearningEventProcessorLike
  /** Compatibility-only approval state route store. */
  approvalStore?: ApprovalStateStore
}
