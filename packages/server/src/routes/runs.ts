/**
 * Run management routes.
 *
 * POST /api/runs                — Trigger a new run
 * GET  /api/runs                — List runs (filter by agent, status)
 * GET  /api/runs/:id            — Get run details
 * POST /api/runs/:id/cancel     — Cancel a running execution
 * POST /api/runs/:id/pause      — Cooperatively pause a running execution
 * POST /api/runs/:id/resume     — Resume a paused/suspended execution
 * POST /api/runs/:id/fork       — Fork a run from a checkpoint step
 * GET  /api/runs/:id/checkpoints — List available checkpoints for a run
 * GET  /api/runs/:id/logs       — Get run logs
 * GET  /api/runs/:id/trace      — Execution trace with events + usage summary
 * GET  /api/runs/:id/stream     — SSE stream of run events
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ForgeServerConfig } from '../app.js'
import type { RunStatus, LogEntry } from '@dzupagent/core'
import { injectTraceContext } from '@dzupagent/core'
import {
  ConcreteRunHandle,
  ForkLimitExceededError,
  CheckpointExpiredError,
  StreamingRunHandle,
} from '@dzupagent/agent'
import { streamRunHandleToSSE } from '../streaming/sse-streaming-adapter.js'

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

  // POST /api/runs/:id/pause — Cooperatively pause a run
  app.post('/:id/pause', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
    if (run.status !== 'running' && run.status !== 'executing') {
      return c.json({
        error: { code: 'INVALID_STATE', message: `Cannot pause run in '${run.status}' state` },
      }, 400)
    }

    await runStore.update(run.id, { status: 'paused' })
    eventBus.emit({ type: 'run:paused', runId: run.id, agentId: run.agentId })

    return c.json({ data: { runId: run.id, status: 'paused' as const } })
  })

  // POST /api/runs/:id/resume — Resume a paused or suspended run
  app.post('/:id/resume', async (c) => {
    const run = await runStore.get(c.req.param('id'))
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }
    if (run.status !== 'paused' && run.status !== 'suspended') {
      return c.json({
        error: { code: 'INVALID_STATE', message: `Cannot resume run in '${run.status}' state` },
      }, 400)
    }

    // Accept optional resumeToken and input from request body
    let resumeToken: string | undefined
    let input: unknown
    try {
      const body = await c.req.json<{ resumeToken?: string; input?: unknown }>()
      resumeToken = body.resumeToken
      input = body.input
    } catch {
      // Empty body is acceptable for resume
    }

    await runStore.update(run.id, { status: 'running' })
    eventBus.emit({
      type: 'run:resumed',
      runId: run.id,
      agentId: run.agentId,
      ...(resumeToken !== undefined ? { resumeToken } : {}),
      ...(input !== undefined ? { input } : {}),
    })

    return c.json({ data: { runId: run.id, status: 'running' as const } })
  })

  // POST /api/runs/:id/fork — Fork a run from a checkpoint step
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id')

    if (!config.journal) {
      return c.json({
        error: { code: 'NOT_CONFIGURED', message: 'Journal is not configured; fork is unavailable' },
      }, 501)
    }

    const run = await runStore.get(id)
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    let targetStepId: string | undefined
    try {
      const body = await c.req.json<{ targetStepId?: string }>()
      targetStepId = body.targetStepId
    } catch {
      // Empty body is acceptable — fork from latest checkpoint
    }

    try {
      const handle = await ConcreteRunHandle.fromRunId(id, config.journal)
      const forked = await handle.fork(targetStepId!)
      return c.json({
        data: {
          originalRunId: id,
          forkedRunId: forked.runId,
          targetStepId: targetStepId ?? null,
        },
      }, 201)
    } catch (err) {
      if (err instanceof ForkLimitExceededError) {
        return c.json({ error: { code: 'FORK_LIMIT_EXCEEDED', message: (err as Error).message } }, 409)
      }
      if (err instanceof CheckpointExpiredError) {
        return c.json({ error: { code: 'CHECKPOINT_EXPIRED', message: (err as Error).message } }, 409)
      }
      throw err
    }
  })

  // GET /api/runs/:id/checkpoints — List available checkpoints for a run
  app.get('/:id/checkpoints', async (c) => {
    const id = c.req.param('id')

    if (!config.journal) {
      return c.json({
        error: { code: 'NOT_CONFIGURED', message: 'Journal is not configured; checkpoints are unavailable' },
      }, 501)
    }

    const run = await runStore.get(id)
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    try {
      const handle = await ConcreteRunHandle.fromRunId(id, config.journal)
      const checkpoints = await handle.getCheckpoints()
      return c.json({ data: { runId: id, checkpoints } })
    } catch {
      // fromRunId may throw if journal has no entries — treat as empty checkpoints
      return c.json({ data: { runId: id, checkpoints: [] } })
    }
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
      .filter((l: LogEntry) => l.phase === 'tool_call' || (l.data != null && typeof l.data === 'object' && 'toolName' in (l.data as Record<string, unknown>)))
      .map((l: LogEntry) => ({
        message: l.message,
        data: l.data,
        timestamp: l.timestamp,
      }))

    const phases = logs
      .filter((l: LogEntry) => l.phase != null)
      .map((l: LogEntry) => l.phase!)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)

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
  //
  // Uses StreamingRunHandle as the bridge between DzupEventBus events
  // and Hono SSE transport. Bus events for this run are mapped to
  // StreamEvent objects and pushed into the handle; the adapter pipes
  // them to the SSE response. On client disconnect the handle is
  // cancelled, which stops the bus subscription.
  app.get('/:id/stream', async (c) => {
    const runId = c.req.param('id')
    const run = await runStore.get(runId)
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    return streamSSE(c, async (stream) => {
      const handle = new StreamingRunHandle({ maxBufferSize: 100 })

      // Subscribe to bus events for this run and push into the handle
      const unsub = eventBus.onAny((event) => {
        if (handle.status !== 'running') return

        const eventRunId = 'runId' in event ? (event as { runId: string }).runId : undefined
        if (eventRunId !== runId) return

        // Map bus event types to StreamEvent types
        switch (event.type) {
          case 'agent:stream_delta': {
            handle.push({ type: 'text_delta', content: event.content })
            break
          }
          case 'tool:called': {
            const toolEvent = event as { toolName: string; callId?: string }
            handle.push({
              type: 'tool_call_start',
              toolName: toolEvent.toolName,
              callId: toolEvent.callId ?? '',
            })
            break
          }
          case 'tool:result': {
            const resultEvent = event as { callId?: string; result?: unknown }
            handle.push({
              type: 'tool_call_end',
              callId: resultEvent.callId ?? '',
              result: resultEvent.result,
            })
            break
          }
          case 'agent:stream_done': {
            handle.push({
              type: 'done',
              finalOutput: event.finalContent,
            })
            handle.complete()
            break
          }
          case 'agent:completed': {
            const completedEvent = event as { output?: string }
            handle.push({
              type: 'done',
              finalOutput: typeof completedEvent.output === 'string' ? completedEvent.output : '',
            })
            handle.complete()
            break
          }
          case 'agent:failed': {
            handle.fail(new Error(event.message ?? event.errorCode ?? 'Run failed'))
            break
          }
          default:
            // Other run events (paused, resumed, cancelled) do not map
            // to StreamEvent types — they are handled by the polling check.
            break
        }
      })

      // Send initial state before piping the handle
      await stream.writeSSE({ data: JSON.stringify({ status: run.status }), event: 'init' })

      // Poll for completion of runs that may have finished before we subscribed
      const checkInterval = setInterval(() => { void (async () => {
        if (handle.status !== 'running') { clearInterval(checkInterval); return }
        const current = await runStore.get(runId)
        if (!current || ['completed', 'failed', 'cancelled', 'rejected'].includes(current.status)) {
          if (handle.status === 'running') {
            handle.push({ type: 'done', finalOutput: '' })
            handle.complete()
          }
          clearInterval(checkInterval)
        }
      })() }, 2000)

      // Pipe handle events to SSE; adapter handles onAbort → handle.cancel()
      await streamRunHandleToSSE(handle, stream, {
        keepAliveIntervalMs: Number(process.env['SSE_KEEPALIVE_INTERVAL_MS'] ?? 30_000),
        runTimeoutMs: Number(process.env['RUN_TIMEOUT_MS'] ?? 0),
        onError: (e) => {
          console.error('SSE write error', e)
          clearInterval(checkInterval)
          unsub()
        },
      })

      // Cleanup when the stream ends (normal completion or abort)
      clearInterval(checkInterval)
      unsub()
    })
  })

  return app
}
