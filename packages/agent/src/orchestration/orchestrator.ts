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
import type { StructuredToolInterface } from '@langchain/core/tools'
import { DzupAgent } from '../agent/dzip-agent.js'
import { OrchestrationError } from './orchestration-error.js'
import { ContractNetManager } from './contract-net/contract-net-manager.js'
import type { ContractNetConfig, ContractResult } from './contract-net/contract-net-types.js'
import type { ProviderExecutionPort } from './provider-adapter/provider-execution-port.js'
import type { RoutingPolicy, AgentSpec, AgentTask } from './routing-policy-types.js'
import type { OrchestrationMergeStrategy, AgentResult } from './orchestration-merge-strategy-types.js'
import type { AgentCircuitBreaker } from './circuit-breaker.js'

export interface SupervisorConfig {
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

function recordCircuitBreakerFailure(
  circuitBreaker: AgentCircuitBreaker,
  agentId: string,
  error: unknown,
): void {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.toLowerCase().includes('timeout')) {
    circuitBreaker.recordTimeout(agentId)
    return
  }

  // Non-timeout invocation failures still indicate specialist health issues.
  // Feed them through the generic failure path instead of silently ignoring them.
  circuitBreaker.recordFailure(agentId)
}

function instrumentSpecialistTool(
  tool: StructuredToolInterface,
  specialistId: string,
  circuitBreaker: AgentCircuitBreaker | undefined,
): StructuredToolInterface {
  if (!circuitBreaker) return tool

  const originalInvoke = tool.invoke.bind(tool)
  tool.invoke = (async (...args: Parameters<typeof tool.invoke>) => {
    try {
      const result = await originalInvoke(...args)
      circuitBreaker.recordSuccess(specialistId)
      return result
    } catch (err: unknown) {
      recordCircuitBreakerFailure(circuitBreaker, specialistId, err)
      throw err
    }
  }) as typeof tool.invoke

  return tool
}

export class AgentOrchestrator {
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
      const settled = await Promise.allSettled(
        effectiveAgents.map(agent => agent.generate([new HumanMessage(input)])),
      )

      // Record circuit breaker outcomes
      if (options.circuitBreaker) {
        for (const [i, outcome] of settled.entries()) {
          const agentId = effectiveAgents[i]!.id
          if (outcome.status === 'fulfilled') {
            options.circuitBreaker.recordSuccess(agentId)
          } else {
            const msg = outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason)
            if (msg.toLowerCase().includes('timeout')) {
              options.circuitBreaker.recordTimeout(agentId)
            } else {
              options.circuitBreaker.recordFailure(agentId)
            }
          }
        }
      }

      // Use OrchestrationMergeStrategy if provided
      if (options.mergeStrategy) {
        const agentResults: AgentResult<string>[] = settled.map((outcome, i) => {
          const agentId = effectiveAgents[i]!.id
          if (outcome.status === 'fulfilled') {
            return {
              agentId,
              status: 'success' as const,
              output: outcome.value.content,
            }
          }
          const errMsg = outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason)
          return {
            agentId,
            status: errMsg.toLowerCase().includes('timeout')
              ? ('timeout' as const)
              : ('error' as const),
            error: errMsg,
          }
        })
        const merged = options.mergeStrategy.merge(agentResults)
        if (merged.output !== undefined) {
          return typeof merged.output === 'string'
            ? merged.output
            : JSON.stringify(merged.output)
        }
        return `Merge status: ${merged.status} (no output)`
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

    // Default path: preserve original Promise.all behavior (rejects on failure)
    const results = await Promise.all(
      effectiveAgents.map(agent => agent.generate([new HumanMessage(input)])),
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
    let { specialists } = config

    // Provider-adapter execution mode: route through the injected port
    if (executionMode === 'provider-adapter' && providerPort) {
      const portResult = await providerPort.run(
        { prompt: task, signal },
        { prompt: task, tags: specialists.map((s) => s.id) },
        { signal },
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
      const before = specialists.length
      specialists = circuitBreaker.filterAvailable(specialists)
      if (specialists.length < before) {
        const removedIds = config.specialists
          .filter((s) => !specialists.includes(s))
          .map((s) => s.id)
        // Log filtered agents for observability
        console.debug('[AgentOrchestrator] Circuit breaker filtered agents:', removedIds)
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
      const agentTask: AgentTask = {
        taskId: `supervisor-${Date.now()}`,
        content: task,
      }
      const decision = routingPolicy.select(agentTask, candidates)
      const selectedIds = new Set(decision.selected.map((a) => a.id))
      specialists = specialists.filter((s) => selectedIds.has(s.id))
      console.debug('[AgentOrchestrator] Routing decision:', {
        selected: decision.selected.map((a) => a.id),
        strategy: decision.strategy,
        reason: decision.reason,
      })
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

    // Convert each specialist into a LangChain tool
    const specialistTools = await Promise.all(
      specialists.map(async (s) => instrumentSpecialistTool(
        await s.asTool(),
        s.id,
        circuitBreaker,
      )),
    )

    const availableSpecialists = specialists.map(s => s.id)

    // Create a new manager agent instance with specialist tools injected
    // alongside any tools the manager already has.
    const managerConfig = manager.agentConfig
    const managerWithTools = new DzupAgent({
      ...managerConfig,
      id: `${managerConfig.id}__supervisor`,
      tools: [...(managerConfig.tools ?? []), ...specialistTools],
      instructions: managerConfig.instructions +
        '\n\nYou are a supervisor agent. You have access to specialist agent tools. ' +
        'Delegate sub-tasks to the appropriate specialist by calling their tool. ' +
        'Synthesize specialist responses into a coherent final answer.',
    })

    // Run the manager with the task -- the LLM will invoke specialist tools
    // via function calling, and the tool loop handles ToolMessage flow.
    try {
      const result = await managerWithTools.generate(
        [new HumanMessage(task)],
        { signal },
      )

      if (returnLegacy) {
        return result.content
      }

      return {
        content: result.content,
        availableSpecialists,
        filteredSpecialists,
      }
    } catch (err: unknown) {
      throw err
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
