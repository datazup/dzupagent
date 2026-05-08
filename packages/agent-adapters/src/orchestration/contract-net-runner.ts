/**
 * Bid collection and execution runner for ContractNetOrchestrator.
 *
 * Extracted from `contract-net.ts` to keep the orchestrator class small.
 * These functions implement two phases of the FIPA Contract-Net protocol:
 *
 * - `collectBids`: race the bid strategy against a configurable timeout
 *   and an external abort signal.
 * - `executeWithFallback`: run the ranked bidders in order, awarding to
 *   the next-best bidder if the current winner fails or is unhealthy.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import { ForgeError } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

import type {
  Bid,
  BidStrategy,
  ContractNetResult,
} from './contract-net-types.js'
import {
  buildCancelledResult,
  consumeAdapterEvents,
  emitProtocol,
} from './contract-net-helpers.js'

// ---------------------------------------------------------------------------
// Bid collection
// ---------------------------------------------------------------------------

/**
 * Collect bids from the configured BidStrategy, racing against a timeout
 * and an external abort signal.
 *
 * Returns an empty array on timeout (BUDGET_EXCEEDED) so callers can
 * surface a friendlier "no bids received" error. Re-throws AGENT_ABORTED
 * for callers to convert into a cancelled result.
 */
export async function collectBids(
  task: TaskDescriptor,
  availableProviders: AdapterProviderId[],
  bidStrategy: BidStrategy,
  bidTimeoutMs: number,
  signal?: AbortSignal,
): Promise<Bid[]> {
  const bidPromise = bidStrategy.generateBids(task, availableProviders)

  const timeoutPromise = new Promise<Bid[]>((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(
        new ForgeError({
          code: 'BUDGET_EXCEEDED',
          message: `Bid collection timed out after ${String(bidTimeoutMs)}ms`,
          recoverable: true,
        }),
      )
    }, bidTimeoutMs)

    // If externally aborted, clear timeout and reject
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(handle)
        reject(
          new ForgeError({
            code: 'AGENT_ABORTED',
            message: 'Bid collection aborted',
            recoverable: false,
          }),
        )
      },
      { once: true },
    )

    // Clean up timeout if bid promise resolves first
    void bidPromise.then(() => { clearTimeout(handle) })
  })

  try {
    return await Promise.race([bidPromise, timeoutPromise])
  } catch (err) {
    // If the bid strategy itself fails, the timeout promise may still
    // be pending. For static strategies this is unlikely, but we handle
    // it defensively by returning an empty array.
    if (err instanceof ForgeError && err.code === 'BUDGET_EXCEEDED') {
      // Timeout — return whatever bids we have (none in this case)
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Execution with fallback
// ---------------------------------------------------------------------------

/**
 * Execute the ranked bidders in order, falling back to the next-best on
 * failure.
 *
 * Emits `protocol:message_sent` (accept-proposal / reject-proposal) on
 * each attempt. Records adapter health on the registry. Returns a
 * cancelled result if the abort signal fires, or a failure result if all
 * bidders are exhausted.
 */
export async function executeWithFallback(
  rankedBids: Bid[],
  allBids: Bid[],
  task: TaskDescriptor,
  input: AgentInput,
  registry: ProviderAdapterRegistry,
  eventBus: DzupEventBus | undefined,
  signal?: AbortSignal,
): Promise<Omit<ContractNetResult, 'durationMs'>> {
  let lastError: string | undefined

  for (const bid of rankedBids) {
    if (signal?.aborted) {
      return buildCancelledResult(task, allBids, null, Date.now(), 'Contract-Net execution was aborted')
    }

    // Emit award
    emitProtocol(eventBus, 'message_sent', {
      protocol: 'contract-net',
      to: bid.providerId,
      messageType: 'accept-proposal',
    })

    const adapter = registry.getHealthy(bid.providerId)
    if (!adapter) {
      lastError = `Adapter "${bid.providerId}" became unhealthy before execution`
      // Emit rejection and try next
      emitProtocol(eventBus, 'message_sent', {
        protocol: 'contract-net',
        to: bid.providerId,
        messageType: 'reject-proposal',
      })
      continue
    }

    try {
      const mergedInput: AgentInput = { ...input, signal }
      const result = await consumeAdapterEvents(
        adapter.execute(mergedInput),
        bid.providerId,
        registry,
        signal,
      )

      // Late aborts that arrive after the adapter yielded its completed
      // result but before this method returns should still win.
      if (signal?.aborted) {
        return buildCancelledResult(task, allBids, bid, Date.now(), 'Contract-Net execution was aborted')
      }

      if (result.success) {
        return {
          task,
          winningBid: bid,
          allBids,
          executionResult: result.text,
          success: true,
        }
      }

      if (signal?.aborted) {
        return buildCancelledResult(task, allBids, bid, Date.now(), 'Contract-Net execution was aborted')
      }

      // Adapter completed but without a successful result
      lastError = result.error ?? 'Adapter completed without producing a result'
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
        return buildCancelledResult(task, allBids, bid, Date.now(), error.message)
      }
      lastError = error.message

      // Record failure in the registry so circuit breaker is updated
      registry.recordFailure(bid.providerId, error)
    }
  }

  // All ranked bids exhausted
  const failedBid = rankedBids[0]
  if (!failedBid) {
    throw new ForgeError({
      code: 'ALL_ADAPTERS_EXHAUSTED',
      message: 'No bids to execute',
      recoverable: false,
    })
  }

  return {
    task,
    winningBid: failedBid,
    allBids,
    executionResult: '',
    success: false,
    error: lastError ?? 'All bidders failed',
  }
}
