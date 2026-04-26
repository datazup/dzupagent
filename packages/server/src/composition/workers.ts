/**
 * Background lifecycle wiring: run-queue worker, consolidation scheduler, and
 * the closed-loop self-improvement subscribers (PromptFeedbackLoop +
 * LearningEventProcessor).
 *
 * `startRunWorker` is called at most once per `RunQueue` instance; subsequent
 * `createForgeApp` calls reusing the same queue (e.g. when test code wraps
 * the factory) are no-ops. The shared `WeakSet` is module-scoped and
 * deliberately does not leak through the public API.
 */
import type { Hono } from 'hono'

import type { ForgeServerConfig } from './types.js'
import { startRunWorker, type RunExecutor } from '../runtime/run-worker.js'
import {
  ConsolidationScheduler,
} from '../runtime/consolidation-scheduler.js'
import { createSleepConsolidationTask } from '../runtime/sleep-consolidation-task.js'
import type { RunQueue } from '../queue/run-queue.js'
import { registerShutdownDrainHook } from './utils.js'

const startedRunQueues = new WeakSet<RunQueue>()

export function maybeStartRunWorker(
  runtimeConfig: ForgeServerConfig,
  effectiveRunExecutor: RunExecutor,
): void {
  if (!runtimeConfig.runQueue || startedRunQueues.has(runtimeConfig.runQueue)) {
    return
  }
  startRunWorker({
    runQueue: runtimeConfig.runQueue,
    runStore: runtimeConfig.runStore,
    agentStore: runtimeConfig.agentStore,
    executableAgentResolver: runtimeConfig.executableAgentResolver,
    eventBus: runtimeConfig.eventBus,
    modelRegistry: runtimeConfig.modelRegistry,
    runExecutor: effectiveRunExecutor,
    shutdown: runtimeConfig.shutdown,
    metrics: runtimeConfig.metrics,
    reflector: runtimeConfig.reflector,
    retrievalFeedback: runtimeConfig.retrievalFeedback,
    traceStore: runtimeConfig.traceStore,
    reflectionStore: runtimeConfig.reflectionStore,
    resourceQuota: runtimeConfig.resourceQuota,
    inputGuardConfig: runtimeConfig.security?.inputGuard,
  })
  startedRunQueues.add(runtimeConfig.runQueue)
}

/**
 * Start the consolidation scheduler when configured. Mounts a status endpoint
 * at `GET /api/health/consolidation` if a graceful-shutdown handler is also
 * provided (matching legacy behaviour where the status route was only added
 * alongside shutdown wiring).
 */
export function startConsolidationScheduler(app: Hono, runtimeConfig: ForgeServerConfig): void {
  if (!runtimeConfig.consolidation) {
    return
  }
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
    activeRunCount:
      consolidationCfg.activeRunCount ?? (() => runtimeConfig.runQueue?.stats().active ?? 0),
  })
  scheduler.start()

  if (runtimeConfig.shutdown) {
    registerShutdownDrainHook(runtimeConfig.shutdown, () => scheduler.stop())

    // Expose scheduler status via health route
    app.get('/api/health/consolidation', (c) => c.json({ data: scheduler.status() }))
  }
}

/**
 * Wire the closed-loop self-improvement subscribers. Both the
 * PromptFeedbackLoop (Step 2) and LearningEventProcessor (Step 3) subscribe
 * to `run:scored` events on the shared event bus. They operate independently
 * — one rewrites failing prompts, the other persists learned patterns — and
 * require no direct coupling beyond sharing the bus.
 */
export function startClosedLoopSubscribers(runtimeConfig: ForgeServerConfig): void {
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
}
