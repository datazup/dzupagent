/**
 * Hono app factory for DzupAgent server.
 *
 * Creates a configured Hono application with REST API routes, middleware,
 * and optional WebSocket support.
 *
 * @example
 * ```ts
 * import { createForgeApp } from '@dzupagent/server'
 *
 * const app = createForgeApp({
 *   eventBus: createEventBus(),
 *   modelRegistry: registry,
 *   runStore: new InMemoryRunStore(),
 *   agentStore: new InMemoryAgentStore(),
 * })
 *
 * export default { port: 4000, fetch: app.fetch }
 * ```
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { RunStore, AgentStore, ModelRegistry } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import type { MetricsCollector } from '@dzupagent/core'
import type { CostAwareRouter } from '@dzupagent/core'
import type { McpManager } from '@dzupagent/core'
import type { RunJournal } from '@dzupagent/core'
import type { SkillRegistry, WorkflowRegistry } from '@dzupagent/core'
import type { SkillStepResolver } from '@dzupagent/agent'
import type { AdapterSkillRegistry } from '@dzupagent/agent-adapters'
import { createHealthRoutes } from './routes/health.js'
import { createRunRoutes } from './routes/runs.js'
import { createAgentRoutes } from './routes/agents.js'
import { createApprovalRoutes } from './routes/approval.js'
import { createHumanContactRoutes } from './routes/human-contact.js'
import { createMemoryRoutes } from './routes/memory.js'
import { createMemoryBrowseRoutes } from './routes/memory-browse.js'
import { createPlaygroundRoutes, type PlaygroundRouteConfig } from './routes/playground.js'
import { createEventRoutes } from './routes/events.js'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import { authMiddleware, type AuthConfig } from './middleware/auth.js'
import { rateLimiterMiddleware, type RateLimiterConfig } from './middleware/rate-limiter.js'
import type { RunQueue } from './queue/run-queue.js'
import type { GracefulShutdown } from './lifecycle/graceful-shutdown.js'
import type { EventGateway } from './events/event-gateway.js'
import { InMemoryEventGateway } from './events/event-gateway.js'
import { startRunWorker, type RunExecutor, type RunReflectorLike } from './runtime/run-worker.js'
import type { RetrievalFeedbackHookConfig } from './runtime/retrieval-feedback-hook.js'
import { createDefaultRunExecutor } from './runtime/default-run-executor.js'
import { createDzupAgentRunExecutor } from './runtime/dzip-agent-run-executor.js'
import { ConsolidationScheduler, type ConsolidationSchedulerConfig } from './runtime/consolidation-scheduler.js'
import { createSleepConsolidationTask, type SleepConsolidatorLike } from './runtime/sleep-consolidation-task.js'
import { createMemoryHealthRoutes, type MemoryHealthRouteConfig } from './routes/memory-health.js'
import { createRoutingStatsRoutes } from './routes/routing-stats.js'
import { createRunTraceRoutes } from './routes/run-trace.js'
import { createEnrichmentMetricsRoute } from './routes/enrichment-metrics.js'
import { createRunContextRoutes, type TokenLifecycleRegistry } from './routes/run-context.js'
import type { RunTraceStore } from './persistence/run-trace-store.js'
import { createMetricsRoute } from './routes/metrics.js'
import { createDeployRoutes, type DeployRouteConfig } from './routes/deploy.js'
import { createLearningRoutes, type LearningRouteConfig } from './routes/learning.js'
import type { PromptFeedbackLoop } from './services/prompt-feedback-loop.js'
import type { LearningEventProcessor } from './services/learning-event-processor.js'
import { createBenchmarkRoutes, type BenchmarkRouteConfig } from './routes/benchmarks.js'
import { createEvalRoutes, type EvalRouteConfig } from './routes/evals.js'
import { PrometheusMetricsCollector } from './metrics/prometheus-collector.js'
import type { ServerRoutePlugin } from './route-plugin.js'
import { createMcpRoutes } from './routes/mcp.js'
import { createSkillRoutes } from './routes/skills.js'
import { createWorkflowRoutes } from './routes/workflows.js'
import { createCompileRoutes, type CompileRouteConfig } from './routes/compile.js'
import { createA2ARoutes, type A2ARoutesConfig } from './routes/a2a.js'
import { buildAgentCard, type AgentCardConfig } from './a2a/agent-card.js'
import { InMemoryA2ATaskStore } from './a2a/task-handler.js'
import type { A2ATaskStore } from './a2a/task-handler.js'
import { createTriggerRoutes } from './routes/triggers.js'
import type { TriggerStore } from './triggers/trigger-store.js'
import { createScheduleRoutes } from './routes/schedules.js'
import type { ScheduleStore } from './schedules/schedule-store.js'
import type { ScheduleRouteConfig } from './routes/schedules.js'
import { createPersonaRoutes } from './routes/personas.js'
import type { PersonaStore } from './personas/persona-store.js'
import { createPromptRoutes } from './routes/prompts.js'
import type { PromptStore } from './prompts/prompt-store.js'
import { createPresetRoutes } from './routes/presets.js'
import { createMarketplaceRoutes } from './routes/marketplace.js'
import type { CatalogStore } from './marketplace/catalog-store.js'
import type { PresetRegistry } from '@dzupagent/agent'
import type { RunReflectionStore } from '@dzupagent/agent'
import type { MailboxStore } from '@dzupagent/agent'
import { InMemoryMailboxStore } from '@dzupagent/agent'
import { createReflectionRoutes } from './routes/reflections.js'
import { createMailboxRoutes } from './routes/mailbox.js'
import { createClusterRoutes } from './routes/clusters.js'
import type { ClusterStore } from './persistence/drizzle-cluster-store.js'
import { openaiAuthMiddleware, type OpenAIAuthConfig } from './routes/openai-compat/auth-middleware.js'
import { createOpenAICompatCompletionsRoute } from './routes/openai-compat/completions.js'
import { createModelsRoute } from './routes/openai-compat/models-route.js'
import { SlackNotificationChannel } from './notifications/channels/slack-channel.js'
import { EmailWebhookNotificationChannel } from './notifications/channels/email-webhook-channel.js'
import type { Notifier } from './notifications/notifier.js'
import {
  MailRateLimiter,
  type MailRateLimiterConfig,
} from './notifications/mail-rate-limiter.js'
import {
  MailDlqWorker,
  DEFAULT_DLQ_WORKER_INTERVAL_MS,
  DEFAULT_DLQ_WORKER_BATCH_SIZE,
} from './notifications/mail-dlq-worker.js'
import { DrizzleDlqStore } from './persistence/drizzle-dlq-store.js'
import { DrizzleMailboxStore } from './persistence/drizzle-mailbox-store.js'
import type { PostgresApiKeyStore } from './persistence/api-key-store.js'
import { createApiKeyRoutes } from './routes/api-keys.js'

// Drizzle DB clients are opaque at this layer — we intentionally avoid a hard
// dependency on `drizzle-orm/postgres-js` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

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

export interface ForgeServerConfig {
  runStore: RunStore
  agentStore: AgentStore
  eventBus: DzupEventBus
  modelRegistry: ModelRegistry
  auth?: AuthConfig
  /** Optional Postgres API key store. When provided alongside auth.mode='api-key',
   *  store.validate is wired as the validateKey callback automatically. */
  apiKeyStore?: PostgresApiKeyStore
  corsOrigins?: string | string[]
  /** Rate limiting configuration (disabled if not provided) */
  rateLimit?: Partial<RateLimiterConfig>
  /** Background run queue (in-memory queue used if not provided) */
  runQueue?: RunQueue
  /** Async run executor used by queue workers to process jobs */
  runExecutor?: RunExecutor
  /** Graceful shutdown handler */
  shutdown?: GracefulShutdown
  /** Metrics collector for observability */
  metrics?: MetricsCollector
  /** Memory service for Arrow IPC export/import routes */
  memoryService?: MemoryServiceLike
  /** Optional event gateway for SSE/WS fan-out; defaults to in-memory bridge backed by eventBus */
  eventGateway?: EventGateway
  /** Optional static playground mount at `/playground` */
  playground?: PlaygroundRouteConfig
  /** Optional consolidation scheduler config — starts periodic memory consolidation.
   *
   * Two modes:
   * 1. Explicit task: provide `task` (a ConsolidationTask) directly.
   * 2. Auto-created task: provide `consolidator` + `store` + `namespaces` and the
   *    server will call `createSleepConsolidationTask()` to build the task for you.
   */
  consolidation?: ConsolidationConfig
  /** Optional memory health route config (enables GET /api/memory/health) */
  memoryHealth?: MemoryHealthRouteConfig
  /** Optional run trace store for step-by-step replay and debugging */
  traceStore?: RunTraceStore
  /** Optional token lifecycle registry — when provided, `/api/runs/:id/context`
   *  pulls live token usage + status from the manager associated with the run.
   *  Run executors are responsible for populating the registry on start and
   *  clearing it on completion. Omitted → the route falls back to run metadata
   *  and logs, returning a zero-state report when nothing is known. */
  tokenLifecycleRegistry?: TokenLifecycleRegistry
  /** Optional cost-aware router — automatically selects optimal model tier per run based on input complexity */
  router?: CostAwareRouter
  /** Optional run reflector — scores every completed run for quality tracking.
   *  Uses structural typing to avoid a hard dependency on @dzupagent/agent. */
  reflector?: RunReflectorLike
  /** Optional retrieval feedback config. When provided alongside a reflector,
   *  maps reflection scores to AdaptiveRetriever feedback for weight learning. */
  retrievalFeedback?: RetrievalFeedbackHookConfig
  /** Optional deploy confidence + history route config. When provided, mounts /api/deploy routes. */
  deploy?: DeployRouteConfig
  /** Optional learning route config. When provided, mounts /api/learning routes for self-learning dashboard. */
  learning?: LearningRouteConfig
  /** Optional benchmark routes config. When provided, mounts /api/benchmarks routes. */
  benchmark?: BenchmarkRouteConfig
  /** Optional eval routes config. When provided, mounts /api/evals routes. */
  evals?: EvalRouteConfig
  /** Optional MCP manager — enables /api/mcp routes for server lifecycle management */
  mcpManager?: McpManager
  /** Optional adapter skill registry — enables /api/skills routes for skill preview */
  skillRegistry?: AdapterSkillRegistry
  /** Optional RunJournal for durability features (fork, checkpoints, resumeFromStep) */
  journal?: RunJournal
  /** Optional core SkillRegistry — enables /api/workflows routes for workflow execution */
  coreSkillRegistry?: SkillRegistry
  /** Optional WorkflowRegistry — provides named workflow lookup for /api/workflows */
  workflowRegistry?: WorkflowRegistry
  /** Optional skill step resolver — required alongside coreSkillRegistry for workflow execution */
  skillStepResolver?: SkillStepResolver
  /** Optional flow compiler route config. Defaults to mounting `POST /api/workflows/compile`
   *  with a no-op tool resolver when omitted; provide a resolver to wire the domain catalog. */
  compile?: CompileRouteConfig
  /** Optional domain route plugins mounted after built-in core routes */
  routePlugins?: ServerRoutePlugin[]
  /** Optional A2A (Agent-to-Agent) protocol config.
   *  When provided, mounts A2A routes at `/a2a` and `/.well-known/agent.json`. */
  a2a?: {
    agentCardConfig: AgentCardConfig
    taskStore?: A2ATaskStore
    onTaskSubmitted?: A2ARoutesConfig['onTaskSubmitted']
    onTaskContinued?: A2ARoutesConfig['onTaskContinued']
  }
  /** Optional trigger store for persistent trigger configuration */
  triggerStore?: TriggerStore
  /** Optional schedule store for cron-based schedule management */
  scheduleStore?: ScheduleStore
  /** Optional callback invoked when a schedule is manually triggered */
  onScheduleTrigger?: ScheduleRouteConfig['onManualTrigger']
  /** Optional prompt store for prompt version management */
  promptStore?: PromptStore
  /** Optional persona store for persona management */
  personaStore?: PersonaStore
  /** Optional notifier for escalation notifications */
  notifier?: Notifier
  /** Optional preset registry for preset HTTP API */
  presetRegistry?: PresetRegistry
  /** Optional reflection store for run reflection HTTP API */
  reflectionStore?: RunReflectionStore
  /** Optional mailbox store for inter-agent messaging. Defaults to InMemoryMailboxStore if not provided. */
  mailboxStore?: MailboxStore
  /**
   * Optional mail delivery infrastructure. When provided, a
   * {@link MailRateLimiter} and {@link DrizzleDlqStore} are constructed, wired
   * into a new {@link DrizzleMailboxStore} (overriding `mailboxStore`), and a
   * {@link MailDlqWorker} is started to drain the DLQ periodically.
   */
  mailDelivery?: MailDeliveryConfig
  /** Optional cluster store for multi-role agent teams. When provided, mounts /api/clusters routes. */
  clusterStore?: ClusterStore
  /** Optional marketplace catalog store. When provided, mounts /api/marketplace routes. */
  catalogStore?: CatalogStore
  /** Optional OpenAI-compatible API config. When provided, mounts /v1/chat/completions and /v1/models routes. */
  openai?: {
    /** Auth config for /v1/* routes (independent from /api/* auth). */
    auth?: OpenAIAuthConfig
  }
  /**
   * Optional prompt feedback loop (Step 2 of the closed-loop self-improvement
   * system). When provided, `start()` is invoked during `createForgeApp` and
   * `stop()` is registered on the graceful shutdown drain hook (if
   * `config.shutdown` is also provided). The loop consumes `run:scored`
   * events off `config.eventBus` and invokes its prompt optimizer when a run
   * scores below its configured threshold.
   */
  promptFeedbackLoop?: PromptFeedbackLoop | PromptFeedbackLoopLike
  /**
   * Optional learning event processor (Step 3 of the closed-loop system).
   * When provided, `start()` is invoked during `createForgeApp` and `stop()`
   * is registered on the graceful shutdown drain hook (if `config.shutdown`
   * is also provided). The processor consumes `run:scored` events off
   * `config.eventBus` and persists extracted patterns to memory.
   *
   * Note: the feedback loop and learning processor each subscribe to
   * `run:scored` independently — no explicit forwarding is required. Both
   * simply observe the same shared event bus.
   */
  learningEventProcessor?: LearningEventProcessor | LearningEventProcessorLike
}

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

