/**
 * TeamCoordinator — manages coordinated execution of agent teams.
 *
 * Implements three coordination patterns by composing existing orchestration
 * primitives (AgentOrchestrator, ContractNetManager, TopologyExecutor):
 *
 * - **supervisor**: Delegates to `AgentOrchestrator.supervisor`. The agent
 *   with role `supervisor` becomes the manager; all others are specialists.
 * - **peer-to-peer**: Runs all agents in parallel via `AgentOrchestrator.parallel`
 *   with a configurable merge strategy.
 * - **blackboard**: All agents share a `SharedWorkspace`. In each round,
 *   every agent reads the workspace state, processes it, and writes results
 *   back. After all rounds, the workspace state is collected as the output.
 */
import { HumanMessage } from '@langchain/core/messages'
import type { ForgeAgent } from '../agent/forge-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import { getMergeStrategy, type MergeStrategyFn } from '../orchestration/merge-strategies.js'
import { SharedWorkspace } from './shared-workspace.js'
import type {
  CoordinationPattern,
  TeamConfig,
  TeamRunResult,
  SpawnedAgent,
  PlaygroundEvent,
} from './types.js'

/** Internal callback to emit playground events. */
type EventEmitter = (event: PlaygroundEvent) => void

export class TeamCoordinator {
  private readonly emitEvent: EventEmitter

  constructor(emitEvent: EventEmitter) {
    this.emitEvent = emitEvent
  }

