export interface AgentMessage {
  /** Sender agent ID */
  from: string
  /** Channel name */
  channel: string
  /** Message payload */
  payload: Record<string, unknown>
  /** Timestamp */
  timestamp: number
}

export type AgentMessageHandler = (message: AgentMessage) => void | Promise<void>

/**
 * Named message bus for peer-to-peer agent communication.
 * Agents can publish messages to named channels and subscribe to channels
 * they're interested in, enabling collaborative work without strict hierarchy.
 *
 * @example
 * ```ts
 * const bus = new AgentBus()
 *
 * // Agent B subscribes
 * bus.subscribe('code-changes', 'agent-b', (msg) => {
 *   console.log('Files changed:', msg.payload)
 * })
 *
 * // Agent A publishes
 * bus.publish('agent-a', 'code-changes', { files: ['auth.ts'] })
 * ```
 */
export class AgentBus {
  private subscriptions: Map<string, Map<string, AgentMessageHandler>> = new Map()
  private history: AgentMessage[] = []
  private maxHistory: number

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 100
  }

  /** Publish a message to a channel. Handlers run fire-and-forget; errors are caught. */
  publish(fromAgent: string, channel: string, payload: Record<string, unknown>): void {
    const message: AgentMessage = {
      from: fromAgent,
      channel,
      payload,
      timestamp: Date.now(),
    }

    this.history.push(message)
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory)
    }

    const channelSubs = this.subscriptions.get(channel)
    if (!channelSubs) return

    for (const handler of channelSubs.values()) {
      try {
        const result = handler(message)
        if (result && typeof result === 'object' && 'catch' in result) {
          ;(result as Promise<void>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            // eslint-disable-next-line no-console
            console.error(`[AgentBus] handler error on "${channel}": ${msg}`)
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[AgentBus] handler error on "${channel}": ${msg}`)
      }
    }
  }

  /** Subscribe an agent to a channel. Returns unsubscribe function. */
  subscribe(channel: string, agentId: string, handler: AgentMessageHandler): () => void {
    let channelSubs = this.subscriptions.get(channel)
    if (!channelSubs) {
      channelSubs = new Map()
      this.subscriptions.set(channel, channelSubs)
    }
    channelSubs.set(agentId, handler)
    return () => { this.unsubscribe(channel, agentId) }
  }

  /** Unsubscribe an agent from a channel. */
  unsubscribe(channel: string, agentId: string): void {
    const channelSubs = this.subscriptions.get(channel)
    if (!channelSubs) return
    channelSubs.delete(agentId)
    if (channelSubs.size === 0) {
      this.subscriptions.delete(channel)
    }
  }

  /** Unsubscribe an agent from all channels. */
  unsubscribeAll(agentId: string): void {
    for (const [channel, channelSubs] of this.subscriptions) {
      channelSubs.delete(agentId)
      if (channelSubs.size === 0) {
        this.subscriptions.delete(channel)
      }
    }
  }

  /** Get recent messages on a channel. */
  getHistory(channel: string, limit?: number): AgentMessage[] {
    const filtered = this.history.filter((m) => m.channel === channel)
    if (limit !== undefined && limit >= 0) {
      return filtered.slice(-limit)
    }
    return filtered
  }

  /** List all active channels (channels with at least one subscriber). */
  listChannels(): string[] {
    return [...this.subscriptions.keys()]
  }

  /** List subscriber agent IDs on a channel. */
  listSubscribers(channel: string): string[] {
    const channelSubs = this.subscriptions.get(channel)
    if (!channelSubs) return []
    return [...channelSubs.keys()]
  }
}