const startedRunQueues = new WeakSet<RunQueue>()

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface ExplicitRetentionMetadata {
  explicitUnbounded: boolean
}

function readExplicitRetentionMetadata(value: unknown): ExplicitRetentionMetadata | null {
  if (!isObject(value)) {
    return null
  }

  const metadata = value['__dzupagentRetention']
  if (!isObject(metadata) || typeof metadata['explicitUnbounded'] !== 'boolean') {
    return null
  }

  return {
    explicitUnbounded: metadata['explicitUnbounded'],
  }
}

function registerShutdownDrainHook(
  shutdown: GracefulShutdown,
  hook: () => Promise<void>,
): void {
  const shutdownConfig = shutdown as unknown as { config: { onDrain?: () => Promise<void> } }
  const previousOnDrain = shutdownConfig.config.onDrain

  shutdownConfig.config.onDrain = async () => {
    let hookError: unknown

    try {
      await hook()
    } catch (error) {
      hookError = error
    }

    try {
      await previousOnDrain?.()
    } finally {
      if (hookError) {
        throw hookError
      }
    }
  }
}

function warnIfUnboundedInMemoryRetention(config: ForgeServerConfig): void {
  const runStoreRetention = readExplicitRetentionMetadata(config.runStore)
  if (runStoreRetention?.explicitUnbounded) {
      console.warn(
        '[ForgeServer] InMemoryRunStore is running with unbounded retention. ' +
          'Set finite limits for production workloads unless this opt-out is intentional.',
      )
  }

  const traceStoreRetention = readExplicitRetentionMetadata(config.traceStore)
  if (traceStoreRetention?.explicitUnbounded) {
      console.warn(
        '[ForgeServer] InMemoryRunTraceStore is running with unbounded retention. ' +
          'Set finite limits for production workloads unless this opt-out is intentional.',
      )
  }
}

