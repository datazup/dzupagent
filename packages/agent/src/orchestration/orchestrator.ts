/**
 * Multi-agent orchestration patterns.
 *
 * Provides composable patterns for coordinating multiple DzupAgent instances:
 * - Sequential: A -> B -> C (pipeline)
 * - Parallel: A, B, C concurrently, results merged
 * - Supervisor: Manager delegates to specialists via tool calling
 * - Debate: Multiple proposers, judge selects best
 */
import { HumanMessage } from '@langchain/core/messages'
import { defaultLogger } from '@dzupagent/core/utils'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { BaseSupervisorContract } from '@dzupagent/agent-types'
import { DzupAgent } from '../agent/dzip-agent.js'
import { OrchestrationError } from './orchestration-error.js'
import { ContractNetManager } from './contract-net/contract-net-manager.js'
import type { ContractNetConfig, ContractResult } from './contract-net/contract-net-types.js'
import type { ProviderExecutionPort } from './provider-adapter/provider-execution-port.js'
import type { RoutingPolicy, AgentSpec, AgentTask } from './routing-policy-types.js'
import type { OrchestrationMergeStrategy } from './orchestration-merge-strategy-types.js'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import { omitUndefined } from '../utils/exact-optional.js'
import {
  recordParallelCircuitBreakerOutcomes,
  renderMergedParallelOutput,
  toParallelAgentResults,
} from './parallel-orchestration-results.js'
import { instrumentSpecialistTool } from './specialist-tool-instrumentation.js'
import { runAllConcurrently, runConcurrently } from './concurrency-runner.js'

export interface SupervisorConfig extends BaseSupervisorContract<DzupAgent> {
  /** The manager agent that coordinates specialists */
  manager: DzupAgent
  /** Specialist agents to be exposed as tools to the manager */
  specialists: DzupAgent[]
  /** The task to delegate */
  task: string
  /** If true, run a lightweight health check on each specialist before exposing it */
  healthCheck?: boolean
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Event bus for structured supervisor routing diagnostics */
  eventBus?: DzupEventBus
  /**
   * Execution mode for the supervisor.
   * - `'agent'` (default): use DzupAgent for execution
   * - `'provider-adapter'`: route via the injected `providerPort`
   */
  executionMode?: 'agent' | 'provider-adapter'
  /**
   * Provider execution port for adapter-based execution.
   * Required when `executionMode` is `'provider-adapter'`.
   * Ignored when `executionMode` is `'agent'` or unset.
   */
  providerPort?: ProviderExecutionPort
  /**
   * Pluggable routing policy for specialist selection.
   * When set, filters/selects specialists before exposing them to the manager.
   */
  routingPolicy?: RoutingPolicy
  /**
   * Pluggable merge strategy for combining parallel agent results.
   * Used by the `parallel` method when provided.
   */
  mergeStrategy?: OrchestrationMergeStrategy
  /**
   * Circuit breaker for excluding unhealthy specialists.
   * When set, specialists with tripped circuits are filtered out.
   */
  circuitBreaker?: AgentCircuitBreaker
}

export interface SupervisorResult {
  /** The final text output from the manager */
  content: string
  /** Which specialist tools were available to the manager */
  availableSpecialists: string[]
  /** Which specialists were filtered out by health check */
  filteredSpecialists: string[]
}

export type MergeFn = (results: string[]) => string | Promise<string>

const defaultMerge: MergeFn = (results) =>
  results.map((r, i) => `--- Agent ${i + 1} ---\n${r}`).join('\n\n')

export class AgentOrchestrator {
  /**
   * Cache of manager-with-tools `DzupAgent` instances keyed by manager object
   * identity and sorted specialist ids. Constructing the supervisor
   * `DzupAgent` is non-trivial (model bind, instruction templating,
   * tool wiring), so when a stable specialist set is reused across
   * many supervisor() calls, we reuse the prepared instance.
   *
   * Invalidation:
   * - Outer key is a `WeakMap` on the manager instance: a different
   *   manager object is a different cache entry even if its id matches.
   * - Inner key is the sorted specialist id list. To guard against
   *   collisions where two distinct specialist instances share the same
   *   id (test fixtures and pooled rebuilds), the cached entry remembers
   *   the exact specialist instances and is invalidated if any differs.
   *
   * Cleanup: callers (or tests) may invoke `clearSupervisorCache()` to
   * drop all cached entries -- e.g. on shutdown or between test cases.
   */
  private static supervisorAgentCache = new WeakMap<
    DzupAgent,
    Map<string, { agent: DzupAgent; specialists: readonly DzupAgent[] }>
  >()

