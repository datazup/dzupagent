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
import type { RunTraceStore } from './persistence/run-trace-store.js'
import { createMetricsRoute } from './routes/metrics.js'
import { createDeployRoutes, type DeployRouteConfig } from './routes/deploy.js'
import { createLearningRoutes, type LearningRouteConfig } from './routes/learning.js'
import { createBenchmarkRoutes, type BenchmarkRouteConfig } from './routes/benchmarks.js'
import { createEvalRoutes, type EvalRouteConfig } from './routes/evals.js'
import { PrometheusMetricsCollector } from './metrics/prometheus-collector.js'
import type { ServerRoutePlugin } from './route-plugin.js'
import { createMcpRoutes } from './routes/mcp.js'
import { createSkillRoutes } from './routes/skills.js'
import { createWorkflowRoutes } from './routes/workflows.js'
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
import { createPresetRoutes } from './routes/presets.js'
import { createMarketplaceRoutes } from './routes/marketplace.js'
import type { CatalogStore } from './marketplace/catalog-store.js'
import type { PresetRegistry } from '@dzupagent/agent'
import type { RunReflectionStore } from '@dzupagent/agent'
import type { MailboxStore } from '@dzupagent/agent'
import { InMemoryMailboxStore } from '@dzupagent/agent'
import { createReflectionRoutes } from './routes/reflections.js'
import { createMailboxRoutes } from './routes/mailbox.js'
import { openaiAuthMiddleware, type OpenAIAuthConfig } from './openai/auth-middleware.js'
import { createCompletionsRoute } from './openai/completions-route.js'
import { createModelsRoute } from './openai/models-route.js'
import { SlackNotificationChannel } from './notifications/channels/slack-channel.js'
import { EmailWebhookNotificationChannel } from './notifications/channels/email-webhook-channel.js'
import type { Notifier } from './notifications/notifier.js'

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
  /** Optional marketplace catalog store. When provided, mounts /api/marketplace routes. */
  catalogStore?: CatalogStore
  /** Optional OpenAI-compatible API config. When provided, mounts /v1/chat/completions and /v1/models routes. */
  openai?: {
    /** Auth config for /v1/* routes (independent from /api/* auth). */
    auth?: OpenAIAuthConfig
  }
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

function createBuiltInRoutePlugins(config: ForgeServerConfig): ServerRoutePlugin[] {
  const plugins: ServerRoutePlugin[] = []

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
      }),
    })
  }

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
    app.use('/api/*', authMiddleware(config.auth))
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
  app.route('/api/agents', createAgentRoutes(runtimeConfig))
  app.route('/api/runs', createApprovalRoutes(runtimeConfig))
  app.route('/api/runs', createHumanContactRoutes(runtimeConfig))

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
    const mailboxStore = runtimeConfig.mailboxStore ?? new InMemoryMailboxStore()
    app.route('/api/mailbox', createMailboxRoutes({ mailboxStore }))
  }

  // --- OpenAI-compatible Routes (/v1/*) ---
  {
    // Apply OpenAI auth middleware to all /v1/* routes (separate from /api/* auth)
    app.use('/v1/*', openaiAuthMiddleware(runtimeConfig.openai?.auth))

    app.route('/v1/chat/completions', createCompletionsRoute({
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
    ...createBuiltInRoutePlugins(runtimeConfig),
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

  return app
}
