/**
 * Type definitions for the Hono app factory. Split out of `app.ts` so the
 * composition root can stay focused on orchestration. The aggregate
 * {@link ForgeServerConfig} interface is re-exported (along with its
 * dependent option types) from `app.ts` to preserve the public surface.
 *
 * Internally, the configuration is decomposed into focused groups
 * (transport, persistence, runtime, integrations, security, etc.) so that
 * helper modules under `composition/` can ask for narrow slices when the
 * full config is unnecessary.
 */
import type {
  RunStore,
  AgentExecutionSpecStore,
  ModelRegistry,
  AgentRegistry,
  DzupEventBus,
  MetricsCollector,
  CostAwareRouter,
  McpManager,
  RunJournal,
  SkillRegistry,
  WorkflowRegistry,
} from '@dzupagent/core'
import type { SkillStepResolver } from '@dzupagent/agent'
import type { AdapterSkillRegistry } from '@dzupagent/agent-adapters'
import type { ApprovalStateStore } from '@dzupagent/hitl-kit'
import type { EvalOrchestratorLike, BenchmarkOrchestratorLike } from '@dzupagent/eval-contracts'
import type { PresetRegistry, RunReflectionStore, MailboxStore } from '@dzupagent/agent'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import type { ResourceQuotaManager } from '../security/resource-quota.js'
import type { InputGuardConfig } from '../security/input-guard.js'
import type { AuthConfig } from '../middleware/auth.js'
import type { RBACConfig } from '../middleware/rbac.js'
import type { RateLimiterConfig } from '../middleware/rate-limiter.js'
import type { RunQueue } from '../queue/run-queue.js'
import type { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import type { EventGateway } from '../events/event-gateway.js'
import type { RunExecutor, RunReflectorLike } from '../runtime/run-worker.js'
import type { RetrievalFeedbackHookConfig } from '../runtime/retrieval-feedback-hook.js'
import type { ConsolidationSchedulerConfig } from '../runtime/consolidation-scheduler.js'
import type { SleepConsolidatorLike } from '../runtime/sleep-consolidation-task.js'
import type { MemoryHealthRouteConfig } from '../routes/memory-health.js'
import type { TokenLifecycleRegistry } from '../routes/run-context.js'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import type { DeployRouteConfig } from '../routes/deploy.js'
import type { LearningRouteConfig } from '../routes/learning.js'
import type { PromptFeedbackLoop } from '../services/prompt-feedback-loop.js'
import type { LearningEventProcessor } from '../services/learning-event-processor.js'
import type { ExecutableAgentResolver } from '../services/executable-agent-resolver.js'
import type { BenchmarkRouteConfig } from '../routes/benchmarks.js'
import type { EvalRouteConfig } from '../routes/evals.js'
import type { ServerRoutePlugin } from '../route-plugin.js'
import type { CompileRouteConfig } from '../routes/compile.js'
import type { A2ARoutesConfig } from '../routes/a2a.js'
import type { AgentCardConfig } from '../a2a/agent-card.js'
import type { A2ATaskStore } from '../a2a/task-handler.js'
import type { TriggerStore } from '../triggers/trigger-store.js'
import type { ScheduleStore } from '../schedules/schedule-store.js'
import type { ScheduleRouteConfig } from '../routes/schedules.js'
import type { PersonaStore } from '../personas/persona-store.js'
import type { PromptStore } from '../prompts/prompt-store.js'
import type { CatalogStore } from '../marketplace/catalog-store.js'
import type { ClusterStore } from '../persistence/drizzle-cluster-store.js'
import type { OpenAIAuthConfig } from '../routes/openai-compat/auth-middleware.js'
import type { Notifier } from '../notifications/notifier.js'
import type { MailRateLimiterConfig } from '../notifications/mail-rate-limiter.js'
import type { PostgresApiKeyStore } from '../persistence/api-key-store.js'
import type { PlaygroundRouteConfig } from '../routes/playground.js'

// Drizzle DB clients are opaque at this layer — we intentionally avoid a
// hard dependency on `drizzle-orm/postgres-js` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrizzle = any

/**
 * Optional mail delivery config. When provided, `createForgeApp` constructs a
 * {@link MailRateLimiter}, {@link DrizzleDlqStore}, and {@link DrizzleMailboxStore}
 * wired together, plus starts a {@link MailDlqWorker} that drains the DLQ on
 * a fixed interval. The resulting mailbox store overrides `mailboxStore` on
 * the server config.
 */
export interface MailDeliveryConfig {
  /** Drizzle DB client used by the DLQ store and mailbox store. */
  db: AnyDrizzle
  /** Token-bucket configuration. Defaults to 10 tokens / 10-per-minute refill. */
  rateLimiter?: MailRateLimiterConfig
  /** DLQ drain interval in milliseconds. Defaults to 10s. */
  dlqWorkerIntervalMs?: number
  /** DLQ batch size per drain. Defaults to 50. */
  dlqBatchSize?: number
}

/**
 * Shared scheduling options for consolidation (everything except the task itself
 * and eventBus, which is injected by createForgeApp).
 */
type ConsolidationSchedulingOpts = Omit<ConsolidationSchedulerConfig, 'eventBus' | 'task'>

/**
 * Consolidation config — supports two modes:
 * 1. Provide an explicit `task` (ConsolidationTask).
 * 2. Provide `consolidator` + `store` + `namespaces` to auto-create the task.
 */
export type ConsolidationConfig =
  | (ConsolidationSchedulingOpts & { task: ConsolidationSchedulerConfig['task'] })
  | (ConsolidationSchedulingOpts & {
      /** A SleepConsolidator instance (from @dzupagent/memory) */
      consolidator: SleepConsolidatorLike
      /** A BaseStore instance passed to the consolidator */
      store: unknown
      /** Namespaces to consolidate */
      namespaces: string[][]
    })

/**
 * Structural type matching {@link PromptFeedbackLoop}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 */
export interface PromptFeedbackLoopLike {
  start(): void
  stop(): void
}

/**
 * Structural type matching {@link LearningEventProcessor}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 */
export interface LearningEventProcessorLike {
  start(): void
  stop(): void
}

/**
 * Required core wiring: stores, registry, and the shared event bus.
 */
export interface ForgeCoreConfig {
  runStore: RunStore
  agentStore: AgentExecutionSpecStore
  /** Optional registry control plane for registry-backed management and execution projection. */
  registry?: AgentRegistry
  /** Optional boundary that resolves a runnable execution spec for a run or compatibility API. */
  executableAgentResolver?: ExecutableAgentResolver
  eventBus: DzupEventBus
  modelRegistry: ModelRegistry
}

/**
 * HTTP transport / authentication / rate limiting concerns.
 */
export interface ForgeTransportConfig {
  auth?: AuthConfig
  /** Optional RBAC config (MC-S02). Defaults to API-key role extraction; pass `false` to disable. */
  rbac?: RBACConfig | false
  /** Optional Postgres API key store. When provided alongside auth.mode='api-key', validate is wired automatically. */
  apiKeyStore?: PostgresApiKeyStore
  corsOrigins?: string | string[]
  rateLimit?: Partial<RateLimiterConfig>
}

/**
 * Background runtime: queues, executors, journals, scheduler, lifecycle hooks.
 */
export interface ForgeRuntimeConfig {
  runQueue?: RunQueue
  runExecutor?: RunExecutor
  shutdown?: GracefulShutdown
  metrics?: MetricsCollector
  eventGateway?: EventGateway
  consolidation?: ConsolidationConfig
  router?: CostAwareRouter
  reflector?: RunReflectorLike
  retrievalFeedback?: RetrievalFeedbackHookConfig
  journal?: RunJournal
}

/**
 * Optional integrations and feature toggles that mount additional routes.
 */
export interface ForgeIntegrationsConfig {
  memoryService?: MemoryServiceLike
  memoryHealth?: MemoryHealthRouteConfig
  traceStore?: RunTraceStore
  tokenLifecycleRegistry?: TokenLifecycleRegistry
  playground?: PlaygroundRouteConfig
  deploy?: DeployRouteConfig
  learning?: LearningRouteConfig
  benchmark?: BenchmarkRouteConfig
  evals?: EvalRouteConfig
  evalOrchestrator?: EvalOrchestratorLike
  benchmarkOrchestrator?: BenchmarkOrchestratorLike
  mcpManager?: McpManager
  /** Allowlist for stdio MCP server registration. */
  mcpAllowedExecutables?: string[]
  skillRegistry?: AdapterSkillRegistry
  coreSkillRegistry?: SkillRegistry
  workflowRegistry?: WorkflowRegistry
  skillStepResolver?: SkillStepResolver
  compile?: CompileRouteConfig
  routePlugins?: ServerRoutePlugin[]
  a2a?: {
    agentCardConfig: AgentCardConfig
    taskStore?: A2ATaskStore
    onTaskSubmitted?: A2ARoutesConfig['onTaskSubmitted']
    onTaskContinued?: A2ARoutesConfig['onTaskContinued']
  }
  triggerStore?: TriggerStore
  scheduleStore?: ScheduleStore
  onScheduleTrigger?: ScheduleRouteConfig['onManualTrigger']
  promptStore?: PromptStore
  personaStore?: PersonaStore
  notifier?: Notifier
  presetRegistry?: PresetRegistry
  reflectionStore?: RunReflectionStore
  mailboxStore?: MailboxStore
  mailDelivery?: MailDeliveryConfig
  clusterStore?: ClusterStore
  catalogStore?: CatalogStore
  openai?: {
    auth?: OpenAIAuthConfig
  }
  promptFeedbackLoop?: PromptFeedbackLoop | PromptFeedbackLoopLike
  learningEventProcessor?: LearningEventProcessor | LearningEventProcessorLike
  approvalStore?: ApprovalStateStore
}

/**
 * Security policy: safety monitor, quotas, input guard.
 */
export interface ForgeSecurityConfig {
  /** Skip attaching the built-in runtime safety monitor (default false). */
  disableSafetyMonitor?: boolean
  /** Per-key resource quota manager (MC-S01). */
  resourceQuota?: ResourceQuotaManager
  /** MC-S03 input guard configuration. Pass `false` to opt out. */
  security?: {
    inputGuard?: InputGuardConfig | false
  }
}

/**
 * Aggregate config object accepted by `createForgeApp`. Decomposed into focused
 * sub-interfaces so individual composition helpers can ask for narrow slices.
 */
export interface ForgeServerConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeIntegrationsConfig,
    ForgeSecurityConfig {}
