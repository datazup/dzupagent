/**
 * Run management routes.
 *
 * POST /api/runs           — Trigger a new run
 * GET  /api/runs           — List runs (filter by agent, status)
 * GET  /api/runs/:id       — Get run details
 * POST /api/runs/:id/cancel — Cancel a running execution
 * GET  /api/runs/:id/logs  — Get run logs
 * GET  /api/runs/:id/stream — SSE stream of run events
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ForgeServerConfig } from '../app.js'
import type { RunStatus } from '@dzipagent/core'
import { injectTraceContext } from '@dzipagent/core'

export function createRunRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const { runStore, eventBus } = config

  // POST /api/runs — Trigger a new run
  app.post('/', async (c) => {
    const body = await c.req.json<{ agentId: string; input: unknown; metadata?: Record<string, unknown> }>()

    if (!body.agentId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'agentId is required' } }, 400)
    }

    const agent = await config.agentStore.get(body.agentId)
    if (!agent) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404)
    }

    // --- Cost-aware routing: classify input to determine optimal model tier ---
    let routingMetadata: Record<string, unknown> = {}
    if (config.router) {
      const inputObj = body.input as Record<string, unknown> | null | undefined
      const text = typeof body.input === 'string'
        ? body.input
        : (inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj))
          ? (typeof inputObj['message'] === 'string' ? inputObj['message']
            : typeof inputObj['content'] === 'string' ? inputObj['content']
            : typeof inputObj['prompt'] === 'string' ? inputObj['prompt']
            : JSON.stringify(body.input))
          : JSON.stringify(body.input ?? '')

      try {
        const result = await config.router.classify(text)
        routingMetadata = {
          modelTier: result.modelTier,
          routingReason: result.routingReason,
          complexity: result.complexity,
        }

        // Track routing decision distribution
        config.metrics?.increment('forge_routing_total', {
          tier: result.modelTier,
          reason: result.routingReason,
          complexity: result.complexity,
        })
      } catch {
        // Router failure is non-fatal — fall through without routing metadata
      }
    }

    const mergedMetadata = { ...(body.metadata ?? {}), ...routingMetadata }

    // Inject trace context so every run has a traceId from birth.
    // injectTraceContext is idempotent — if metadata already has _trace, it's preserved.
    let tracedMetadata: Record<string, unknown>
    try {
      tracedMetadata = injectTraceContext(mergedMetadata)
    } catch {
      // Trace injection is non-fatal — proceed without it
      tracedMetadata = mergedMetadata
    }

    const run = await runStore.create({
      agentId: body.agentId,
      input: body.input,
      metadata: tracedMetadata,
    })

    if (config.runQueue) {
      if (!config.runExecutor) {
        return c.json({
          error: {
            code: 'RUN_EXECUTOR_NOT_CONFIGURED',
            message: 'runQueue is configured but no runExecutor is available',
          },
        }, 503)
      }

      const metadata = body.metadata ?? {}
      const priorityRaw = typeof metadata['priority'] === 'number' ? metadata['priority'] : 5
      const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.floor(priorityRaw)) : 5

      const job = await config.runQueue.enqueue({
        runId: run.id,
        agentId: run.agentId,
        input: run.input,
        metadata: run.metadata,
        priority,
      })

      await runStore.addLog(run.id, {
        level: 'info',
        phase: 'queue',
        message: 'Run enqueued',
        data: { jobId: job.id, priority },
      })

      return c.json({ data: run, queue: { accepted: true, jobId: job.id, priority } }, 202)
    }

    eventBus.emit({ type: 'agent:started', agentId: run.agentId, runId: run.id })

    return c.json({ data: run }, 201)
  })

  // GET /api/runs — List runs
  app.get('/', async (c) => {
    const agentId = c.req.query('agentId')
    const status = c.req.query('status') as RunStatus | undefined
    const limit = parseInt(c.req.query('limit') ?? '50', 10)
    const offset = parseInt(c.req.query('offset') ?? '0', 10)

    const runs = await runStore.list({
      agentId: agentId ?? undefined,
      status: status ?? undefined,
      limit: Math.min(limit, 100),
      offset,
    })

    return c.json({ data: runs, count: runs.length })
  })

  // GET /api/runs/:id — Get single run
  app.get('/:id', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
    return c.json({ data: run })
  })

  // POST /api/runs/:id/cancel — Cancel a run
  app.post('/:id/cancel', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return c.json({ error: { code: 'INVALID_STATE', message: `Cannot cancel run in ${run.status} state` } }, 400)
    }

    // Signal the queue to abort the job (removes from pending or aborts active signal)
    config.runQueue?.cancel(run.id)

    await runStore.update(run.id, { status: 'cancelled', completedAt: new Date() })
    eventBus.emit({ type: 'agent:failed', agentId: run.agentId, runId: run.id, errorCode: 'AGENT_ABORTED', message: 'Cancelled by user' })

    return c.json({ data: { ...run, status: 'cancelled' } })
  })

  // GET /api/runs/:id/logs — Get run logs
  app.get('/:id/logs', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    const logs = await runStore.getLogs(run.id)
    return c.json({ data: logs })
  })

  // GET /api/runs/:id/trace — Execution trace with events + usage summary
  app.get('/:id/trace', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    const logs = await runStore.getLogs(run.id)

    // Build usage summary
    const usage = {
      tokenUsage: run.tokenUsage ?? { input: 0, output: 0 },
      costCents: run.costCents ?? 0,
      durationMs: run.completedAt && run.startedAt
        ? run.completedAt.getTime() - run.startedAt.getTime()
        : undefined,
    }

    // Extract tool calls and phases from logs
    const toolCalls = logs
      .filter((l) => l.phase === 'tool_call' || l.data && typeof l.data === 'object' && 'toolName' in (l.data as Record<string, unknown>))
      .map((l) => ({
        message: l.message,
        data: l.data,
        timestamp: l.timestamp,
      }))

    const phases = logs
      .filter((l) => l.phase != null)
      .map((l) => l.phase!)
      .filter((v, i, a) => a.indexOf(v) === i)

    return c.json({
      data: {
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
        phases,
        events: logs,
        toolCalls,
        usage,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
    })
  })

  // GET /api/runs/:id/stream — SSE event stream
  app.get('/:id/stream', async (c) => {
    const runId = c.req.param('id')
    const run = await runStore.get(runId)
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    return streamSSE(c, async (stream) => {
      let closed = false

      // Subscribe to events for this run
      const unsub = eventBus.onAny((event) => {
        if (closed) return
        // Only forward events that have a runId matching this run
        const eventRunId = 'runId' in event ? (event as { runId: string }).runId : undefined
        if (eventRunId === runId) {
          stream.writeSSE({ data: JSON.stringify(event), event: event.type }).catch(() => {
            closed = true
          })
        }
      })

      // Send initial state
      await stream.writeSSE({ data: JSON.stringify({ status: run.status }), event: 'init' })

      // Keep alive until client disconnects or run completes
      const checkInterval = setInterval(async () => {
        if (closed) { clearInterval(checkInterval); unsub(); return }
        const current = await runStore.get(runId)
        if (!current || ['completed', 'failed', 'cancelled', 'rejected'].includes(current.status)) {
          await stream.writeSSE({ data: JSON.stringify({ status: current?.status ?? 'unknown' }), event: 'done' })
          closed = true
          clearInterval(checkInterval)
          unsub()
        }
      }, 2000)

      // Wait for stream to close
      stream.onAbort(() => {
        closed = true
        clearInterval(checkInterval)
        unsub()
      })

      // Keep stream alive
      while (!closed) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })
  })

  return app
}
