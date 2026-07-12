import { randomUUID } from 'node:crypto'
import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  ControlledExecutionCompletion,
  ControlledExecutionHandle,
} from '../types.js'
import type { ProviderExecutionBackend } from '@dzupagent/runtime-contracts'

interface ControlledHandleOptions {
  readonly providerId: AdapterProviderId
  readonly backend: ProviderExecutionBackend
  readonly input: AgentInput
  readonly execute: (input: AgentInput) => AsyncIterable<AgentEvent>
}

/** Eagerly pumps one adapter execution so completion never depends on event consumption. */
export function createControlledExecutionHandle(options: ControlledHandleOptions): ControlledExecutionHandle {
  const executionId = options.input.correlationId ?? randomUUID()
  const controller = new AbortController()
  const queue = new AsyncEventQueue()
  let terminal: AgentEvent | undefined
  let cancelReason: string | undefined

  const external = options.input.signal
  const onExternalAbort = (): void => controller.abort(external?.reason)
  external?.addEventListener('abort', onExternalAbort, { once: true })
  if (external?.aborted) controller.abort(external.reason)

  const completion = (async (): Promise<ControlledExecutionCompletion> => {
    try {
      for await (const event of options.execute({ ...options.input, signal: controller.signal, correlationId: executionId })) {
        queue.push(event)
        if (event.type === 'adapter:completed' || event.type === 'adapter:failed') terminal = event
      }
      if (terminal?.type === 'adapter:completed') {
        return {
          executionId,
          status: 'succeeded',
          providerId: options.providerId,
          backend: options.backend,
          sessionId: terminal.sessionId,
          usage: terminal.usage,
          output: terminal.result,
        }
      }
      if (terminal?.type === 'adapter:failed') {
        const status = controller.signal.aborted
          ? 'cancelled'
          : terminal.code === 'ADAPTER_TIMEOUT' ? 'timed_out' : 'failed'
        return {
          executionId,
          status,
          providerId: options.providerId,
          backend: options.backend,
          sessionId: terminal.sessionId,
          error: { code: terminal.code ?? 'ADAPTER_EXECUTION_FAILED', message: terminal.error },
          ...(cancelReason ? { metadata: { cancelReason } } : {}),
        }
      }
      return {
        executionId,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        providerId: options.providerId,
        backend: options.backend,
        error: { code: controller.signal.aborted ? 'AGENT_ABORTED' : 'ADAPTER_EXECUTION_FAILED', message: controller.signal.aborted ? 'Execution cancelled' : 'Execution ended without a terminal event' },
      }
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown }
      const code = typeof candidate.code === 'string' ? candidate.code : 'ADAPTER_EXECUTION_FAILED'
      return {
        executionId,
        status: controller.signal.aborted || code === 'AGENT_ABORTED' ? 'cancelled' : code === 'ADAPTER_TIMEOUT' ? 'timed_out' : 'failed',
        providerId: options.providerId,
        backend: options.backend,
        error: { code, message: typeof candidate.message === 'string' ? candidate.message : String(error) },
      }
    } finally {
      external?.removeEventListener('abort', onExternalAbort)
      queue.close()
    }
  })()

  return {
    executionId,
    events: queue,
    completion,
    async cancel(reason?: string): Promise<void> {
      cancelReason = reason
      controller.abort(reason)
      await completion
    },
  }
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = []
  private waiters: Array<(result: IteratorResult<AgentEvent>) => void> = []
  private closed = false

  push(value: AgentEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}
