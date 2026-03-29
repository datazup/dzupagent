import type { Request, Response } from 'express'
import type { AgentStreamEvent } from '@dzipagent/agent'
import type { SSEEvent, SSEHandlerConfig, AgentResult } from './types.js'

/**
 * Default SSE event formatter.
 *
 * Matches the research-app pattern: `data: ${JSON.stringify(payload)}\n\n`
 * When an event has an `id`, it is included as a separate SSE field.
 */
function defaultFormatEvent(event: SSEEvent): string {
  const lines: string[] = []
  if (event.id) {
    lines.push(`id: ${event.id}`)
  }
  lines.push(`event: ${event.type}`)
  lines.push(`data: ${JSON.stringify(event.data)}`)
  lines.push('')
  lines.push('')
  return lines.join('\n')
}

/**
 * Low-level SSE writer that sends events to an Express response.
 *
 * Handles keep-alive pings, client disconnect detection, and
 * graceful stream termination.
 */
export class SSEWriter {
  private readonly res: Response
  private readonly config: SSEHandlerConfig
  private readonly formatEvent: (event: SSEEvent) => string
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(res: Response, config?: SSEHandlerConfig) {
    this.res = res
    this.config = config ?? {}
    this.formatEvent = config?.formatEvent ?? defaultFormatEvent
  }

  /** Start the keep-alive timer. */
  startKeepAlive(): void {
    const interval = this.config.keepAliveMs ?? 15_000
    this.keepAliveTimer = setInterval(() => {
      if (!this.closed) {
        this.res.write(': keepalive\n\n')
      }
    }, interval)
  }

  /** Stop the keep-alive timer. */
  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  /** Write an arbitrary SSE event. */
  write(event: SSEEvent): void {
    if (this.closed) return
    this.res.write(this.formatEvent(event))
  }

  /** Write a text chunk event (type: 'chunk'). */
  writeChunk(text: string): void {
    this.write({ type: 'chunk', data: { content: text } })
  }

  /** Write a completion event (type: 'done'). */
  writeDone(result: AgentResult): void {
    this.write({
      type: 'done',
      data: {
        content: result.content,
        usage: result.usage,
        cost: result.cost,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
      },
    })
  }

  /** Write an error event (type: 'error'). */
  writeError(error: Error): void {
    this.write({ type: 'error', data: { message: error.message } })
  }

  /** End the SSE stream and clean up resources. */
  end(): void {
    if (this.closed) return
    this.closed = true
    this.stopKeepAlive()
    this.res.end()
  }

  /** Check whether the client is still connected. */
  isConnected(): boolean {
    return !this.closed && !this.res.writableEnded
  }
}

/**
 * High-level SSE handler that bridges DzipAgent streaming to Express responses.
 *
 * Sets appropriate SSE headers, manages keep-alive, maps AgentStreamEvent
 * types to SSE events, and handles client disconnects gracefully.
 */
export class SSEHandler {
  private readonly config: SSEHandlerConfig

  constructor(config?: SSEHandlerConfig) {
    this.config = config ?? {}
  }

  /**
   * Set up SSE headers on the response and return a writer.
   *
   * The caller can use the writer to send events manually, or
   * pass the writer's response to `streamAgent` for automatic bridging.
   */
  initStream(res: Response): SSEWriter {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(this.config.headers ?? {}),
    }

    res.writeHead(200, headers)

    const writer = new SSEWriter(res, this.config)
    writer.startKeepAlive()
    return writer
  }

  /**
   * Stream a DzipAgent's output to an Express SSE response.
   *
   * Consumes the agent's AsyncGenerator, maps each AgentStreamEvent to
   * an SSE event, tracks accumulated content and tool calls, and returns
   * the final AgentResult.
   *
   * Handles client disconnects by stopping iteration and calling the
   * `onDisconnect` hook if configured.
   */
  async streamAgent(
    agentStream: AsyncGenerator<AgentStreamEvent>,
    res: Response,
    req: Request,
  ): Promise<AgentResult> {
    const writer = this.initStream(res)
    const startTime = Date.now()

    let content = ''
    let toolCallCount = 0
    let usage: AgentResult['usage'] | undefined
    let cost: number | undefined
    let clientDisconnected = false

    // Listen for client disconnect
    const onClose = (): void => {
      clientDisconnected = true
      this.config.onDisconnect?.(req)
    }
    req.on('close', onClose)

    try {
      for await (const event of agentStream) {
        if (clientDisconnected || !writer.isConnected()) {
          // Try to signal the agent to stop via the generator's return
          await agentStream.return(undefined as never)
          break
        }

        switch (event.type) {
          case 'text': {
            const text = (event.data as { content?: string }).content ?? ''
            content += text
            writer.writeChunk(text)
            break
          }
          case 'tool_call': {
            toolCallCount++
            writer.write({
              type: 'tool_call',
              data: {
                name: (event.data as { name?: string }).name,
                args: (event.data as { args?: unknown }).args,
              },
            })
            break
          }
          case 'tool_result': {
            writer.write({
              type: 'tool_result',
              data: {
                name: (event.data as { name?: string }).name,
                result: (event.data as { result?: unknown }).result,
              },
            })
            break
          }
          case 'done': {
            const doneData = event.data as {
              content?: string
              stopReason?: string
              hitIterationLimit?: boolean
            }
            // Use done content if we haven't accumulated any
            if (!content && doneData.content) {
              content = doneData.content
            }
            break
          }
          case 'error': {
            const errorMsg = (event.data as { message?: string }).message ?? 'Unknown error'
            writer.writeError(new Error(errorMsg))
            break
          }
          case 'budget_warning': {
            writer.write({
              type: 'budget_warning',
              data: { message: (event.data as { message?: string }).message },
            })
            break
          }
          case 'stuck': {
            writer.write({
              type: 'stuck',
              data: event.data,
            })
            break
          }
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))

      if (writer.isConnected()) {
        writer.writeError(error)
      }

      this.config.onError?.(error, req, res)

      const result: AgentResult = {
        content,
        usage,
        cost,
        toolCalls: toolCallCount,
        durationMs: Date.now() - startTime,
      }

      writer.end()
      req.removeListener('close', onClose)
      return result
    }

    const result: AgentResult = {
      content,
      usage,
      cost,
      toolCalls: toolCallCount,
      durationMs: Date.now() - startTime,
    }

    // Send done event and close
    if (writer.isConnected()) {
      writer.writeDone(result)
    }

    writer.end()
    req.removeListener('close', onClose)

    // Fire completion hook
    if (!clientDisconnected) {
      await this.config.onComplete?.(result, req)
    }

    return result
  }
}
