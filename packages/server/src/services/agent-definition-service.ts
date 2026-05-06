import type { AgentExecutionSpec, AgentExecutionSpecStore } from '@dzupagent/core'

export interface AgentDefinitionServiceConfig {
  agentStore: AgentExecutionSpecStore
}

export interface ListAgentDefinitionsInput {
  active?: boolean
  limit?: number
  tenantId?: string
}

export interface CreateAgentDefinitionInput {
  id?: string
  name: string
  instructions: string
  modelTier: string
  description?: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  metadata?: Record<string, unknown>
  tenantId?: string
}

export interface UpdateAgentDefinitionInput {
  name?: string
  description?: string
  instructions?: string
  modelTier?: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  metadata?: Record<string, unknown>
}

export class AgentDefinitionService {
  private readonly agentStore: AgentExecutionSpecStore

  constructor(config: AgentDefinitionServiceConfig) {
    this.agentStore = config.agentStore
  }

  async list(input: ListAgentDefinitionsInput = {}): Promise<AgentExecutionSpec[]> {
    return this.agentStore.list({
      active: input.active,
      limit: Math.min(input.limit ?? 100, 200),
      tenantId: input.tenantId,
    })
  }

  async create(input: CreateAgentDefinitionInput): Promise<AgentExecutionSpec | null> {
    const id = input.id ?? crypto.randomUUID()

    await this.agentStore.save({
      id,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      modelTier: input.modelTier,
      tools: input.tools,
      guardrails: input.guardrails,
      approval: input.approval,
      metadata: input.metadata,
      tenantId: input.tenantId ?? 'default',
      active: true,
    })

    return this.agentStore.get(id)
  }

  async get(id: string, tenantId?: string): Promise<AgentExecutionSpec | null> {
    const agent = await this.agentStore.get(id)
    if (!agent) return null
    if (tenantId && (agent.tenantId ?? 'default') !== tenantId) return null
    return agent
  }

  async update(
    id: string,
    input: UpdateAgentDefinitionInput,
    tenantId?: string,
  ): Promise<AgentExecutionSpec | null> {
    const existing = await this.get(id, tenantId)
    if (!existing) return null

    await this.agentStore.save({
      ...existing,
      ...input,
      id,
      tenantId: existing.tenantId ?? tenantId ?? 'default',
    })

    return this.get(id, tenantId)
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const existing = await this.get(id, tenantId)
    if (!existing) return false

    await this.agentStore.delete(id)
    return true
  }
}
