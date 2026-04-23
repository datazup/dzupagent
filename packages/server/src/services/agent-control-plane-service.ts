import type {
  AgentExecutionSpec,
  AgentExecutionSpecStore,
  AgentRegistry,
  RegisteredAgent,
} from '@dzupagent/core'

export interface AgentControlPlaneServiceConfig {
  agentStore: AgentExecutionSpecStore
  registry?: AgentRegistry
}

/**
 * Owns the current projection policy from control-plane entities to a locally
 * executable runtime spec.
 */
export class AgentControlPlaneService {
  private readonly agentStore: AgentExecutionSpecStore
  private readonly registry?: AgentRegistry

  constructor(config: AgentControlPlaneServiceConfig) {
    this.agentStore = config.agentStore
    this.registry = config.registry
  }

  async resolveExecutableAgent(agentId: string): Promise<AgentExecutionSpec | null> {
    const directSpec = await this.getActiveExecutionSpec(agentId)
    if (directSpec) return directSpec

    if (!this.registry) return null

    const registeredAgent = await this.registry.getAgent(agentId)
    if (!registeredAgent) return null

    const projectedExecutionSpecId = this.getProjectedExecutionSpecId(registeredAgent)
    if (!projectedExecutionSpecId) return null

    return this.getActiveExecutionSpec(projectedExecutionSpecId)
  }

  private async getActiveExecutionSpec(agentId: string): Promise<AgentExecutionSpec | null> {
    const spec = await this.agentStore.get(agentId)
    if (!spec || spec.active === false) return null
    return spec
  }

  private getProjectedExecutionSpecId(registeredAgent: RegisteredAgent): string | null {
    const metadata = registeredAgent.metadata
    if (!metadata) return null

    const executionSpecId = metadata['executionSpecId']
    if (typeof executionSpecId === 'string' && executionSpecId.length > 0) return executionSpecId

    const agentDefinitionId = metadata['agentDefinitionId']
    if (typeof agentDefinitionId === 'string' && agentDefinitionId.length > 0) return agentDefinitionId

    const localAgentId = metadata['localAgentId']
    if (typeof localAgentId === 'string' && localAgentId.length > 0) return localAgentId

    return null
  }
}
