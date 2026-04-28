/**
 * Mounts the optional REST surface that depends on capability config flags.
 * Each helper here is a pure side-effect on the Hono app — no return values,
 * no shared state with the rest of the composition pipeline beyond
 * `runtimeConfig`, the resolved `effectiveAuth`, and `eventGateway`.
 *
 * Mount paths and ordering are preserved to match the legacy `app.ts`
 * sequence, since some hosts depend on the registration order
 * (Hono routes are first-match per method).
 */
import type { Hono } from 'hono'

import type { ForgeServerConfig } from './types.js'
import type { EventGateway } from '../events/event-gateway.js'
import type { AuthConfig } from '../middleware/auth.js'
import type { MailboxStore } from '@dzupagent/agent'

import { createMemoryRoutes } from '../routes/memory.js'
import { createMemoryBrowseRoutes } from '../routes/memory-browse.js'
import { createMemoryHealthRoutes } from '../routes/memory-health.js'
import { createEventRoutes } from '../routes/events.js'
import { createDeployRoutes } from '../routes/deploy.js'
import { createLearningRoutes } from '../routes/learning.js'
import { createBenchmarkRoutes, type BenchmarkRouteConfig } from '../routes/benchmarks.js'
import { createEvalRoutes, type EvalRouteConfig } from '../routes/evals.js'
import { createPlaygroundRoutes } from '../routes/playground.js'
import { createA2ARoutes } from '../routes/a2a.js'
import { buildAgentCard } from '../a2a/agent-card.js'
import { InMemoryA2ATaskStore } from '../a2a/task-handler.js'
import type { A2ATaskStore } from '../a2a/task-handler.js'
import { createTriggerRoutes } from '../routes/triggers.js'
import { createScheduleRoutes } from '../routes/schedules.js'
import { createPromptRoutes } from '../routes/prompts.js'
import { createPersonaRoutes } from '../routes/personas.js'
import { createPresetRoutes } from '../routes/presets.js'
import { createMarketplaceRoutes } from '../routes/marketplace.js'
import { createReflectionRoutes } from '../routes/reflections.js'
import { createMailboxRoutes } from '../routes/mailbox.js'
import { createClusterRoutes } from '../routes/clusters.js'
import { authMiddleware } from '../middleware/auth.js'
import { InMemoryMailboxStore } from '@dzupagent/agent'
import {
  MailRateLimiter,
  type MailRateLimiterConfig,
} from '../notifications/mail-rate-limiter.js'
import {
  MailDlqWorker,
  DEFAULT_DLQ_WORKER_INTERVAL_MS,
  DEFAULT_DLQ_WORKER_BATCH_SIZE,
} from '../notifications/mail-dlq-worker.js'
import { DrizzleDlqStore } from '../persistence/drizzle-dlq-store.js'
import { DrizzleMailboxStore } from '../persistence/drizzle-mailbox-store.js'
import { openaiAuthMiddleware } from '../routes/openai-compat/auth-middleware.js'
import { createOpenAICompatCompletionsRoute } from '../routes/openai-compat/completions.js'
import { createModelsRoute } from '../routes/openai-compat/models-route.js'
import { PrometheusMetricsCollector } from '../metrics/prometheus-collector.js'
import { createMetricsRoute } from '../routes/metrics.js'
import { registerShutdownDrainHook } from './utils.js'

export interface OptionalRoutesContext {
  runtimeConfig: ForgeServerConfig
  effectiveAuth: AuthConfig | undefined
  eventGateway: EventGateway
}

export function mountOptionalRoutes(app: Hono, ctx: OptionalRoutesContext): void {
  mountMemoryRoutes(app, ctx)
  mountEventRoutes(app, ctx)
  mountDeployRoutes(app, ctx)
  mountLearningRoutes(app, ctx)
  mountBenchmarkRoutes(app, ctx)
  mountEvalRoutes(app, ctx)
  mountPlaygroundRoute(app, ctx)
  mountA2ARoutes(app, ctx)
  mountTriggerScheduleRoutes(app, ctx)
  mountConfigStoreRoutes(app, ctx)
  mountReflectionRoutes(app, ctx)
  mountMailboxAndClusterRoutes(app, ctx)
  mountOpenAICompatRoutes(app, ctx)
}

function mountMemoryRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.memoryService) {
    app.route('/api/memory', createMemoryRoutes({ memoryService: runtimeConfig.memoryService }))
    app.route('/api/memory-browse', createMemoryBrowseRoutes({ memoryService: runtimeConfig.memoryService }))
  }
  if (runtimeConfig.memoryHealth) {
    app.route('/api/memory', createMemoryHealthRoutes(runtimeConfig.memoryHealth))
  }
}

function mountEventRoutes(app: Hono, { eventGateway }: OptionalRoutesContext): void {
  app.route('/api/events', createEventRoutes({ eventGateway }))
}

function mountDeployRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.deploy) {
    app.route('/api/deploy', createDeployRoutes(runtimeConfig.deploy))
  }
}

function mountLearningRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.learning) {
    app.route('/api/learning', createLearningRoutes(runtimeConfig.learning))
  }
}

function mountBenchmarkRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (!runtimeConfig.benchmark) {
    return
  }
  const benchmarkConfig: BenchmarkRouteConfig = { ...runtimeConfig.benchmark }
  if (runtimeConfig.benchmarkOrchestrator && !benchmarkConfig.orchestrator) {
    benchmarkConfig.orchestrator = runtimeConfig.benchmarkOrchestrator
  }
  app.route('/api/benchmarks', createBenchmarkRoutes(benchmarkConfig))
}

function mountEvalRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (!runtimeConfig.evals) {
    return
  }
  const evalsConfig: EvalRouteConfig = {
    ...runtimeConfig.evals,
    metrics: runtimeConfig.evals.metrics ?? runtimeConfig.metrics,
  }
  if (runtimeConfig.evalOrchestrator && !evalsConfig.orchestrator) {
    evalsConfig.orchestrator = runtimeConfig.evalOrchestrator
  }
  app.route('/api/evals', createEvalRoutes(evalsConfig))
}

function mountPlaygroundRoute(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.playground) {
    app.route('/playground', createPlaygroundRoutes(runtimeConfig.playground))
  }
}

function mountA2ARoutes(app: Hono, ctx: OptionalRoutesContext): void {
  const { runtimeConfig, effectiveAuth } = ctx
  if (!runtimeConfig.a2a) {
    return
  }
  const a2aConfig = runtimeConfig.a2a
  const agentCard = buildAgentCard(a2aConfig.agentCardConfig)

  // Protect A2A routes (except /.well-known/agent.json which must remain
  // public per the A2A spec). The well-known path is mounted at the app
  // root below, so gating `/a2a/*` and `/a2a` leaves discovery
  // unauthenticated while requiring credentials for tasks and JSON-RPC.
  if (effectiveAuth) {
    app.use('/a2a', authMiddleware(effectiveAuth))
    app.use('/a2a/*', authMiddleware(effectiveAuth))
  }

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

function mountTriggerScheduleRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.triggerStore) {
    app.route('/api/triggers', createTriggerRoutes({ triggerStore: runtimeConfig.triggerStore }))
  }
  if (runtimeConfig.scheduleStore) {
    app.route('/api/schedules', createScheduleRoutes({
      scheduleStore: runtimeConfig.scheduleStore,
      onManualTrigger: runtimeConfig.onScheduleTrigger,
    }))
  }
}

function mountConfigStoreRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.promptStore) {
    app.route('/api/prompts', createPromptRoutes({ promptStore: runtimeConfig.promptStore }))
  }
  if (runtimeConfig.personaStore) {
    app.route('/api/personas', createPersonaRoutes({ personaStore: runtimeConfig.personaStore }))
  }
  if (runtimeConfig.presetRegistry) {
    app.route('/api/presets', createPresetRoutes({ presetRegistry: runtimeConfig.presetRegistry }))
  }
  if (runtimeConfig.catalogStore) {
    app.route('/api/marketplace', createMarketplaceRoutes({ catalogStore: runtimeConfig.catalogStore }))
  }
}

function mountReflectionRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.reflectionStore) {
    app.route('/api/reflections', createReflectionRoutes({ reflectionStore: runtimeConfig.reflectionStore }))
  }
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
function mountMailboxAndClusterRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  let mailboxStore: MailboxStore
  let dlqStore: DrizzleDlqStore | undefined

  if (runtimeConfig.mailDelivery) {
    const mailCfg = runtimeConfig.mailDelivery
    const rateLimiterCfg: MailRateLimiterConfig = mailCfg.rateLimiter ?? {}
    const rateLimiter = new MailRateLimiter(rateLimiterCfg)
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

  if (runtimeConfig.clusterStore) {
    app.route('/api/clusters', createClusterRoutes({
      clusterStore: runtimeConfig.clusterStore,
      mailboxStore,
    }))
  }
}

function mountOpenAICompatRoutes(app: Hono, { runtimeConfig }: OptionalRoutesContext): void {
  if (runtimeConfig.openai?.enabled !== true) {
    return
  }

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

/**
 * Mount the Prometheus `/metrics` endpoint when the configured collector is a
 * {@link PrometheusMetricsCollector}. Other collectors (e.g. NoopMetricsCollector)
 * skip this route.
 */
export function mountPrometheusMetricsRoute(app: Hono, runtimeConfig: ForgeServerConfig): void {
  // TODO(security): `/metrics` is currently mounted on the public app and
  // bypasses auth. For production deployments this should be exposed on an
  // internal-only port (e.g. a separate Hono listener bound to 127.0.0.1) or
  // protected by an IP allow-list. Until then, operators are expected to
  // block `/metrics` at the ingress/load-balancer layer.
  if (runtimeConfig.metrics && runtimeConfig.metrics instanceof PrometheusMetricsCollector) {
    app.route('/metrics', createMetricsRoute({ collector: runtimeConfig.metrics }))
  }
}
