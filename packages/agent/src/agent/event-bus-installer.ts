/**
 * Event-bus wiring helper for the {@link DzupAgent} constructor.
 *
 * Wires every event-bus-aware subsystem at construction time:
 *
 *   - mailbox + mail tools (when `config.mailbox` is provided)
 *   - distributed rate limiter / cost ledger (MC-07)
 *   - {@link AgentInstructionResolver}
 *   - {@link AgentMemoryContextLoader} with bridged `onFallback` /
 *     `onFallbackDetail` so listeners receive a consistent
 *     `agent:context_fallback` event regardless of which callback the
 *     caller registered
 *   - {@link AgentMiddlewareRuntime}
 *
 * Returns a bundle that the {@link DzupAgent} constructor binds to its
 * private fields. Splitting this out keeps the constructor body under
 * 40 LOC while preserving the original observable wiring (event bus
 * `agent:context_fallback` emissions, structured fallback details,
 * mailbox tool registration order).
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { TokenBucket } from '@dzupagent/core'
import { DistributedRateLimiter } from '../guardrails/distributed-rate-limiter.js'
import { DistributedCostLedger } from '../guardrails/distributed-budget.js'
import type { DzupAgentConfig } from './agent-types.js'
import type { AgentMailbox } from '../mailbox/types.js'
import { AgentMailboxImpl } from '../mailbox/agent-mailbox.js'
import { InMemoryMailboxStore } from '../mailbox/in-memory-mailbox-store.js'
import { createSendMailTool, createCheckMailTool } from '../mailbox/mail-tools.js'
import { AgentInstructionResolver } from './instruction-resolution.js'
import type { AgentInstructionResolverConfig } from './instruction-resolution.js'
import { AgentMemoryContextLoader } from './memory-context-loader.js'
import type {
  AgentMemoryContextLoaderConfig,
  ArrowMemoryRuntime,
} from './memory-context-loader.js'
import { AgentMiddlewareRuntime } from './middleware-runtime.js'
import type { AgentMiddlewareRuntimeConfig } from './middleware-runtime.js'
import { omitUndefined } from '../utils/exact-optional.js'

/**
 * Wiring bundle returned by {@link installEventBus}.
 *
 * Each field is `readonly` so the constructor's `readonly` invariants
 * are preserved when assigned: the constructor binds these one-for-one
 * to its private fields. The optional fields (`mailbox`, distributed
 * guardrails) are `undefined` when the corresponding feature was not
 * configured, matching the pre-RF-21 surface exactly.
 */
export interface AgentEventBusWiring {
  mailbox: AgentMailbox | undefined
  mailboxTools: StructuredToolInterface[]
  distributedRateLimiter: DistributedRateLimiter | undefined
  distributedCostLedger: DistributedCostLedger | undefined
  instructionResolver: AgentInstructionResolver
  memoryContextLoader: AgentMemoryContextLoader
  middlewareRuntime: AgentMiddlewareRuntime
}

/**
 * Wire every event-bus-aware subsystem for a freshly-constructed agent.
 */
