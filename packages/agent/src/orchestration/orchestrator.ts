/**
 * Multi-agent orchestration patterns.
 *
 * Provides composable patterns for coordinating multiple ForgeAgent instances:
 * - Sequential: A -> B -> C (pipeline)
 * - Parallel: A, B, C concurrently, results merged
 * - Supervisor: Manager delegates to specialists via tool calling
 * - Debate: Multiple proposers, judge selects best
 */
import { HumanMessage } from '@langchain/core/messages'
import { ForgeAgent } from '../agent/forge-agent.js'
import { OrchestrationError } from './orchestration-error.js'
import { ContractNetManager } from './contract-net/contract-net-manager.js'
import type { ContractNetConfig, ContractResult } from './contract-net/contract-net-types.js'

export interface SupervisorConfig {
  /** The manager agent that coordinates specialists */
  manager: ForgeAgent
  /** Specialist agents to be exposed as tools to the manager */
  specialists: ForgeAgent[]
  /** The task to delegate */
  task: string
  /** If true, run a lightweight health check on each specialist before exposing it */
  healthCheck?: boolean
  /** Abort signal for cancellation */
  signal?: AbortSignal
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
   * Run agents sequentially -- each receives the previous agent's output.
   */
  static async sequential(
    agents: ForgeAgent[],
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
   */
  static async parallel(
    agents: ForgeAgent[],
    input: string,
    merge?: MergeFn,
  ): Promise<string> {
    const results = await Promise.all(
      agents.map(agent => agent.generate([new HumanMessage(input)])),
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
  static async supervisor(manager: ForgeAgent, specialists: ForgeAgent[], task: string): Promise<string>
  static async supervisor(
    configOrManager: SupervisorConfig | ForgeAgent,
    maybeSpecialists?: ForgeAgent[],
    maybeTask?: string,
  ): Promise<SupervisorResult | string> {
    // Normalize arguments: support both old positional and new config-object signatures
    let config: SupervisorConfig
    let returnLegacy = false

    if (configOrManager instanceof ForgeAgent) {
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

    const { manager, task, signal } = config
    let { specialists } = config

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

    // Optional health check: filter out unresponsive specialists
    const filteredSpecialists: string[] = []
    if (config.healthCheck) {
      const healthySpecialists: ForgeAgent[] = []
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
      specialists.map(s => s.asTool()),
    )

    const availableSpecialists = specialists.map(s => s.id)

    // Create a new manager agent instance with specialist tools injected
    // alongside any tools the manager already has.
    const managerConfig = manager.agentConfig
    const managerWithTools = new ForgeAgent({
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
  }

  /**
   * Debate pattern -- multiple agents propose solutions, a judge selects the best.
   */
  static async debate(
    proposers: ForgeAgent[],
    judge: ForgeAgent,
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
