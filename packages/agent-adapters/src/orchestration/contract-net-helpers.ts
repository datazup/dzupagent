/**
 * Helpers for ContractNetOrchestrator.
 *
 * Extracted from `contract-net.ts` to keep the orchestrator class focused
 * on the bidding/award/execute control flow. These helpers handle:
 * - Adapter event-stream consumption and registry health bookkeeping
 * - Protocol-message emission on the DzupEventBus
 * - Cancelled-result construction and abort guards
 * - AgentEvent type guards
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import { ForgeError } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  TaskDescriptor,
} from '../types.js'

import type { Bid, ContractNetResult } from './contract-net-types.js'

// ---------------------------------------------------------------------------
// AgentEvent type guards
// ---------------------------------------------------------------------------

export function isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
  return event.type === 'adapter:completed'
}

export function isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
  return event.type === 'adapter:failed'
}

// ---------------------------------------------------------------------------
// Abort guards
// ---------------------------------------------------------------------------

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ForgeError({
      code: 'AGENT_ABORTED',
      message: 'Contract-Net execution was aborted',
      recoverable: false,
    })
  }
}

// ---------------------------------------------------------------------------
// Cancelled-result builder
// ---------------------------------------------------------------------------

export function buildCancelledResult(
  task: TaskDescriptor,
  allBids: Bid[],
  winningBid: Bid | null,
  overallStart: number,
  error: string,
): ContractNetResult {
  return {
    task,
    winningBid,
    allBids,
    executionResult: '',
    success: false,
    durationMs: Date.now() - overallStart,
    error,
    cancelled: true,
  }
}

// ---------------------------------------------------------------------------
// Adapter event-stream consumption
// ---------------------------------------------------------------------------

/**
 * Consume an adapter event stream until completion or failure.
 *
 * Updates the registry health (recordSuccess/recordFailure) based on
 * whether the stream emitted a terminal `adapter:completed` event. Throws
 * `AGENT_ABORTED` if `signal` is aborted mid-stream.
 */
export async function consumeAdapterEvents(
  gen: AsyncGenerator<AgentEvent, void, undefined>,
  providerId: AdapterProviderId,
  registry: ProviderAdapterRegistry,
  signal?: AbortSignal,
): Promise<{ success: boolean; text: string; error?: string }> {
  let resultText = ''
  let success = false
  let errorMessage: string | undefined

  for await (const event of gen) {
    throwIfAborted(signal)

    if (isCompletedEvent(event)) {
      resultText = event.result
      success = true
    } else if (isFailedEvent(event)) {
      errorMessage = event.error
    }
  }

  if (success) {
    registry.recordSuccess(providerId)
  } else {
    registry.recordFailure(
      providerId,
      new Error(errorMessage ?? 'Adapter stream ended without terminal adapter:completed event'),
    )
  }

  return {
    success,
    text: resultText,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  }
}

// ---------------------------------------------------------------------------
// Protocol-message emission
// ---------------------------------------------------------------------------

export function emitProtocol(
  eventBus: DzupEventBus | undefined,
  type: 'message_sent' | 'message_received',
  detail: {
    protocol: string
    to?: string | undefined
    from?: string | undefined
    messageType: string
  },
): void {
  if (!eventBus) return

  if (type === 'message_sent') {
    eventBus.emit({
      type: 'protocol:message_sent',
      protocol: detail.protocol,
      to: detail.to ?? '',
      messageType: detail.messageType,
    })
  } else {
    eventBus.emit({
      type: 'protocol:message_received',
      protocol: detail.protocol,
      from: detail.from ?? '',
      messageType: detail.messageType,
    })
  }
}