function mountRoutePlugins(
  app: Hono,
  plugins: readonly ServerRoutePlugin[],
  serverConfig: ForgeServerConfig,
): void {
  for (const plugin of plugins) {
    if (!plugin.prefix.startsWith('/')) {
      console.warn(
        `[ForgeServer] Skipping route plugin with invalid prefix "${plugin.prefix}". Prefix must start with '/'.`,
      )
      continue
    }

    const subApp = plugin.createRoutes() as Parameters<typeof app.route>[1]
    app.route(plugin.prefix, subApp)
    plugin.onMount?.(serverConfig)
  }
}

function createBuiltInRoutePlugins(config: ForgeServerConfig, eventGateway: EventGateway): ServerRoutePlugin[] {
  const plugins: ServerRoutePlugin[] = []
  const effectiveCompileConfig: CompileRouteConfig | undefined =
    config.compile?.personaResolver || !config.personaStore
      ? {
          ...(config.compile ?? {}),
          eventGateway,
        }
      : {
          ...(config.compile ?? {}),
          personaStore: config.personaStore,
          eventGateway,
        }

  if (config.mcpManager) {
    plugins.push({
      prefix: '/api/mcp',
      createRoutes: () => createMcpRoutes({ mcpManager: config.mcpManager }),
    })
  }

  if (config.skillRegistry) {
    plugins.push({
      prefix: '/api/skills',
      createRoutes: () => createSkillRoutes({ skillRegistry: config.skillRegistry }),
    })
  }

  if (config.coreSkillRegistry || config.skillStepResolver) {
    plugins.push({
      prefix: '/api/workflows',
      createRoutes: () => createWorkflowRoutes({
        skillRegistry: config.coreSkillRegistry,
        workflowRegistry: config.workflowRegistry,
        resolver: config.skillStepResolver,
        eventBus: config.eventBus,
        compile: effectiveCompileConfig,
      }),
    })
  }

  // Flow compiler route is always available — it has no hard dependencies.
  // A no-op tool resolver is used when `config.compile` is omitted; callers
  // can wire a domain catalog via `config.compile.toolResolver`.
  plugins.push({
    prefix: '/api/workflows',
    createRoutes: () => createCompileRoutes(effectiveCompileConfig ?? {}),
  })

  return plugins
}

