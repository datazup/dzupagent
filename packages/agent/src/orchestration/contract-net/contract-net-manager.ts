/**
 * ContractNetManager — executes the full contract-net protocol lifecycle.
 *
 * 1. Announce CFP (Call For Proposals)
 * 2. Collect bids from specialists (with deadline enforcement)
 * 3. Evaluate bids using pluggable strategy
 * 4. Award contract to best bidder
 * 5. Execute task with winning specialist
 * 6. Return result
 */
import { HumanMessage } from '@langchain/core/messages'
import type { DzupAgent } from '../../agent/dzip-agent.js'
import type { DzupEventBus } from '@dzupagent/core'
import { OrchestrationError } from '../orchestration-error.js'
import { createWeightedStrategy } from './bid-strategies.js'
import type {
  ContractNetConfig,
  ContractResult,
  ContractBid,
  CallForProposals,
  ContractNetState,
} from './contract-net-types.js'

const DEFAULT_BID_DEADLINE_MS = 30_000

/** Generate a unique CFP identifier. */
function generateCfpId(): string {
  return `cfp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/** Emit a custom contract-net event via the event bus (fire-and-forget). */
function emitContractEvent(
  eventBus: DzupEventBus | undefined,
  type: string,
  payload: Record<string, unknown>,
): void {
  if (!eventBus) return
  // Use onAny-compatible custom events by casting to DzupEvent.
  // The task spec says NOT to modify core DzupEvent types, so we
  // emit via the protocol event type which accepts arbitrary string data.
  eventBus.emit({
    type: 'protocol:message_sent',
    protocol: 'contract-net',
    to: 'broadcast',
    messageType: type,
    ...payload,
  } as Parameters<DzupEventBus['emit']>[0])
}

/**
 * Parse a bid from an agent's text response.
 * Expects JSON with the bid fields.
 */
function parseBid(agentId: string, cfpId: string, response: string): ContractBid | null {
  try {
    // Try to extract JSON from the response (may be wrapped in markdown code block)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = jsonMatch ? jsonMatch[1]! : response

    const parsed = JSON.parse(jsonStr.trim()) as Record<string, unknown>

    return {
      agentId,
      cfpId,
      estimatedCostCents: Number(parsed['estimatedCostCents'] ?? 0),
      estimatedDurationMs: Number(parsed['estimatedDurationMs'] ?? 0),
      qualityEstimate: Math.max(0, Math.min(1, Number(parsed['qualityEstimate'] ?? 0.5))),
      confidence: Math.max(0, Math.min(1, Number(parsed['confidence'] ?? 0.5))),
      approach: String(parsed['approach'] ?? 'No approach specified'),
    }
  } catch {
    return null
  }
}

/**
 * Collect a bid from a single specialist with deadline enforcement.
 */
async function collectBid(
  specialist: DzupAgent,
  cfp: CallForProposals,
  signal: AbortSignal | undefined,
): Promise<ContractBid | null> {
  const bidPrompt = [
    `You are being asked to bid on a task. Respond ONLY with a JSON object (no markdown, no explanation) containing your bid:`,
    '',
    `Task: ${cfp.task}`,
    cfp.requiredCapabilities?.length
      ? `Required capabilities: ${cfp.requiredCapabilities.join(', ')}`
      : '',
    cfp.maxCostCents != null
      ? `Maximum budget: ${cfp.maxCostCents} cents`
      : '',
    '',
    'Respond with this exact JSON structure:',
    '{',
    '  "estimatedCostCents": <number>,',
    '  "estimatedDurationMs": <number>,',
    '  "qualityEstimate": <number between 0 and 1>,',
    '  "confidence": <number between 0 and 1>,',
    '  "approach": "<brief description of your approach>"',
    '}',
  ].filter(Boolean).join('\n')

  // Create a deadline-scoped abort controller
  const deadlineController = new AbortController()
  const timer = setTimeout(() => deadlineController.abort(), cfp.bidDeadlineMs)

  // If external signal is already aborted, abort immediately
  const onExternalAbort = (): void => deadlineController.abort()
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    // Race the generate call against the deadline to enforce hard timeout.
    // model.invoke() may not respect AbortSignal internally, so we need
    // an explicit race to guarantee deadline enforcement.
    const deadlinePromise = new Promise<null>((resolve) => {
      const onAbort = (): void => resolve(null)
      if (deadlineController.signal.aborted) {
        resolve(null)
        return
      }
      deadlineController.signal.addEventListener('abort', onAbort, { once: true })
    })

    const generatePromise = specialist.generate(
      [new HumanMessage(bidPrompt)],
      { signal: deadlineController.signal },
    ).then(result => parseBid(specialist.id, cfp.cfpId, result.content))

    return await Promise.race([generatePromise, deadlinePromise])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

export class ContractNetManager {
  /**
   * Execute the full contract-net protocol lifecycle.
   */
  static async execute(config: ContractNetConfig): Promise<ContractResult> {
    const {
      specialists,
      task,
      signal,
      eventBus,
      retryOnNoBids = false,
      maxCostCents,
      requiredCapabilities,
    } = config

    const strategy = config.strategy ?? createWeightedStrategy({})
    const bidDeadlineMs = config.bidDeadlineMs ?? DEFAULT_BID_DEADLINE_MS

    const cfpId = generateCfpId()
    const cfp: CallForProposals = {
      cfpId,
      task,
      requiredCapabilities,
      maxCostCents,
      bidDeadlineMs,
    }

    const state: ContractNetState = {
      phase: 'announcing',
      cfp,
      bids: [],
    }

    // Check abort before starting
    if (signal?.aborted) {
      throw new OrchestrationError(
        'contract-net aborted before execution',
        'contract-net',
        { cfpId },
      )
    }

    // Phase 1: Announce
    emitContractEvent(eventBus, 'contract-net:cfp_announced', { cfpId, task })

    // Phase 2: Collect bids
    state.phase = 'bidding'
    const bids = await ContractNetManager.collectBids(specialists, cfp, signal)

    for (const bid of bids) {
      state.bids.push(bid)
      emitContractEvent(eventBus, 'contract-net:bid_received', {
        cfpId,
        agentId: bid.agentId,
      })
    }

    // Handle no bids
    if (bids.length === 0) {
      if (retryOnNoBids) {
        // Retry once with extended deadline
        const retryBids = await ContractNetManager.collectBids(
          specialists,
          { ...cfp, bidDeadlineMs: bidDeadlineMs * 2 },
          signal,
        )

        for (const bid of retryBids) {
          state.bids.push(bid)
          emitContractEvent(eventBus, 'contract-net:bid_received', {
            cfpId,
            agentId: bid.agentId,
          })
        }

        if (retryBids.length === 0) {
          state.phase = 'failed'
          emitContractEvent(eventBus, 'contract-net:failed', {
            cfpId,
            reason: 'No bids received after retry',
          })
          throw new OrchestrationError(
            'No bids received after retry',
            'contract-net',
            { cfpId },
          )
        }
      } else {
        state.phase = 'failed'
        emitContractEvent(eventBus, 'contract-net:failed', {
          cfpId,
          reason: 'No bids received',
        })
        throw new OrchestrationError(
          'No bids received',
          'contract-net',
          { cfpId },
        )
      }
    }

    // Phase 3: Evaluate
    state.phase = 'evaluating'
    const rankedBids = strategy.evaluate(state.bids)
    const winningBid = rankedBids[0]

    if (!winningBid) {
      state.phase = 'failed'
      throw new OrchestrationError(
        'Bid evaluation returned no results',
        'contract-net',
        { cfpId },
      )
    }

    // Phase 4: Award
    state.phase = 'awarding'
    state.award = {
      cfpId,
      winnerId: winningBid.agentId,
      bid: winningBid,
    }
    emitContractEvent(eventBus, 'contract-net:awarded', {
      cfpId,
      winnerId: winningBid.agentId,
    })

    // Check abort before execution
    if (signal?.aborted) {
      throw new OrchestrationError(
        'contract-net aborted before execution phase',
        'contract-net',
        { cfpId, winnerId: winningBid.agentId },
      )
    }

    // Phase 5: Execute
    state.phase = 'executing'
    const winner = specialists.find(s => s.id === winningBid.agentId)

    if (!winner) {
      state.phase = 'failed'
      throw new OrchestrationError(
        `Winning agent "${winningBid.agentId}" not found in specialists`,
        'contract-net',
        { cfpId },
      )
    }

    const startTime = Date.now()

    try {
      const execResult = await winner.generate(
        [new HumanMessage(`Execute this task using your proposed approach:\n\nTask: ${task}\n\nYour approach: ${winningBid.approach}`)],
        { signal },
      )

      const durationMs = Date.now() - startTime

      state.phase = 'completed'
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: true,
        result: execResult.content,
        actualDurationMs: durationMs,
      }
      state.result = contractResult

      emitContractEvent(eventBus, 'contract-net:completed', {
        cfpId,
        agentId: winningBid.agentId,
        durationMs,
      })

      return contractResult
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime
      const errorMessage = err instanceof Error ? err.message : String(err)

      state.phase = 'failed'
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: false,
        error: errorMessage,
        actualDurationMs: durationMs,
      }
      state.result = contractResult

      emitContractEvent(eventBus, 'contract-net:failed', {
        cfpId,
        agentId: winningBid.agentId,
        error: errorMessage,
      })

      return contractResult
    }
  }

  /**
   * Collect bids from all specialists in parallel.
   */
  private static async collectBids(
    specialists: DzupAgent[],
    cfp: CallForProposals,
    signal: AbortSignal | undefined,
  ): Promise<ContractBid[]> {
    const bidPromises = specialists.map(specialist =>
      collectBid(specialist, cfp, signal),
    )

    const results = await Promise.all(bidPromises)
    return results.filter((bid): bid is ContractBid => bid !== null)
  }
}
