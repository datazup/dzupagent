/**
 * AgentPlayground — a multi-agent workspace for spawning, coordinating,
 * and observing teams of DzipAgent instances.
 *
 * The playground is the user-facing API. It composes:
 * - `DzipAgent` instances (spawned with `spawn()` / `spawnTeam()`)
 * - `TeamCoordinator` for running coordinated tasks
 * - `SharedWorkspace` for inter-agent data sharing
 * - An async event stream for observability
 *
 * @example
 * ```ts
 * const playground = new AgentPlayground()
 *
 * playground.spawn({
 *   role: 'supervisor',
 *   instructions: 'You coordinate the team...',
 *   model: supervisorModel,
 * })
 *
 * playground.spawnTeam([
 *   { role: 'worker', instructions: 'You write code...', model },
 *   { role: 'reviewer', instructions: 'You review code...', model },
 * ])
 *
 * const result = await playground.runTeam('Build a REST API', {
 *   pattern: 'supervisor',
 * })
 *
 * // Observe events
 * for await (const event of playground.observe()) {
 *   console.log(event)
 * }
 *
 * await playground.shutdown()
 * ```
 */
import { DzipAgent } from '../agent/dzip-agent.js'
import { SharedWorkspace } from './shared-workspace.js'
import { TeamCoordinator } from './team-coordinator.js'
import type {
  AgentSpawnConfig,
  PlaygroundEvent,
  SpawnedAgent,
  TeamConfig,
  TeamRunResult,
} from './types.js'

/** Configuration for the playground itself. */
export interface PlaygroundConfig {
  /** Maximum number of agents that can be spawned (default: 20). */
  maxAgents?: number
}

/** Pending event listener waiting for events via observe(). */
interface PendingListener {
  resolve: (value: IteratorResult<PlaygroundEvent, undefined>) => void
}

export class AgentPlayground {
  private readonly agents = new Map<string, SpawnedAgent>()
  private readonly workspace: SharedWorkspace
  private readonly coordinator: TeamCoordinator
  private readonly maxAgents: number
  private readonly eventBuffer: PlaygroundEvent[] = []
  private readonly listeners: PendingListener[] = []
  private isShutdown = false
  private idCounter = 0

  constructor(config?: PlaygroundConfig) {
    this.maxAgents = config?.maxAgents ?? 20
    this.workspace = new SharedWorkspace()
    this.coordinator = new TeamCoordinator((event) => this.pushEvent(event))
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /**
   * Spawn a single agent into the playground.
   *
   * @returns The spawned agent's ID.
   */
  spawn(config: AgentSpawnConfig): string {
    this.ensureNotShutdown()

    if (this.agents.size >= this.maxAgents) {
      throw new Error(
        `AgentPlayground: maximum agent count (${this.maxAgents}) reached`,
      )
    }

    const id = config.id ?? this.generateId(config.role)

    if (this.agents.has(id)) {
      throw new Error(`AgentPlayground: agent "${id}" already exists`)
    }

    const { role, roleDescription, tags, id: _id, ...agentConfig } = config

    const agent = new DzipAgent({
      ...agentConfig,
      id,
      description: roleDescription ?? agentConfig.description ?? `${role} agent`,
    })

    const entry: SpawnedAgent = {
      agent,
      status: 'idle',
      role,
      tags: tags ?? [],
      spawnedAt: Date.now(),
    }

    this.agents.set(id, entry)
    this.pushEvent({ type: 'agent:spawned', agentId: id, role })

    return id
  }

  /**
   * Spawn multiple agents as a team.
   *
   * @returns Array of spawned agent IDs.
   */
  spawnTeam(configs: AgentSpawnConfig[]): string[] {
    return configs.map(c => this.spawn(c))
  }

  // ---------------------------------------------------------------------------
  // Team execution
  // ---------------------------------------------------------------------------

  /**
   * Run a coordinated task across all spawned agents.
   *
   * @param task    The task description / prompt.
   * @param config  Coordination settings (pattern, merge strategy, etc).
   */
  async runTeam(task: string, config: TeamConfig): Promise<TeamRunResult> {
    this.ensureNotShutdown()

    if (this.agents.size === 0) {
      throw new Error('AgentPlayground: no agents spawned')
    }

    return this.coordinator.run(this.agents, task, config, this.workspace)
  }

  /**
   * Run a task with a subset of agents filtered by tags.
   */
  async runTagged(
    tags: string[],
    task: string,
    config: TeamConfig,
  ): Promise<TeamRunResult> {
    this.ensureNotShutdown()

    const tagSet = new Set(tags)
    const filtered = new Map<string, SpawnedAgent>()

    for (const [id, entry] of this.agents) {
      if (entry.tags.some(t => tagSet.has(t))) {
        filtered.set(id, entry)
      }
    }

    if (filtered.size === 0) {
      throw new Error(
        `AgentPlayground: no agents match tags [${tags.join(', ')}]`,
      )
    }

    return this.coordinator.run(filtered, task, config, this.workspace)
  }

  // ---------------------------------------------------------------------------
  // Agent status & control
  // ---------------------------------------------------------------------------

  /**
   * Get the current status of a spawned agent.
   */
  getAgentStatus(agentId: string): SpawnedAgent | undefined {
    return this.agents.get(agentId)
  }

  /**
   * List all spawned agents.
   */
  listAgents(): ReadonlyMap<string, SpawnedAgent> {
    return this.agents
  }

  /**
   * Get the underlying DzipAgent instance by ID.
   */
  getAgent(agentId: string): DzipAgent | undefined {
    return this.agents.get(agentId)?.agent
  }

  /**
   * Remove a single agent from the playground.
   */
  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId)
    if (!entry) return false