export function createForgeApp(config: ForgeServerConfig): Hono {
  warnIfUnboundedInMemoryRetention(config)

  const app = new Hono()
  const eventGateway = config.eventGateway ?? new InMemoryEventGateway(config.eventBus)
  const fallbackRunExecutor = createDefaultRunExecutor(config.modelRegistry)
  const effectiveRunExecutor = config.runExecutor
    ?? createDzupAgentRunExecutor({ fallback: fallbackRunExecutor })
  const runtimeConfig: ForgeServerConfig = {
    ...config,
    runExecutor: effectiveRunExecutor,
  }

  if (runtimeConfig.runQueue && !startedRunQueues.has(runtimeConfig.runQueue)) {
    startRunWorker({
      runQueue: runtimeConfig.runQueue,
      runStore: runtimeConfig.runStore,
      agentStore: runtimeConfig.agentStore,
      eventBus: runtimeConfig.eventBus,
      modelRegistry: runtimeConfig.modelRegistry,
      runExecutor: effectiveRunExecutor,
      shutdown: runtimeConfig.shutdown,
      metrics: runtimeConfig.metrics,
      reflector: runtimeConfig.reflector,
      retrievalFeedback: runtimeConfig.retrievalFeedback,
      traceStore: runtimeConfig.traceStore,
      reflectionStore: runtimeConfig.reflectionStore,
    })
    startedRunQueues.add(runtimeConfig.runQueue)
  }

  // --- Middleware ---
  app.use('*', cors({
    origin: config.corsOrigins ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))

  if (config.auth) {
    let effectiveAuth = config.auth
    if (
      config.auth.mode === 'api-key' &&
      !config.auth.validateKey &&
      config.apiKeyStore
    ) {
      effectiveAuth = {
        ...config.auth,
        validateKey: async (key) => {
          const record = await config.apiKeyStore!.validate(key)
          return record ? { ...record } as Record<string, unknown> : null
        },
      }
    }
    app.use('/api/*', authMiddleware(effectiveAuth))
  }

  if (config.rateLimit) {
    app.use('/api/*', rateLimiterMiddleware(config.rateLimit))
  }

  // --- Shutdown guard: reject new runs when draining ---
  if (config.shutdown) {
    app.use('/api/runs', async (c, next) => {
      if (c.req.method === 'POST' && !config.shutdown!.isAcceptingRuns()) {
        return c.json(
          { error: { code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down' } },
          503,
        )
      }
      return next()
    })
  }

  // --- Request metrics ---
  if (config.metrics) {
    app.use('*', async (c, next) => {
      const start = Date.now()
      await next()
      const latency = Date.now() - start
      config.metrics!.increment('http_requests_total', {
        method: c.req.method,
        path: c.req.path,
        status: String(c.res.status),
      })
      config.metrics!.observe('http_request_duration_ms', latency, {
        method: c.req.method,
        path: c.req.path,
      })
    })
  }

  // --- Global error handler ---
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
     
    console.error(`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`)
    config.metrics?.increment('http_errors_total', { path: c.req.path })
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    )
  })

  // --- Routes ---
  app.route('/api/health', createHealthRoutes(runtimeConfig))
  app.route('/api/health', createRoutingStatsRoutes({ runStore: runtimeConfig.runStore }))
  app.route('/api/runs', createRunRoutes(runtimeConfig))
  app.route('/api/runs', createRunContextRoutes(runtimeConfig))
  app.route('/api/agents', createAgentRoutes(runtimeConfig))
  if (runtimeConfig.apiKeyStore) {
    const allowedTiers = runtimeConfig.rateLimit?.tiers
      ? Object.keys(runtimeConfig.rateLimit.tiers)
      : undefined
    app.route('/api/keys', createApiKeyRoutes({ store: runtimeConfig.apiKeyStore, allowedTiers }))
  }
  app.route('/api/runs', createApprovalRoutes(runtimeConfig))
  app.route('/api/runs', createHumanContactRoutes(runtimeConfig))
  app.route('/api/runs', createEnrichmentMetricsRoute({ runStore: runtimeConfig.runStore }))

  if (runtimeConfig.traceStore) {
    app.route('/api/runs', createRunTraceRoutes({
      runStore: runtimeConfig.runStore,
      traceStore: runtimeConfig.traceStore,
    }))
  }

  if (runtimeConfig.memoryService) {
    app.route('/api/memory', createMemoryRoutes({ memoryService: runtimeConfig.memoryService }))
    app.route('/api/memory-browse', createMemoryBrowseRoutes({ memoryService: runtimeConfig.memoryService }))
  }

  if (runtimeConfig.memoryHealth) {
    app.route('/api/memory', createMemoryHealthRoutes(runtimeConfig.memoryHealth))
  }

  app.route('/api/events', createEventRoutes({ eventGateway }))

  if (runtimeConfig.deploy) {
    app.route('/api/deploy', createDeployRoutes(runtimeConfig.deploy))
  }

  if (runtimeConfig.learning) {
    app.route('/api/learning', createLearningRoutes(runtimeConfig.learning))
  }

  if (runtimeConfig.benchmark) {
    app.route('/api/benchmarks', createBenchmarkRoutes(runtimeConfig.benchmark))
  }

  if (runtimeConfig.evals) {
    app.route('/api/evals', createEvalRoutes({
      ...runtimeConfig.evals,
      metrics: runtimeConfig.evals.metrics ?? runtimeConfig.metrics,
    }))
  }

  if (runtimeConfig.playground) {
    app.route('/playground', createPlaygroundRoutes(runtimeConfig.playground))
  }

  // --- A2A Protocol ---
  if (runtimeConfig.a2a) {
    const a2aConfig = runtimeConfig.a2a
    const agentCard = buildAgentCard(a2aConfig.agentCardConfig)

    // Select task store: Drizzle if env flag set, otherwise provided or in-memory
    let taskStore: A2ATaskStore
    if (a2aConfig.taskStore) {
      taskStore = a2aConfig.taskStore
    } else if (process.env['USE_DRIZZLE_A2A'] === 'true') {
      // DrizzleA2ATaskStore requires a db instance passed via taskStore config
      // Fall back to in-memory if no store was explicitly provided
      taskStore = new InMemoryA2ATaskStore()
    } else {
      taskStore = new InMemoryA2ATaskStore()
    }

    const a2aRoutes = createA2ARoutes({
      agentCard,
      taskStore,
      onTaskSubmitted: a2aConfig.onTaskSubmitted,
      onTaskContinued: a2aConfig.onTaskContinued,
    })
    app.route('', a2aRoutes)
  }

  // --- Trigger Routes ---
  if (runtimeConfig.triggerStore) {
    app.route('/api/triggers', createTriggerRoutes({ triggerStore: runtimeConfig.triggerStore }))
  }

  // --- Schedule Routes ---
  if (runtimeConfig.scheduleStore) {
    app.route('/api/schedules', createScheduleRoutes({
      scheduleStore: runtimeConfig.scheduleStore,
      onManualTrigger: runtimeConfig.onScheduleTrigger,
    }))
  }

  // --- Prompt Routes ---
  if (runtimeConfig.promptStore) {
    app.route('/api/prompts', createPromptRoutes({ promptStore: runtimeConfig.promptStore }))
  }

  // --- Persona Routes ---
  if (runtimeConfig.personaStore) {
    app.route('/api/personas', createPersonaRoutes({ personaStore: runtimeConfig.personaStore }))
  }

  // --- Preset Routes ---
  if (runtimeConfig.presetRegistry) {
    app.route('/api/presets', createPresetRoutes({ presetRegistry: runtimeConfig.presetRegistry }))
  }

  // --- Marketplace Routes ---
  if (runtimeConfig.catalogStore) {
    app.route('/api/marketplace', createMarketplaceRoutes({ catalogStore: runtimeConfig.catalogStore }))
  }

  // --- Reflection Routes ---
  if (runtimeConfig.reflectionStore) {
    app.route('/api/reflections', createReflectionRoutes({ reflectionStore: runtimeConfig.reflectionStore }))
  }

  // --- Mailbox Routes ---
  {
    let mailboxStore: MailboxStore
    let dlqStore: DrizzleDlqStore | undefined

    if (runtimeConfig.mailDelivery) {
      const mailCfg = runtimeConfig.mailDelivery
      const rateLimiter = new MailRateLimiter(mailCfg.rateLimiter ?? {})
      dlqStore = new DrizzleDlqStore(mailCfg.db)
      mailboxStore = new DrizzleMailboxStore(mailCfg.db, {
        rateLimiter,
        dlq: dlqStore,
      })

      // Start the DLQ drain worker and register shutdown cleanup.
      const worker = new MailDlqWorker({
        dlq: dlqStore,
        mailbox: mailboxStore,
        intervalMs: mailCfg.dlqWorkerIntervalMs ?? DEFAULT_DLQ_WORKER_INTERVAL_MS,
        batchSize: mailCfg.dlqBatchSize ?? DEFAULT_DLQ_WORKER_BATCH_SIZE,
      })
      worker.start()

      if (runtimeConfig.shutdown) {
        registerShutdownDrainHook(runtimeConfig.shutdown, () => worker.stop())
      }
    } else {
      mailboxStore = runtimeConfig.mailboxStore ?? new InMemoryMailboxStore()
    }

    app.route('/api/mailbox', createMailboxRoutes({ mailboxStore, dlqStore }))

    // --- Cluster Routes ---
    if (runtimeConfig.clusterStore) {
      app.route('/api/clusters', createClusterRoutes({
        clusterStore: runtimeConfig.clusterStore,
        mailboxStore,
      }))
    }
  }

  // --- OpenAI-compatible Routes (/v1/*) ---
  {
    // Apply OpenAI auth middleware to all /v1/* routes (separate from /api/* auth)
    app.use('/v1/*', openaiAuthMiddleware(runtimeConfig.openai?.auth))

    app.route('/v1/chat/completions', createOpenAICompatCompletionsRoute({
      agentStore: runtimeConfig.agentStore,
      modelRegistry: runtimeConfig.modelRegistry,
      eventBus: runtimeConfig.eventBus,
    }))

    app.route('/v1/models', createModelsRoute({
      agentStore: runtimeConfig.agentStore,
    }))
  }

  // --- Auto-register notification channels from env vars ---
  if (runtimeConfig.notifier) {
    const slackUrl = process.env['SLACK_NOTIFICATION_WEBHOOK_URL']
    if (slackUrl) {
      runtimeConfig.notifier.addChannel(new SlackNotificationChannel({ webhookUrl: slackUrl }))
    }

    const emailUrl = process.env['EMAIL_NOTIFICATION_WEBHOOK_URL']
    if (emailUrl) {
      runtimeConfig.notifier.addChannel(
        new EmailWebhookNotificationChannel({
          webhookUrl: emailUrl,
          secret: process.env['EMAIL_NOTIFICATION_WEBHOOK_SECRET'],
        }),
      )
    }
  }

  const allRoutePlugins = [
    ...createBuiltInRoutePlugins(runtimeConfig, eventGateway),
    ...(runtimeConfig.routePlugins ?? []),
  ]
  if (allRoutePlugins.length) {
    mountRoutePlugins(app, allRoutePlugins, runtimeConfig)
  }

  // --- Prometheus metrics endpoint (only when using PrometheusMetricsCollector) ---
  if (runtimeConfig.metrics && runtimeConfig.metrics instanceof PrometheusMetricsCollector) {
    app.route('/metrics', createMetricsRoute({ collector: runtimeConfig.metrics }))
  }

  // --- Consolidation scheduler ---
  if (runtimeConfig.consolidation) {
    const consolidationCfg = runtimeConfig.consolidation

    // Resolve the consolidation task: explicit `task` or auto-created from consolidator config
    const task = 'task' in consolidationCfg
      ? consolidationCfg.task
      : createSleepConsolidationTask({
          consolidator: consolidationCfg.consolidator,
          store: consolidationCfg.store,
          namespaces: consolidationCfg.namespaces,
        })

    const scheduler = new ConsolidationScheduler({
      task,
      intervalMs: consolidationCfg.intervalMs,
      idleThresholdMs: consolidationCfg.idleThresholdMs,
      maxConcurrent: consolidationCfg.maxConcurrent,
      eventBus: runtimeConfig.eventBus,
      activeRunCount: consolidationCfg.activeRunCount ?? (() => runtimeConfig.runQueue?.stats().active ?? 0),
    })
    scheduler.start()

    // Register with shutdown if available
    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, () => scheduler.stop())

      // Expose scheduler status via health route
      app.get('/api/health/consolidation', (c) => c.json({ data: scheduler.status() }))
    }
  }

  // --- Closed-loop self-improvement wiring ---
  // Both the PromptFeedbackLoop (Step 2) and LearningEventProcessor (Step 3)
  // subscribe to `run:scored` events on the shared event bus. They operate
  // independently — one rewrites failing prompts, the other persists learned
  // patterns — and require no direct coupling beyond sharing the bus.
  if (runtimeConfig.promptFeedbackLoop) {
    const loop = runtimeConfig.promptFeedbackLoop
    loop.start()
    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, async () => {
        loop.stop()
      })
    }
  }

  if (runtimeConfig.learningEventProcessor) {
    const processor = runtimeConfig.learningEventProcessor
    processor.start()
    if (runtimeConfig.shutdown) {
      registerShutdownDrainHook(runtimeConfig.shutdown, async () => {
        processor.stop()
      })
    }
  }

  return app
}
