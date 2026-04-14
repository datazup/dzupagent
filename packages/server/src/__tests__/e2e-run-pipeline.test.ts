/**
 * End-to-end integration test for the full run pipeline.
 *
 * Exercises: run creation -> queue -> cost-aware routing -> context transfer
 * -> execution -> completion, with trace propagation throughout.
 *
 * All tests are fully in-memory with no network, LLM, or DB calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  IntentRouter,
  KeywordMatcher,
  CostAwareRouter,
  RunContextTransfer,
  extractTraceContext,
  injectTraceContext,
} from '@dzupagent/core'
import type { DzupEventBus, Run, LogEntry } from '@dzupagent/core'
import { InMemoryStore } from '@langchain/langgraph'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import type { RunExecutor, RunExecutorResult } from '../runtime/run-worker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

/** Poll the run store until the run reaches a terminal status. */
async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<Run> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const run = await store.get(runId)
    if (
      run &&
      ['completed', 'failed', 'rejected', 'cancelled'].includes(run.status)
    ) {
      return run
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for run ${runId} to reach terminal state`)
}

/** Create a CostAwareRouter backed by keyword matching (no LLM). */
function createTestRouter(): CostAwareRouter {
  const keywordMatcher = new KeywordMatcher()
  keywordMatcher
    .addPattern(/generate|implement|build|create feature|refactor|debug/i, 'generate_feature')
    .addPattern(/edit|update|modify|change/i, 'edit_feature')
    .addPattern(/configure|setup|setting/i, 'configure')

  const intentRouter = new IntentRouter({
    keywordMatcher,
    defaultIntent: 'chat',
  })

  return new CostAwareRouter({
    intentRouter,
    forceExpensiveIntents: ['generate_feature'],
  })
}

/** A simple run executor that echoes input and returns structured results. */
function createEchoExecutor(
  overrides?: Partial<RunExecutorResult>,
): RunExecutor {
  return async ({ input, metadata }) => {
    const payload = input as Record<string, unknown> | string
    const message =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null
          ? (payload['message'] as string) ?? JSON.stringify(payload)
          : String(payload)

    return {
      output: {
        message: `echo: ${message}`,
        summary: `Processed: ${message}`,
      },
      tokenUsage: { input: 100, output: 50 },
      costCents: 0.5,
      metadata: {
        decisions: ['decision-A', 'decision-B'],
        relevantFiles: ['src/index.ts'],
        workingState: { step: 'done' },
        ...(overrides?.metadata ?? {}),
      },
      logs: overrides?.logs ?? [],
    } satisfies RunExecutorResult
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('E2E run pipeline', () => {
  let runStore: InMemoryRunStore
  let agentStore: InMemoryAgentStore
  let eventBus: DzupEventBus
  let runQueue: InMemoryRunQueue
  let modelRegistry: ModelRegistry

  beforeEach(async () => {
    runStore = new InMemoryRunStore()
    agentStore = new InMemoryAgentStore()
    eventBus = createEventBus()
    runQueue = new InMemoryRunQueue({ concurrency: 2 })
    modelRegistry = new ModelRegistry()

    // Seed a codegen agent and a chat agent
    await agentStore.save({
      id: 'codegen-agent',
      name: 'Codegen Agent',
      instructions: 'You generate code.',
      modelTier: 'codegen',
      active: true,
      metadata: { intent: 'generate_feature' },
    })

    await agentStore.save({
      id: 'chat-agent',
      name: 'Chat Agent',
      instructions: 'You answer questions.',
      modelTier: 'chat',
      active: true,
    })
  })

  afterEach(async () => {
    await runQueue.stop(false)
  })

  // -------------------------------------------------------------------------
  // Scenario 1: Full pipeline with model tier routing
  // -------------------------------------------------------------------------
  describe('full pipeline: run creation -> queue -> execution -> completion with model tier routing', () => {
    it('routes a complex codegen message to the codegen model tier and completes the run', async () => {
      const router = createTestRouter()
      const executor = createEchoExecutor()

      const config: ForgeServerConfig = {
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runQueue,
        runExecutor: executor,
        router,
      }
      const app = createForgeApp(config)

      // Collect events
      const seenEvents: string[] = []
      eventBus.onAny((event) => {
        if ('runId' in event) {
          seenEvents.push(event.type)
        }
      })

      // POST with a complex message that triggers 'generate_feature' intent -> 'codegen' tier
      const complexMessage =
        'Please implement a new authentication feature with JWT tokens and database migration for the user table'

      const res = await req(app, 'POST', '/api/runs', {
        agentId: 'codegen-agent',
        input: complexMessage,
        metadata: { sessionId: 'session-e2e-1' },
      })

      expect(res.status).toBe(202)
      const body = (await res.json()) as {
        data: { id: string; status: string; metadata: Record<string, unknown> }
        queue: { accepted: boolean; jobId: string }
      }

      expect(body.data.status).toBe('queued')
      expect(body.queue.accepted).toBe(true)

      // Verify routing metadata was set on the run
      const runId = body.data.id
      const queuedRun = await runStore.get(runId)
      expect(queuedRun).not.toBeNull()
      expect(queuedRun!.metadata?.['modelTier']).toBe('codegen')
      expect(queuedRun!.metadata?.['routingReason']).toBe('forced')
      expect(queuedRun!.metadata?.['complexity']).toBeDefined()

      // Wait for the run to complete via the queue worker
      const completedRun = await waitForTerminalStatus(runStore, runId)
      expect(completedRun.status).toBe('completed')
      expect(completedRun.output).toBeDefined()

      const output = completedRun.output as { message: string }
      expect(output.message).toContain('echo:')

      // Token usage and cost should be recorded
      expect(completedRun.tokenUsage).toEqual({ input: 100, output: 50 })
      expect(completedRun.costCents).toBe(0.5)

      // Verify lifecycle events were emitted
      expect(seenEvents).toContain('agent:started')
      expect(seenEvents).toContain('agent:completed')

      // Verify logs were recorded
      const logs = await runStore.getLogs(runId)
      const phases = logs.map((l) => l.phase).filter(Boolean)
      expect(phases).toContain('queue')
      expect(phases).toContain('run')
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 2: Context transfer between runs
  // -------------------------------------------------------------------------
  describe('context transfer: second run loads context from first', () => {
    it('persists context after run 1 and loads it into run 2 metadata', async () => {
      const baseStore = new InMemoryStore()
      const contextTransfer = new RunContextTransfer({ store: baseStore })
      const executor = createEchoExecutor()

      // Start the worker with context transfer enabled
      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: executor,
        contextTransfer,
      })

      // --- Run 1: generate_feature ---
      const run1 = await runStore.create({
        agentId: 'codegen-agent',
        input: { message: 'Generate auth feature' },
        metadata: {
          sessionId: 'session-ctx-transfer',
          intent: 'generate_feature',
        },
      })

      await runQueue.enqueue({
        runId: run1.id,
        agentId: 'codegen-agent',
        input: { message: 'Generate auth feature' },
        metadata: {
          sessionId: 'session-ctx-transfer',
          intent: 'generate_feature',
        },
        priority: 1,
      })

      const completed1 = await waitForTerminalStatus(runStore, run1.id, 5000)
      expect(completed1.status).toBe('completed')

      // Verify context was saved
      const run1Logs = await runStore.getLogs(run1.id)
      const saveLog = run1Logs.find(
        (l) =>
          l.phase === 'context-transfer' &&
          l.message.includes('Saved context'),
      )
      expect(saveLog).toBeDefined()

      // Verify the context is persisted in the store
      const savedContexts = await contextTransfer.listContexts(
        'session-ctx-transfer',
      )
      expect(savedContexts.length).toBe(1)
      expect(savedContexts[0]!.fromIntent).toBe('generate_feature')
      expect(savedContexts[0]!.decisions).toEqual([
        'decision-A',
        'decision-B',
      ])

      // --- Run 2: edit_feature (should load context from generate_feature) ---
      const run2 = await runStore.create({
        agentId: 'codegen-agent',
        input: { message: 'Edit the auth feature' },
        metadata: {
          sessionId: 'session-ctx-transfer',
          intent: 'edit_feature',
        },
      })

      await runQueue.enqueue({
        runId: run2.id,
        agentId: 'codegen-agent',
        input: { message: 'Edit the auth feature' },
        metadata: {
          sessionId: 'session-ctx-transfer',
          intent: 'edit_feature',
        },
        priority: 1,
      })

      const completed2 = await waitForTerminalStatus(runStore, run2.id, 5000)
      expect(completed2.status).toBe('completed')

      // Verify that prior context was loaded
      const run2Logs = await runStore.getLogs(run2.id)
      const loadLog = run2Logs.find(
        (l) =>
          l.phase === 'context-transfer' &&
          l.message.includes('Loaded prior context'),
      )
      expect(loadLog).toBeDefined()
      expect(
        (loadLog!.data as Record<string, unknown>)['fromIntent'],
      ).toBe('generate_feature')
    })

    it('does not load context when there is no matching prior intent', async () => {
      const baseStore = new InMemoryStore()
      const contextTransfer = new RunContextTransfer({ store: baseStore })
      const executor = createEchoExecutor()

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: executor,
        contextTransfer,
      })

      // Run with 'configure' intent but no prior context exists
      const run = await runStore.create({
        agentId: 'chat-agent',
        input: { message: 'Configure settings' },
        metadata: {
          sessionId: 'session-no-prior',
          intent: 'configure',
        },
      })

      await runQueue.enqueue({
        runId: run.id,
        agentId: 'chat-agent',
        input: { message: 'Configure settings' },
        metadata: {
          sessionId: 'session-no-prior',
          intent: 'configure',
        },
        priority: 1,
      })

      const completed = await waitForTerminalStatus(runStore, run.id)
      expect(completed.status).toBe('completed')

      // Should NOT have a context-transfer load log
      const logs = await runStore.getLogs(run.id)
      const loadLog = logs.find(
        (l) =>
          l.phase === 'context-transfer' &&
          l.message.includes('Loaded prior context'),
      )
      expect(loadLog).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 3: Trace propagation
  // -------------------------------------------------------------------------
  describe('trace propagation: traceId flows through the pipeline', () => {
    it('injects trace context into run metadata via injectTraceContext', () => {
      const metadata: Record<string, unknown> = { sessionId: 'abc' }
      const injected = injectTraceContext(metadata)

      // _trace should be present
      expect(injected['_trace']).toBeDefined()
      const trace = extractTraceContext(injected)
      expect(trace).not.toBeNull()
      expect(trace!.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(trace!.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(trace!.traceFlags).toBe(1)

      // Original metadata preserved
      expect(injected['sessionId']).toBe('abc')
    })

    it('preserves existing trace context (idempotent injection)', () => {
      const metadata = injectTraceContext({ key: 'val' })
      const trace1 = extractTraceContext(metadata)

      // Inject again — should keep same traceId
      const reinjected = injectTraceContext(metadata)
      const trace2 = extractTraceContext(reinjected)

      expect(trace1!.traceId).toBe(trace2!.traceId)
    })

    it('trace context is present on run metadata after API creation and persists through execution', async () => {
      const executor: RunExecutor = async ({ metadata }) => {
        // Verify trace context is available inside the executor
        const trace = extractTraceContext(
          metadata as Record<string, unknown>,
        )
        return {
          output: {
            message: 'traced',
            traceId: trace?.traceId ?? 'missing',
          },
          tokenUsage: { input: 10, output: 5 },
          costCents: 0.01,
        } satisfies RunExecutorResult
      }

      // Manually inject trace on metadata before creating run
      // (In production, the route or middleware does this)
      const tracedMetadata = injectTraceContext({
        sessionId: 'trace-session',
      })
      const traceCtx = extractTraceContext(tracedMetadata)
      expect(traceCtx).not.toBeNull()

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: executor,
      })

      const run = await runStore.create({
        agentId: 'chat-agent',
        input: 'traced input',
        metadata: tracedMetadata,
      })

      await runQueue.enqueue({
        runId: run.id,
        agentId: 'chat-agent',
        input: 'traced input',
        metadata: tracedMetadata,
        priority: 1,
      })

      const completed = await waitForTerminalStatus(runStore, run.id)
      expect(completed.status).toBe('completed')

      // The trace context should survive through to the executor
      const output = completed.output as {
        message: string
        traceId: string
      }
      expect(output.traceId).toBe(traceCtx!.traceId)

      // Run metadata should still have _trace
      const finalRun = await runStore.get(run.id)
      const finalTrace = extractTraceContext(
        finalRun!.metadata as Record<string, unknown>,
      )
      expect(finalTrace).not.toBeNull()
      expect(finalTrace!.traceId).toBe(traceCtx!.traceId)
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 4: Simple message routes to chat tier
  // -------------------------------------------------------------------------
  describe('simple message routes to chat tier', () => {
    it('classifies "Hello" as simple and assigns chat model tier', async () => {
      const router = createTestRouter()
      const executor = createEchoExecutor()

      const config: ForgeServerConfig = {
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runQueue,
        runExecutor: executor,
        router,
      }
      const app = createForgeApp(config)

      const res = await req(app, 'POST', '/api/runs', {
        agentId: 'chat-agent',
        input: 'Hello',
      })

      expect(res.status).toBe(202)
      const body = (await res.json()) as {
        data: { id: string; metadata: Record<string, unknown> }
      }

      const run = await runStore.get(body.data.id)
      expect(run).not.toBeNull()
      expect(run!.metadata?.['modelTier']).toBe('chat')
      expect(run!.metadata?.['routingReason']).toBe('simple_turn')
      expect(run!.metadata?.['complexity']).toBe('simple')

      // Verify the run completes
      const completed = await waitForTerminalStatus(runStore, run!.id)
      expect(completed.status).toBe('completed')
    })

    it('classifies a moderate code-related message as codegen tier', async () => {
      const router = createTestRouter()
      const executor = createEchoExecutor()

      const config: ForgeServerConfig = {
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runQueue,
        runExecutor: executor,
        router,
      }
      const app = createForgeApp(config)

      // This message has code keywords but does not match forceExpensive intents
      // because it matches 'edit_feature' via keyword matcher
      const res = await req(app, 'POST', '/api/runs', {
        agentId: 'chat-agent',
        input: 'Edit the database schema and migration files to add a new column',
      })

      expect(res.status).toBe(202)
      const body = (await res.json()) as {
        data: { id: string; metadata: Record<string, unknown> }
      }

      const run = await runStore.get(body.data.id)
      expect(run).not.toBeNull()
      // 'edit_feature' is not in forceExpensiveIntents, so complexity scoring applies
      // The message is > 200 chars or has keywords -> moderate -> codegen
      expect(run!.metadata?.['modelTier']).toBeDefined()
      // Should not be 'chat' since the message contains complexity keywords
      const tier = run!.metadata?.['modelTier'] as string
      expect(['codegen', 'reasoning']).toContain(tier)
    })

    it('routes without a router configured — no routing metadata added', async () => {
      const executor = createEchoExecutor()

      // No router configured
      const config: ForgeServerConfig = {
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runQueue,
        runExecutor: executor,
      }
      const app = createForgeApp(config)

      const res = await req(app, 'POST', '/api/runs', {
        agentId: 'chat-agent',
        input: 'Hello without router',
      })

      expect(res.status).toBe(202)
      const body = (await res.json()) as {
        data: { id: string; metadata: Record<string, unknown> }
      }

      const run = await runStore.get(body.data.id)
      expect(run).not.toBeNull()
      // No router means no modelTier, routingReason, or complexity in metadata
      expect(run!.metadata?.['modelTier']).toBeUndefined()
      expect(run!.metadata?.['routingReason']).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 5: Run trace endpoint returns structured trace data
  // -------------------------------------------------------------------------
  describe('GET /api/runs/:id/trace returns full execution trace', () => {
    it('returns phases, events, and usage data after run completion', async () => {
      const executor = createEchoExecutor({
        logs: [
          { level: 'info', phase: 'tool_call', message: 'Tool called: search', data: { toolName: 'search' } },
        ],
      })

      const config: ForgeServerConfig = {
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runQueue,
        runExecutor: executor,
      }
      const app = createForgeApp(config)

      const createRes = await req(app, 'POST', '/api/runs', {
        agentId: 'chat-agent',
        input: 'trace test',
      })
      const created = (await createRes.json()) as {
        data: { id: string }
      }
      const runId = created.data.id

      // Wait for completion
      await waitForTerminalStatus(runStore, runId)

      // Fetch trace
      const traceRes = await app.request(`/api/runs/${runId}/trace`)
      expect(traceRes.status).toBe(200)

      const trace = (await traceRes.json()) as {
        data: {
          runId: string
          agentId: string
          status: string
          phases: string[]
          events: LogEntry[]
          toolCalls: Array<{ message: string }>
          usage: {
            tokenUsage: { input: number; output: number }
            costCents: number
          }
        }
      }

      expect(trace.data.runId).toBe(runId)
      expect(trace.data.agentId).toBe('chat-agent')
      expect(trace.data.status).toBe('completed')
      expect(trace.data.phases).toContain('queue')
      expect(trace.data.phases).toContain('run')
      expect(trace.data.usage.tokenUsage).toEqual({ input: 100, output: 50 })
      expect(trace.data.usage.costCents).toBe(0.5)
      expect(trace.data.events.length).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 6: Executor failure does not break the pipeline
  // -------------------------------------------------------------------------
  describe('error handling: executor failure sets run to failed', () => {
    it('marks the run as failed and records error details', async () => {
      const failingExecutor: RunExecutor = async () => {
        throw new Error('LLM provider unavailable')
      }

      startRunWorker({
        runQueue,
        runStore,
        agentStore,
        eventBus,
        modelRegistry,
        runExecutor: failingExecutor,
      })

      const seenEvents: string[] = []
      eventBus.onAny((event) => {
        if ('runId' in event) seenEvents.push(event.type)
      })

      const run = await runStore.create({
        agentId: 'chat-agent',
        input: 'this will fail',
      })

      await runQueue.enqueue({
        runId: run.id,
        agentId: 'chat-agent',
        input: 'this will fail',
        priority: 1,
      })

      const failed = await waitForTerminalStatus(runStore, run.id)
      expect(failed.status).toBe('failed')
      expect(failed.error).toContain('LLM provider unavailable')

      // Error event should have been emitted
      expect(seenEvents).toContain('agent:failed')

      // Error log should exist
      const logs = await runStore.getLogs(run.id)
      const errorLog = logs.find(
        (l) => l.level === 'error' && l.phase === 'run',
      )
      expect(errorLog).toBeDefined()
      expect(errorLog!.message).toContain('Run failed')
    })
  })
})
