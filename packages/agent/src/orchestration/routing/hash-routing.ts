import type { AgentSpec, AgentTask, RoutingDecision, RoutingPolicy, HashRoutingConfig } from '../routing-policy-types.js'

/** Simple djb2-style hash for consistent routing */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
    hash = hash >>> 0 // keep as unsigned 32-bit
  }
  return hash
}

export class HashRouting implements RoutingPolicy {
  private readonly hashKey: string

  constructor(config: HashRoutingConfig = {}) {
    this.hashKey = config.hashKey ?? 'taskId'
  }

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    if (candidates.length === 0) {
      return { selected: [], reason: 'No candidates available', strategy: 'hash' }
    }
    const key = this.hashKey === 'taskId'
      ? task.taskId
      : this.hashKey === 'content'
        ? task.content
        : (task.metadata?.[this.hashKey] as string | undefined) ?? task.taskId

    const index = hashString(key) % candidates.length
    const agent = candidates[index]!
    return {
      selected: [agent],
      reason: `Hash routing: key '${key}' → index ${index} → agent '${agent.id}'`,
      strategy: 'hash',
    }
  }
}
