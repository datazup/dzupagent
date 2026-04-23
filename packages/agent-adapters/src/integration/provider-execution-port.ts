/**
 * RegistryExecutionPort — implements the `ProviderExecutionPort` interface
 * from `@dzupagent/agent` using `ProviderAdapterRegistry.executeWithFallback()`.
 *
 * This bridges the dependency-inverted port with the concrete adapter
 * runtime, keeping `@dzupagent/agent` free of adapter implementation details.
 */

import { ForgeError } from '@dzupagent/core'
import type {
  ProviderExecutionPort,
  ProviderExecutionResult,
} from '@dzupagent/agent'
import type {
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  AdapterProviderId,
} from '@dzupagent/adapter-types'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'

export class RegistryExecutionPort implements ProviderExecutionPort {
  constructor(
    private readonly registry: ProviderAdapterRegistry,
    private readonly bridge?: EventBusBridge,
  ) {}

  async *stream(
    input: AgentInput,
    task: TaskDescriptor,
    options?: { runId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const source = this.registry.executeWithFallback(input, task)
    const eventStream = this.bridge
      ? this.bridge.bridge(source, options?.runId)
      : source

    for await (const event of eventStream) {
      if (options?.signal?.aborted) {
        throw new ForgeError({
          code: 'AGENT_ABORTED',
          message: 'Execution aborted via signal',
          recoverable: false,
        })
      }
      yield event
    }
  }

  async run(
    input: AgentInput,
    task: TaskDescriptor,
    options?: { runId?: string; signal?: AbortSignal },
  ): Promise<ProviderExecutionResult> {
    let content = ''
    let providerId: AdapterProviderId | null = null
    const attempted = new Set<AdapterProviderId>()

    for await (const event of this.stream(input, task, options)) {
      // Track all providers that emit events
      if ('providerId' in event && typeof event.providerId === 'string') {
        attempted.add(event.providerId as AdapterProviderId)
      }

      if (event.type === 'adapter:completed') {
        content = event.result
        providerId = event.providerId
      }
    }

    if (!providerId) {
      throw new ForgeError({
        code: 'ALL_ADAPTERS_EXHAUSTED',
        message: 'No adapter completed the task successfully',
        recoverable: false,
        context: { attemptedProviders: [...attempted] },
      })
    }

    const attemptedProviders = [...attempted]
    return {
      content,
      providerId,
      attemptedProviders,
      fallbackAttempts: Math.max(0, attemptedProviders.length - 1),
    }
  }
}
