/**
 * GET /api/runs/:id/stream — SSE event stream.
 *
 * Uses StreamingRunHandle as the bridge between DzupEventBus events and Hono
 * SSE transport. Bus events for this run are mapped to StreamEvent objects
 * and pushed into the handle; the adapter pipes them to the SSE response. On
 * client disconnect the handle is cancelled, which stops the bus subscription.
 *
 * Extracted from `routes/runs.ts` (RF-22).
 */
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { StreamingRunHandle } from '@dzupagent/agent'

import { secureLogger } from '@dzupagent/core'

import type { ForgeServerConfig } from '../../composition/types.js'
import { streamRunHandleToSSE } from '../../streaming/sse-streaming-adapter.js'
import { loadOwnedRun } from './shared.js'

export async function handleStreamRun(
  c: Context,
  config: ForgeServerConfig,
): Promise<Response> {
  const { runStore, eventBus } = config
  const runId = c.req.param('id') ?? ''
  const run = await loadOwnedRun(c, config)
  if (run instanceof Response) return run

  return streamSSE(c, async (stream) => {
    const handle = new StreamingRunHandle({ maxBufferSize: 100 })

    // Emit a `run:memory-frame` SSE event directly if the current run has a
    // memoryFrame snapshot stored on its metadata. Written directly to the
    // SSE stream (bypassing StreamingRunHandle) so we can extend the event
    // vocabulary without widening the closed StreamEvent union. Must be
    // awaited BEFORE the `done` event is pushed so the memory frame arrives
    // on the wire first.
    const maybeEmitMemoryFrame = async (): Promise<void> => {
      try {
        const latest = await runStore.get(runId)
        const memoryFrame = latest?.metadata != null
          && typeof latest.metadata === 'object'
          ? (latest.metadata as Record<string, unknown>)['memoryFrame']
          : undefined
        if (memoryFrame === undefined) return
        await stream.writeSSE({
          event: 'run:memory-frame',
          data: JSON.stringify({ runId, memoryFrame }),
        })
      } catch {
        // Non-fatal — memory frame emission is best-effort observability
      }
    }

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
          const finalOutput = event.finalContent
          void (async () => {
            await maybeEmitMemoryFrame()
            if (handle.status !== 'running') return
            handle.push({ type: 'done', finalOutput })
            handle.complete()
          })()
          break
        }
        case 'agent:completed': {
          const completedEvent = event as { output?: string }
          const finalOutput = typeof completedEvent.output === 'string' ? completedEvent.output : ''
          void (async () => {
            await maybeEmitMemoryFrame()
            if (handle.status !== 'running') return
            handle.push({ type: 'done', finalOutput })
            handle.complete()
          })()
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
      if (!current || ['completed', 'failed', 'cancelled', 'rejected', 'halted'].includes(current.status)) {
        if (handle.status === 'running') {
          await maybeEmitMemoryFrame()
          if (handle.status === 'running') {
            handle.push({ type: 'done', finalOutput: '' })
            handle.complete()
          }
        }
        clearInterval(checkInterval)
      }
    })() }, 2000)

    // Pipe handle events to SSE; adapter handles onAbort → handle.cancel()
    await streamRunHandleToSSE(handle, stream, {
      keepAliveIntervalMs: Number(process.env['SSE_KEEPALIVE_INTERVAL_MS'] ?? 30_000),
      runTimeoutMs: Number(process.env['RUN_TIMEOUT_MS'] ?? 0),
      onError: (e) => {
        secureLogger.error({ event: 'sse_write_error', error: e instanceof Error ? e.message : String(e) })
        clearInterval(checkInterval)
        unsub()
      },
    })

    // Cleanup when the stream ends (normal completion or abort)
    clearInterval(checkInterval)
    unsub()
  })
}