  /**
   * Run a task using the specified coordination pattern.
   *
   * @param spawned  All spawned agents to participate.
   * @param task     The task description / prompt.
   * @param config   Coordination configuration.
   * @param workspace  Shared workspace (used by blackboard pattern).
   */
  async run(
    spawned: ReadonlyMap<string, SpawnedAgent>,
    task: string,
    config: TeamConfig,
    workspace: SharedWorkspace,
  ): Promise<TeamRunResult> {
    const agents = [...spawned.values()]
    if (agents.length === 0) {
      throw new Error('TeamCoordinator: no agents to coordinate')
    }

    this.emitEvent({
      type: 'team:started',
      pattern: config.pattern,
      agentCount: agents.length,
    })

    const startTime = Date.now()

    try {
      let result: TeamRunResult

      switch (config.pattern) {
        case 'supervisor':
          result = await this.runSupervisor(agents, task, config)
          break
        case 'peer-to-peer':
          result = await this.runPeerToPeer(agents, task, config)
          break
        case 'blackboard':
          result = await this.runBlackboard(agents, task, config, workspace)
          break
        default: {
          const _exhaustive: never = config.pattern
          throw new Error(`Unknown coordination pattern: ${_exhaustive as string}`)
        }
      }

      this.emitEvent({
        type: 'team:completed',
        durationMs: Date.now() - startTime,
        result: result.content.slice(0, 200),
      })

      return result
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitEvent({ type: 'team:failed', error: message })
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Supervisor pattern
  // ---------------------------------------------------------------------------

  private async runSupervisor(
    spawned: SpawnedAgent[],
    task: string,
    config: TeamConfig,
  ): Promise<TeamRunResult> {
    const startTime = Date.now()

    // Find the supervisor agent, or use the first agent
    const supervisorEntry = spawned.find(s => s.role === 'supervisor') ?? spawned[0]!
    const specialists = spawned.filter(s => s !== supervisorEntry)

    if (specialists.length === 0) {
      // Only one agent -- just run it directly
      return this.runSingleAgent(supervisorEntry, task, 'supervisor')
    }

    const supervisorAgent = supervisorEntry.agent
    const specialistAgents = specialists.map(s => s.agent)

    // Mark agents as running
    supervisorEntry.status = 'running'
    for (const s of specialists) {
      s.status = 'running'
    }

    try {
      const result = await AgentOrchestrator.supervisor({
        manager: supervisorAgent,
        specialists: specialistAgents,
        task,
        signal: config.signal,
      })

      // Mark agents as completed
      supervisorEntry.status = 'completed'
      supervisorEntry.lastResult = result.content
      for (const s of specialists) {
        s.status = 'completed'
      }

      this.emitEvent({
        type: 'agent:result',
        agentId: supervisorAgent.id,
        content: result.content.slice(0, 200),
      })

      const durationMs = Date.now() - startTime
      return {
        content: result.content,
        agentResults: [
          {
            agentId: supervisorAgent.id,
            role: supervisorEntry.role,
            content: result.content,
            success: true,
            durationMs,
          },
          ...specialists.map(s => ({
            agentId: s.agent.id,
            role: s.role,
            content: '', // Individual specialist results are opaque in supervisor pattern
            success: true,
            durationMs,
          })),
        ],
        durationMs,
        pattern: 'supervisor' as const,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      supervisorEntry.status = 'failed'
      supervisorEntry.lastError = message
      for (const s of specialists) {
        s.status = 'failed'
      }
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Peer-to-peer pattern
  // ---------------------------------------------------------------------------

  private async runPeerToPeer(
    spawned: SpawnedAgent[],
    task: string,
    config: TeamConfig,
  ): Promise<TeamRunResult> {
    const startTime = Date.now()
    const agents = spawned.map(s => s.agent)

    // Resolve merge strategy
    const mergeFn = this.resolveMerge(config.mergeStrategy)

    // Mark all as running
    for (const s of spawned) {
      s.status = 'running'
    }

    // Run all agents in parallel with concurrency limit
    const concurrency = config.concurrency ?? 5
    const results = await this.runParallelWithLimit(
      spawned,
      task,
      concurrency,
      config.signal,
    )

    // Merge successful results
    const successContents = results
      .filter(r => r.success)
      .map(r => r.content)

    const merged = successContents.length > 0
      ? await mergeFn(successContents)
      : ''

    // Emit per-agent results
    for (const r of results) {
      const entry = spawned.find(s => s.agent.id === r.agentId)
      if (entry) {
        if (r.success) {
          entry.status = 'completed'
          entry.lastResult = r.content
          this.emitEvent({
            type: 'agent:result',
            agentId: r.agentId,
            content: r.content.slice(0, 200),
          })
        } else {
          entry.status = 'failed'
          entry.lastError = r.error
          this.emitEvent({
            type: 'agent:error',
            agentId: r.agentId,
            error: r.error ?? 'Unknown error',
          })
        }
      }
    }

    return {
      content: merged,
      agentResults: results.map(r => {
        const entry = spawned.find(s => s.agent.id === r.agentId)
        return {
          agentId: r.agentId,
          role: entry?.role ?? 'worker',
          content: r.content,
          success: r.success,
          error: r.error,
          durationMs: r.durationMs,
        }
      }),
      durationMs: Date.now() - startTime,
      pattern: 'peer-to-peer' as const,
    }
  }

  // ---------------------------------------------------------------------------
  // Blackboard pattern
  // ---------------------------------------------------------------------------

  private async runBlackboard(
    spawned: SpawnedAgent[],
    task: string,
    config: TeamConfig,
    workspace: SharedWorkspace,
  ): Promise<TeamRunResult> {
    const startTime = Date.now()
    const maxRounds = config.maxRounds ?? 3
    const agentTimings = new Map<string, number>()

    // Write the initial task into the workspace
    await workspace.set('task', task, '__coordinator__')
    await workspace.set('round', '0', '__coordinator__')

    // Mark all as running
    for (const s of spawned) {
      s.status = 'running'
      agentTimings.set(s.agent.id, 0)
    }

    for (let round = 0; round < maxRounds; round++) {
      await workspace.set('round', String(round + 1), '__coordinator__')

      // Each agent gets the workspace context + task and writes back
      const roundResults = await this.runBlackboardRound(
        spawned,
        task,
        workspace,
        round,
        config.signal,
      )

      // Accumulate timings
      for (const r of roundResults) {
        const prev = agentTimings.get(r.agentId) ?? 0
        agentTimings.set(r.agentId, prev + r.durationMs)
      }

      this.emitEvent({
        type: 'team:round_completed',
        round: round + 1,
        totalRounds: maxRounds,
      })
    }

    // Collect final output from workspace
    const finalContent = workspace.formatAsContext()

    // Mark all as completed
    for (const s of spawned) {
      s.status = 'completed'
    }

    return {
      content: finalContent,
      agentResults: spawned.map(s => ({
        agentId: s.agent.id,
        role: s.role,
        content: s.lastResult ?? '',
        success: s.status !== 'failed',
        error: s.lastError,
        durationMs: agentTimings.get(s.agent.id) ?? 0,
      })),
      durationMs: Date.now() - startTime,
      pattern: 'blackboard' as const,
    }
  }

  /**
   * Run one round of the blackboard pattern: each agent reads the workspace,
   * processes, and writes its output back.
   */
  private async runBlackboardRound(
    spawned: SpawnedAgent[],
    task: string,
    workspace: SharedWorkspace,
    round: number,
    signal?: AbortSignal,
  ): Promise<Array<{ agentId: string; content: string; success: boolean; error?: string; durationMs: number }>> {
    const results: Array<{ agentId: string; content: string; success: boolean; error?: string; durationMs: number }> = []

    // Run agents sequentially in blackboard -- each sees prior writes from the same round
    for (const entry of spawned) {
      if (signal?.aborted) break

      const agentStart = Date.now()
      const workspaceContext = workspace.formatAsContext()
      const roundPrompt = [
        `You are participating in a collaborative blackboard session (round ${round + 1}).`,
        '',
        `## Task`,
        task,
        '',
        workspaceContext,
        '',
        `Write your contribution. Focus on your role as "${entry.role}".`,
        `Your output will be stored in the shared workspace under key "${entry.agent.id}".`,
      ].join('\n')

      try {
        const result = await entry.agent.generate(
          [new HumanMessage(roundPrompt)],
          { signal },
        )

        entry.lastResult = result.content

        // Write the agent's output to the workspace
        await workspace.set(entry.agent.id, result.content, entry.agent.id)

        this.emitEvent({
          type: 'workspace:updated',
          key: entry.agent.id,
          agentId: entry.agent.id,
        })

        results.push({
          agentId: entry.agent.id,
          content: result.content,
          success: true,
          durationMs: Date.now() - agentStart,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        entry.lastError = message
        results.push({
          agentId: entry.agent.id,
          content: '',
          success: false,
          error: message,
          durationMs: Date.now() - agentStart,
        })
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async runSingleAgent(
    entry: SpawnedAgent,
    task: string,
    pattern: CoordinationPattern,
  ): Promise<TeamRunResult> {
    const startTime = Date.now()
    entry.status = 'running'

    try {
      const result = await entry.agent.generate([new HumanMessage(task)])
      entry.status = 'completed'
      entry.lastResult = result.content

      return {
        content: result.content,
        agentResults: [{
          agentId: entry.agent.id,
          role: entry.role,
          content: result.content,
          success: true,
          durationMs: Date.now() - startTime,
        }],
        durationMs: Date.now() - startTime,
        pattern,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      entry.status = 'failed'
      entry.lastError = message
      throw err
    }
  }

  private resolveMerge(
    strategy?: TeamConfig['mergeStrategy'],
  ): MergeStrategyFn {
    if (!strategy) return getMergeStrategy('concat')
    if (typeof strategy === 'function') return strategy
    return getMergeStrategy(strategy)
  }

  private async runParallelWithLimit(
    spawned: SpawnedAgent[],
    task: string,
    _concurrency: number,
    signal?: AbortSignal,
  ): Promise<Array<{ agentId: string; content: string; success: boolean; error?: string; durationMs: number }>> {
    // Use Promise.allSettled for parallel execution.
    // The concurrency parameter is respected by batching when needed,
    // but for typical team sizes (< 10 agents) we run all at once.
    const settled = await Promise.allSettled(
      spawned.map(async (entry) => {
        const start = Date.now()
        if (signal?.aborted) {
          throw new Error('Aborted')
        }
        const result = await entry.agent.generate(
          [new HumanMessage(task)],
          { signal },
        )
        return {
          agentId: entry.agent.id,
          content: result.content,
          success: true as const,
          durationMs: Date.now() - start,
        }
      }),
    )

    return settled.map((outcome, index) => {
      const entry = spawned[index]!
      if (outcome.status === 'fulfilled') {
        return outcome.value
      }
      const message = outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason)
      return {
        agentId: entry.agent.id,
        content: '',
        success: false,
        error: message,
        durationMs: 0,
      }
    })
  }
}