  /**
   * Clear the supervisor agent cache. Use when the lifecycle owner of
   * AgentOrchestrator is being torn down or when underlying agent
   * configuration is known to have changed.
   */
  static clearSupervisorCache(): void {
    AgentOrchestrator.supervisorAgentCache = new WeakMap()
  }

  /**
   * Run agents sequentially -- each receives the previous agent's output.
   */
  static async sequential(
    agents: DzupAgent[],
    initialInput: string,
  ): Promise<string> {
    let current = initialInput
    for (const agent of agents) {
      const result = await agent.generate([new HumanMessage(current)])
      current = result.content
    }
    return current
  }

  /**
   * Run agents in parallel -- all receive the same input, results merged.
   *
   * When `options.circuitBreaker` is provided, agents with tripped circuits
   * are excluded and success/timeout is recorded after each agent completes.
   * When `options.mergeStrategy` is provided, it is used instead of the
   * legacy `merge` function for combining results.
   */
  static async parallel(
    agents: DzupAgent[],
    input: string,
    merge?: MergeFn,
    options?: {
      circuitBreaker?: AgentCircuitBreaker
      mergeStrategy?: OrchestrationMergeStrategy<string>
      /**
       * Maximum number of agents to run concurrently.
       * When set, agents run in batches rather than all at once, preventing
       * resource exhaustion with large agent lists.
       * Default: unlimited.
       */
      maxConcurrency?: number
    },
  ): Promise<string> {
    let effectiveAgents = agents

    // Filter through circuit breaker if configured
    if (options?.circuitBreaker) {
      effectiveAgents = options.circuitBreaker.filterAvailable(agents)
      if (effectiveAgents.length === 0) {
        throw new OrchestrationError(
          'All agents filtered by circuit breaker in parallel execution',
          'parallel',
        )
      }
    }

    // When merge strategy or circuit breaker is active, use allSettled for resilience
    if (options?.mergeStrategy || options?.circuitBreaker) {
      const settled = await runConcurrently(
        effectiveAgents.map(agent => () => agent.generate([new HumanMessage(input)])),
        options?.maxConcurrency,
      )

      recordParallelCircuitBreakerOutcomes(
        effectiveAgents,
        settled,
        options.circuitBreaker,
      )

      // Use OrchestrationMergeStrategy if provided
      if (options.mergeStrategy) {
        const agentResults = toParallelAgentResults(effectiveAgents, settled)
        const merged = options.mergeStrategy.merge(agentResults)
        return renderMergedParallelOutput(merged)
      }

      // Fallback: collect fulfilled results for legacy merge
      const contents: string[] = []
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          contents.push(outcome.value.content)
        }
      }
      return (merge ?? defaultMerge)(contents)
    }

    // Default path: reject on first failure; respect maxConcurrency
    const results = await runAllConcurrently(
      effectiveAgents.map(agent => () => agent.generate([new HumanMessage(input)])),
      options?.maxConcurrency,
    )
    const contents = results.map(r => r.content)
    return (merge ?? defaultMerge)(contents)
  }

  /**
   * Supervisor pattern -- manager agent delegates to specialist agents via tools.
   *
   * Each specialist is converted to a LangChain tool via `asTool()` and injected
   * into a new manager agent instance. The manager LLM then invokes specialists
   * through standard function calling. Results flow back as ToolMessages.
   */
  static async supervisor(config: SupervisorConfig): Promise<SupervisorResult>
  /** @deprecated Use the config object overload instead */
  static async supervisor(manager: DzupAgent, specialists: DzupAgent[], task: string): Promise<string>
  static async supervisor(
    configOrManager: SupervisorConfig | DzupAgent,
    maybeSpecialists?: DzupAgent[],
    maybeTask?: string,
  ): Promise<SupervisorResult | string> {
    // Normalize arguments: support both old positional and new config-object signatures
    let config: SupervisorConfig
    let returnLegacy = false

    if (configOrManager instanceof DzupAgent) {
      if (!maybeSpecialists || !maybeTask) {
        throw new OrchestrationError(
          'supervisor() requires specialists and task when called with positional arguments',
          'supervisor',
        )
      }
      config = { manager: configOrManager, specialists: maybeSpecialists, task: maybeTask }
      returnLegacy = true
    } else {
      config = configOrManager
    }

    const { manager, task, signal, executionMode, providerPort, routingPolicy, circuitBreaker } = config
    const eventBus = config.eventBus ?? manager.agentConfig.eventBus
    let { specialists } = config

    // Provider-adapter execution mode: route through the injected port.
    // This mode is explicitly configured, so fail closed when the port is absent
    // instead of silently falling back to local specialist execution.
    if (executionMode === 'provider-adapter') {
      if (!providerPort) {
        throw new OrchestrationError(
          'supervisor() provider-adapter executionMode requires providerPort',
          'supervisor',
          { managerId: manager.id },
        )
      }

      const portResult = await providerPort.run(
        omitUndefined({ prompt: task, signal }),
        { prompt: task, tags: specialists.map((s) => s.id) },
        omitUndefined({ signal }),
      )

      const result: SupervisorResult = {
        content: portResult.content,
        availableSpecialists: specialists.map((s) => s.id),
        filteredSpecialists: [],
      }

      return returnLegacy ? portResult.content : result
    }

    // Validate inputs
    if (specialists.length === 0) {
      throw new OrchestrationError(
        'supervisor() requires at least one specialist agent',
        'supervisor',
        { managerId: manager.id },
      )
    }

    // Check abort before starting
    if (signal?.aborted) {
      throw new OrchestrationError(
        'supervisor() aborted before execution',
        'supervisor',
        { managerId: manager.id },
      )
    }

    // Filter specialists through circuit breaker if configured
    if (circuitBreaker) {
      const candidateSpecialists = specialists.map((s) => s.id)
      const before = specialists.length
      specialists = circuitBreaker.filterAvailable(specialists)
      if (specialists.length < before) {
        const removedIds = config.specialists
          .filter((s) => !specialists.includes(s))
          .map((s) => s.id)
        eventBus?.emit({
          type: 'supervisor:routing_decision',
          managerId: manager.id,
          task,
          strategy: 'circuit-breaker',
          reason: 'Excluded specialists with open circuits',
          selectedSpecialists: specialists.map((s) => s.id),
          filteredSpecialists: removedIds,
          candidateSpecialists,
          source: 'direct-supervisor',
        })
        // Log filtered agents for observability when no event bus is wired.
        if (!eventBus) {
          defaultLogger.debug('[AgentOrchestrator] Circuit breaker filtered agents', { removedIds })
        }
      }

      if (specialists.length === 0) {
        throw new OrchestrationError(
          'All specialists filtered by circuit breaker',
          'supervisor',
          { managerId: manager.id },
        )
      }
    }

    // Apply routing policy if configured to narrow specialist selection
    if (routingPolicy) {
      const candidates: AgentSpec[] = specialists.map((s) => ({
        id: s.id,
        name: s.id,
        tags: [],
      }))
      const candidateSpecialists = candidates.map((s) => s.id)
      const agentTask: AgentTask = {
        taskId: `supervisor-${Date.now()}`,
        content: task,
      }
      const decision = routingPolicy.select(agentTask, candidates)
      const selectedIds = new Set(decision.selected.map((a) => a.id))
      specialists = specialists.filter((s) => selectedIds.has(s.id))
      const selectedSpecialists = specialists.map((s) => s.id)
      const filteredSpecialists = candidateSpecialists.filter((id) => !selectedIds.has(id))

      const routingEvent = omitUndefined({
        type: 'supervisor:routing_decision',
        managerId: manager.id,
        task,
        taskId: agentTask.taskId,
        strategy: decision.strategy,
        reason: decision.reason,
        fallbackReason: decision.fallbackReason,
        selectedSpecialists,
        selectedCandidates: decision.diagnostics?.selectedIds ?? selectedSpecialists,
        filteredSpecialists,
        candidateSpecialists,
        source: 'direct-supervisor',
      } as const)
      eventBus?.emit(routingEvent)
      if (!eventBus) {
        defaultLogger.debug('[AgentOrchestrator] Routing decision', {
          selected: selectedSpecialists,
          strategy: decision.strategy,
          reason: decision.reason,
          fallbackReason: decision.fallbackReason,
        })
      }
    }

    // Optional health check: filter out unresponsive specialists
    const filteredSpecialists: string[] = []
    if (config.healthCheck) {
      const healthySpecialists: DzupAgent[] = []
      for (const specialist of specialists) {
        try {
          // Lightweight check: just verify asTool() resolves without error
          await specialist.asTool()
          healthySpecialists.push(specialist)
        } catch {
          filteredSpecialists.push(specialist.id)
        }
      }

      if (healthySpecialists.length === 0) {
        throw new OrchestrationError(
          'All specialists failed health check',
          'supervisor',
          { managerId: manager.id, filteredSpecialists },
        )
      }

      specialists = healthySpecialists
    }

    const availableSpecialists = specialists.map(s => s.id)

    // Memoize the manager-with-tools DzupAgent per manager instance and
    // sorted specialist ids only when specialist tools do not capture
    // per-call circuit breaker state.
    // Constructing the supervisor agent (and its specialist tools via asTool())
    // is non-trivial; when callers reuse a stable specialist set across many
    // supervisor() invocations, this avoids paying full init cost each time.
    const managerConfig = manager.agentConfig
    // Build the canonical (sorted-by-id) specialist list once; both the
    // cache key and the identity guard read from this list.
    const canonicalSpecialists = [...specialists].sort((a, b) => a.id.localeCompare(b.id))
    const sortedSpecialistIds = canonicalSpecialists.map(s => s.id)
    const cacheKey = circuitBreaker ? undefined : sortedSpecialistIds.join(',')
    const managerCache = cacheKey
      ? AgentOrchestrator.supervisorAgentCache.get(manager)
      : undefined
    const cachedEntry = cacheKey ? managerCache?.get(cacheKey) : undefined

    // Cache hit only if every cached specialist instance is identical
    // (===) to the corresponding canonical specialist; otherwise the
    // cached supervisor wraps stale tools / models.
    const cachedSpecialistsMatch =
      !!cachedEntry &&
      cachedEntry.specialists.length === canonicalSpecialists.length &&
      cachedEntry.specialists.every((s, i) => s === canonicalSpecialists[i])

    let managerWithTools = cachedSpecialistsMatch ? cachedEntry.agent : undefined

    if (!managerWithTools) {
      // Convert each specialist into a LangChain tool
      const specialistTools = await Promise.all(
        specialists.map(async (s) => instrumentSpecialistTool(
          await s.asTool(),
          s.id,
          circuitBreaker,
        )),
      )

      // Create a new manager agent instance with specialist tools injected
      // alongside any tools the manager already has.
      managerWithTools = new DzupAgent({
        ...managerConfig,
        id: `${managerConfig.id}__supervisor`,
        tools: [...(managerConfig.tools ?? []), ...specialistTools],
        instructions: managerConfig.instructions +
          '\n\nYou are a supervisor agent. You have access to specialist agent tools. ' +
          'Delegate sub-tasks to the appropriate specialist by calling their tool. ' +
          'Synthesize specialist responses into a coherent final answer.',
      })

      if (cacheKey) {
        const cache = managerCache ?? new Map<string, { agent: DzupAgent; specialists: readonly DzupAgent[] }>()
        cache.set(cacheKey, { agent: managerWithTools, specialists: canonicalSpecialists })
        if (!managerCache) {
          AgentOrchestrator.supervisorAgentCache.set(manager, cache)
        }
      }
    }

    // Run the manager with the task -- the LLM will invoke specialist tools
    // via function calling, and the tool loop handles ToolMessage flow.
    const result = await managerWithTools.generate(
      [new HumanMessage(task)],
      omitUndefined({ signal }),
    )

    if (returnLegacy) {
      return result.content
    }

    return {
      content: result.content,
      availableSpecialists,
      filteredSpecialists,
    }
  }

  /**
   * Debate pattern -- multiple agents propose solutions, a judge selects the best.
   */
  static async debate(
    proposers: DzupAgent[],
    judge: DzupAgent,
    task: string,
    options?: { rounds?: number },
  ): Promise<string> {
    const rounds = options?.rounds ?? 1
    let proposals: string[] = []

    for (let round = 0; round < rounds; round++) {
      // Each proposer generates a solution
      const roundInput = round === 0
        ? task
        : `${task}\n\nPrevious proposals:\n${proposals.map((p, i) => `Proposal ${i + 1}: ${p}`).join('\n\n')}\n\nImprove upon the best aspects of all proposals.`

      const results = await Promise.all(
        proposers.map(agent => agent.generate([new HumanMessage(roundInput)])),
      )
      proposals = results.map(r => r.content)
    }

    // Judge selects the best
    const judgeInput = proposals
      .map((p, i) => `## Proposal ${i + 1}\n${p}`)
      .join('\n\n')

    const judgeResult = await judge.generate([
      new HumanMessage(
        `Evaluate these proposals for the following task:\n\n**Task:** ${task}\n\n${judgeInput}\n\n` +
        `Select the best proposal (or synthesize the best parts of multiple proposals). ` +
        `Explain your reasoning briefly, then provide the final answer.`,
      ),
    ])

    return judgeResult.content
  }

  /**
   * Contract-net pattern -- manager announces task, specialists bid,
   * best bidder executes.
   */
  static async contractNet(config: ContractNetConfig): Promise<ContractResult> {
    return ContractNetManager.execute(config)
  }
}
