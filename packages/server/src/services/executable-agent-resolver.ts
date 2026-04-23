import type { AgentExecutionSpec, AgentExecutionSpecStore } from '@dzupagent/core'
import type { AgentControlPlaneService } from './agent-control-plane-service.js'

export interface ExecutableAgentResolver {
  resolve(agentId: string): Promise<AgentExecutionSpec | null>
}

/**
 * Compatibility-backed resolver that projects the current execution source of
 * truth from the execution-spec store. This gives runtime paths a dedicated
 * resolution boundary before registry-backed execution is introduced.
 */
export class AgentStoreExecutableAgentResolver implements ExecutableAgentResolver {
  constructor(private readonly agentStore: AgentExecutionSpecStore) {}

  async resolve(agentId: string): Promise<AgentExecutionSpec | null> {
    return this.agentStore.get(agentId)
  }
}

export class ControlPlaneExecutableAgentResolver implements ExecutableAgentResolver {
  constructor(private readonly controlPlaneService: AgentControlPlaneService) {}

  async resolve(agentId: string): Promise<AgentExecutionSpec | null> {
    return this.controlPlaneService.resolveExecutableAgent(agentId)
  }
}
