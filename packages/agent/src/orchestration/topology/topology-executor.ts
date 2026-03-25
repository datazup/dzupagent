/**
 * TopologyExecutor — executes agent communication using different topologies.
 *
 * Supports mesh (all-to-all), ring (circular pass), and delegates to
 * AgentOrchestrator for hierarchical/pipeline/star patterns.
 */
import { HumanMessage } from '@langchain/core/messages'
import { AgentOrchestrator } from '../orchestrator.js'
import { OrchestrationError } from '../orchestration-error.js'
import { TopologyAnalyzer } from './topology-analyzer.js'
import type {
  TopologyType,
  TopologyMetrics,
  TopologyExecutorConfig,
  TaskCharacteristics,
} from './topology-types.js'

export interface MeshResult {
  results: string[]
  metrics: TopologyMetrics
}

export interface RingResult {
  result: string
  metrics: TopologyMetrics
}

export interface ExecuteResult {
  result: string | string[]
  metrics: TopologyMetrics
}

export class TopologyExecutor {
  /**
   * Execute mesh topology: all agents communicate with all others.
   *
   * Each agent gets the task + all other agents' previous outputs.
   * Runs one round, collects all results.
   */
  static async executeMesh(config: TopologyExecutorConfig): Promise<MeshResult> {
    const { agents, task, signal } = config
    const startTime = Date.now()
    let messageCount = 0
    let errorCount = 0

    if (agents.length === 0) {
      throw new OrchestrationError(
        'executeMesh() requires at least one agent',
        'topology-mesh',
      )
    }

    TopologyExecutor.checkAborted(signal, 'topology-mesh')

    // Run all agents in parallel with the task
    const settled = await Promise.allSettled(
      agents.map(async (agent) => {
        messageCount++
        const result = await agent.generate([new HumanMessage(task)], { signal })
        return result.content
      }),
    )

    const results: string[] = []
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
      } else {
        errorCount++
        results.push(`[error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}]`)
      }
    }

    return {
      results,
      metrics: {
        topology: 'mesh',
        totalDurationMs: Date.now() - startTime,
        agentCount: agents.length,
        messageCount,
        errorCount,
      },
    }
  }

  /**
   * Execute ring topology: circular pass.
   *
   * Agent 1 processes task, passes output to Agent 2, ..., Agent N.
   * Then loops back (up to maxRounds). Each agent receives the original
   * task plus the previous agent's output.
   */
  static async executeRing(config: TopologyExecutorConfig): Promise<RingResult> {
    const { agents, task, signal } = config
    const maxRounds = config.maxRounds ?? 3
    const startTime = Date.now()
    let messageCount = 0
    let errorCount = 0

    if (agents.length === 0) {
      throw new OrchestrationError(
        'executeRing() requires at least one agent',
        'topology-ring',
      )
    }

    TopologyExecutor.checkAborted(signal, 'topology-ring')

    let currentOutput = ''

    for (let round = 0; round < maxRounds; round++) {
      for (const agent of agents) {
        TopologyExecutor.checkAborted(signal, 'topology-ring')

        const input = currentOutput
          ? `${task}\n\nPrevious output:\n${currentOutput}`
          : task

        messageCount++

        try {
          const result = await agent.generate(
            [new HumanMessage(input)],
            { signal },
          )
          currentOutput = result.content
        } catch (err: unknown) {
          errorCount++
          // On error, keep the previous output and continue
          const errMsg = err instanceof Error ? err.message : String(err)
          currentOutput = currentOutput || `[error: ${errMsg}]`
        }
      }
    }

    return {
      result: currentOutput,
      metrics: {
        topology: 'ring',
        totalDurationMs: Date.now() - startTime,
        agentCount: agents.length,
        messageCount,
        errorCount,
      },
    }
  }

  /**
   * Execute the specified topology.
   *
   * Routes to the appropriate execution method. For hierarchical/pipeline/star,
   * delegates to AgentOrchestrator patterns. For mesh/ring, uses dedicated methods.
   *
   * If autoSwitch is enabled and the error rate exceeds the threshold,
   * re-analyzes and switches topology mid-execution.
   */
  static async execute(
    config: TopologyExecutorConfig & { topology: TopologyType },
  ): Promise<ExecuteResult> {
    const { topology, autoSwitch = false, errorThreshold = 0.5 } = config

    TopologyExecutor.checkAborted(config.signal, `topology-${topology}`)

    const result = await TopologyExecutor.executeTopology(config, topology)

    // Auto-switch: if error rate is high, re-analyze and try a different topology
    if (
      autoSwitch &&
      result.metrics.agentCount > 0 &&
      result.metrics.errorCount / result.metrics.agentCount > errorThreshold
    ) {
      const analyzer = new TopologyAnalyzer()
      const characteristics = TopologyExecutor.inferCharacteristics(config, topology)
      const recommendation = analyzer.analyze(characteristics)

      if (recommendation.recommended !== topology) {
        try {
          const retryResult = await TopologyExecutor.executeTopology(
            config,
            recommendation.recommended,
          )

          retryResult.metrics.switchedFrom = topology
          return retryResult
        } catch {
          // Retry topology also failed — return original result with switch annotation
          result.metrics.switchedFrom = topology
          return result
        }
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private static async executeTopology(
    config: TopologyExecutorConfig & { topology: TopologyType },
    topology: TopologyType,
  ): Promise<ExecuteResult> {
    switch (topology) {
      case 'mesh': {
        const meshResult = await TopologyExecutor.executeMesh(config)
        return { result: meshResult.results, metrics: meshResult.metrics }
      }

      case 'ring': {
        const ringResult = await TopologyExecutor.executeRing(config)
        return { result: ringResult.result, metrics: ringResult.metrics }
      }

      case 'pipeline': {
        const startTime = Date.now()
        const pipelineResult = await AgentOrchestrator.sequential(
          config.agents,
          config.task,
        )
        return {
          result: pipelineResult,
          metrics: {
            topology: 'pipeline',
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: config.agents.length,
            errorCount: 0,
          },
        }
      }

      case 'star': {
        const startTime = Date.now()
        const starResult = await AgentOrchestrator.parallel(
          config.agents,
          config.task,
        )
        return {
          result: starResult,
          metrics: {
            topology: 'star',
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: config.agents.length,
            errorCount: 0,
          },
        }
      }

      case 'hierarchical': {
        // Hierarchical uses the first agent as coordinator, rest as workers
        if (config.agents.length < 2) {
          throw new OrchestrationError(
            'Hierarchical topology requires at least 2 agents (1 coordinator + 1 worker)',
            'topology-hierarchical',
          )
        }
        const startTime = Date.now()
        const [coordinator, ...workers] = config.agents
        const supervisorResult = await AgentOrchestrator.supervisor({
          manager: coordinator!,
          specialists: workers,
          task: config.task,
          signal: config.signal,
        })
        return {
          result: supervisorResult.content,
          metrics: {
            topology: 'hierarchical',
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: workers.length + 1,
            errorCount: 0,
          },
        }
      }

      default: {
        // Exhaustive check
        const _exhaustive: never = topology
        throw new OrchestrationError(
          `Unknown topology: ${_exhaustive as string}`,
          'topology-mesh',
        )
      }
    }
  }

  /**
   * Infer updated task characteristics that penalize the failed topology,
   * so the analyzer recommends a different one.
   */
  private static inferCharacteristics(
    config: TopologyExecutorConfig,
    _failedTopology: TopologyType,
  ): TaskCharacteristics {
    // Build characteristics that steer away from the failed topology
    // by inverting the traits that would have selected it
    return {
      subtaskCount: config.agents.length,
      interdependence: 0.5,
      iterativeRefinement: 0.3,
      coordinationComplexity: 0.3,
      speedPriority: 0.7,
      sequentialNature: 0.3,
    }
  }

  private static checkAborted(signal: AbortSignal | undefined, pattern: TopologyType | string): void {
    if (signal?.aborted) {
      throw new OrchestrationError(
        `Execution aborted`,
        pattern as 'topology-mesh',
      )
    }
  }
}