export function installEventBus(
  agentId: string,
  config: DzupAgentConfig,
  rateLimiter: TokenBucket | undefined,
  estimateConversationTokens: (messages: BaseMessage[]) => number,
): AgentEventBusWiring {
  // --- Distributed guardrails (MC-07) ---
  // Optional Redis-backed rate limit and cost ledger so multi-instance
  // fleets share a single budget. Both are gated on explicit
  // `guardrails.distributed.*` config so the default surface is unchanged.
  const distributed = config.guardrails?.distributed
  const distributedRateLimiter = distributed?.rateLimiter
    ? new DistributedRateLimiter(
        omitUndefined({
          client: distributed.rateLimiter.client,
          windowMs: distributed.rateLimiter.windowMs,
          maxRequests: distributed.rateLimiter.maxRequests,
          keyPrefix: distributed.rateLimiter.keyPrefix,
          fallbackToLocal: distributed.rateLimiter.fallbackToLocal,
        }),
        rateLimiter,
      )
    : undefined
  const distributedCostLedger = distributed?.costLedger
    ? new DistributedCostLedger(
        omitUndefined({
          client: distributed.costLedger.client,
          maxCostUsd: distributed.costLedger.maxCostUsd,
          ttlMs: distributed.costLedger.ttlMs,
          keyPrefix: distributed.costLedger.keyPrefix,
          fallbackToLocal: distributed.costLedger.fallbackToLocal,
        }),
      )
    : undefined

  // --- Mailbox (when configured) ---
  let mailbox: AgentMailbox | undefined
  let mailboxTools: StructuredToolInterface[] = []
  if (config.mailbox) {
    const store = config.mailbox.store ?? new InMemoryMailboxStore()
    const eventBus = config.mailbox.eventBus ?? config.eventBus
    const mailboxImpl = new AgentMailboxImpl(agentId, store, eventBus)
    mailbox = mailboxImpl
    mailboxTools = [
      createSendMailTool({ mailbox: mailboxImpl }),
      createCheckMailTool({ mailbox: mailboxImpl }),
    ]
  }

  // --- Instruction resolver ---
  const instructionResolver = new AgentInstructionResolver(omitUndefined<AgentInstructionResolverConfig>({
    agentId,
    instructions: config.instructions,
    instructionsMode: config.instructionsMode,
    agentsDir: config.agentsDir,
  }))

  // --- Memory context loader (the bulk of event-bus wiring) ---
  // Bridges `onFallback`, `onFallbackDetail`, and the underlying event bus
  // so listeners receive a consistent `agent:context_fallback` event with
  // structured detail (provider, namespace, before/after) regardless of
  // which callback the caller registered.
  const memoryContextLoader = new AgentMemoryContextLoader(omitUndefined<AgentMemoryContextLoaderConfig>({
    instructions: config.instructions,
    memory: config.memory,
    memoryNamespace: config.memoryNamespace,
    memoryScope: config.memoryScope,
    memoryReadContext: config.toolExecution?.runId
      ? { runId: config.toolExecution.runId }
      : undefined,
    arrowMemory: config.arrowMemory,
    memoryProfile: config.memoryProfile,
    frozenSnapshot: config.frozenSnapshot,
    // Inject the Arrow runtime loader (ADR-0005). The dynamic import in
    // memory-context-loader.ts was removed; callers using arrowMemory must
    // pass a loader so the dependency is visible at the call site.
    loadArrowRuntime: config.loadArrowRuntime
      ? config.loadArrowRuntime as () => Promise<ArrowMemoryRuntime>
      : undefined,
    limits: config.memoryContextLimits,
    estimateConversationTokens,
    onFallback: config.onFallback
      ? (reason, before, after) => {
          config.onFallback!(reason, before, after)
          config.eventBus?.emit(omitUndefined({
            type: 'agent:context_fallback',
            agentId,
            reason,
            before,
            after,
            provider: 'arrow',
            namespace: config.memoryNamespace,
          }))
        }
      : config.eventBus
        ? (reason, before, after) => {
            config.eventBus!.emit(omitUndefined({
              type: 'agent:context_fallback',
              agentId,
              reason,
              before,
              after,
              provider: 'arrow',
              namespace: config.memoryNamespace,
            }))
          }
        : undefined,
    // Bridge structured detail into eventBus so listeners receive the
    // richer fields (provider, namespace, detail) on the same event type.
    onFallbackDetail: (event) => {
      config.onFallbackDetail?.(event)
      config.eventBus?.emit(omitUndefined({
        type: 'agent:context_fallback',
        agentId,
        reason: event.reason,
        before: event.tokensBefore ?? 0,
        after: event.tokensAfter ?? 0,
        provider: event.provider,
        namespace: event.namespace,
        detail: event.detail,
      }))
    },
  }))

  // --- Middleware runtime ---
  const middlewareRuntime = new AgentMiddlewareRuntime(omitUndefined<AgentMiddlewareRuntimeConfig>({
    agentId,
    middleware: config.middleware,
  }))

  return {
    mailbox,
    mailboxTools,
    distributedRateLimiter,
    distributedCostLedger,
    instructionResolver,
    memoryContextLoader,
    middlewareRuntime,
  }
}