    entry.status = 'shutdown'
    this.pushEvent({
      type: 'agent:status_changed',
      agentId,
      previous: entry.status,
      current: 'shutdown',
    })

    return this.agents.delete(agentId)
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a message to all agents by writing it to the shared workspace.
   * All agents can read the broadcast from the workspace on their next run.
   */
  async broadcast(message: string): Promise<void> {
    this.ensureNotShutdown()

    await this.workspace.set(
      '__broadcast__',
      message,
      '__playground__',
    )

    this.pushEvent({ type: 'broadcast:sent', message: message.slice(0, 200) })
  }

  // ---------------------------------------------------------------------------
  // Shared workspace access
  // ---------------------------------------------------------------------------

  /**
   * Get the shared workspace for direct manipulation.
   */
  getWorkspace(): SharedWorkspace {
    return this.workspace
  }

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  /**
   * Get an async iterable of all playground events.
   *
   * Events are buffered, so you will receive events that happened before
   * you started observing. The iterable completes when the playground
   * is shut down.
   *
   * @example
   * ```ts
   * for await (const event of playground.observe()) {
   *   console.log(event.type, event)
   * }
   * ```
   */
  observe(): AsyncIterable<PlaygroundEvent> & AsyncIterator<PlaygroundEvent, undefined> {
    const self = this

    const iterator: AsyncIterator<PlaygroundEvent, undefined> & AsyncIterable<PlaygroundEvent> = {
      next(): Promise<IteratorResult<PlaygroundEvent, undefined>> {
        // Drain buffered events first
        if (self.eventBuffer.length > 0) {
          const event = self.eventBuffer.shift()!
          return Promise.resolve({ value: event, done: false })
        }

        // If shut down and no more events, complete the iterator
        if (self.isShutdown) {
          return Promise.resolve({ value: undefined, done: true })
        }

        // Wait for the next event
        return new Promise<IteratorResult<PlaygroundEvent, undefined>>((resolve) => {
          self.listeners.push({ resolve })
        })
      },

      return(): Promise<IteratorResult<PlaygroundEvent, undefined>> {
        return Promise.resolve({ value: undefined, done: true })
      },

      [Symbol.asyncIterator]() {
        return iterator
      },
    }

    return iterator
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shut down the playground.
   *
   * Marks all agents as shutdown, clears the workspace, and completes
   * all active observers.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return
    this.isShutdown = true

    // Mark all agents as shutdown
    for (const [id, entry] of this.agents) {
      const prev = entry.status
      entry.status = 'shutdown'
      this.pushEvent({
        type: 'agent:status_changed',
        agentId: id,
        previous: prev,
        current: 'shutdown',
      })
    }

    this.workspace.clear()
    this.pushEvent({ type: 'playground:shutdown' })

    // Flush: resolve remaining listeners with done signal
    // (The shutdown event was pushed above, listeners will get it
    //  then the next call returns done: true)

    // Give a microtask for the shutdown event to be consumed
    await Promise.resolve()

    // Forcefully complete any remaining listeners
    for (const listener of this.listeners) {
      listener.resolve({ value: undefined, done: true })
    }
    this.listeners.length = 0
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private generateId(role: string): string {
    this.idCounter++
    return `${role}-${this.idCounter}`
  }

  private ensureNotShutdown(): void {
    if (this.isShutdown) {
      throw new Error('AgentPlayground: playground has been shut down')
    }
  }

  private pushEvent(event: PlaygroundEvent): void {
    // If there are waiting listeners, resolve the first one directly
    if (this.listeners.length > 0) {
      const listener = this.listeners.shift()!
      listener.resolve({ value: event, done: false })
      return
    }

    // Otherwise buffer the event
    this.eventBuffer.push(event)
  }
}
