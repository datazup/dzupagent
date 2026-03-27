/**
 * A2A Agent Card — JSON-LD document describing agent capabilities.
 * Served at `/.well-known/agent.json` for discovery by other agents.
 */

export interface AgentCapability {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentCard {
  name: string
  description: string
  url: string
  version: string
  capabilities: AgentCapability[]
  authentication?: { type: 'bearer' | 'api-key' | 'none' }
  skills?: Array<{ name: string; description: string }>
}

export interface AgentCardConfig {
  name: string
  description: string
  baseUrl: string
  version: string
  agents: Array<{
    name: string
    description: string
    inputSchema?: Record<string, unknown>
  }>
  authType?: 'bearer' | 'api-key' | 'none'
}

/**
 * Build an AgentCard from server configuration.
 *
 * Each entry in `config.agents` becomes an {@link AgentCapability} on the card.
 * The returned object is JSON-serializable and intended to be served verbatim
 * at `/.well-known/agent.json`.
 */
export function buildAgentCard(config: AgentCardConfig): AgentCard {
  const capabilities: AgentCapability[] = config.agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    inputSchema: agent.inputSchema ?? { type: 'object', properties: {} },
  }))

  const card: AgentCard = {
    name: config.name,
    description: config.description,
    url: config.baseUrl,
    version: config.version,
    capabilities,
  }

  if (config.authType) {
    card.authentication = { type: config.authType }
  }

  // Derive skills from agent names for discoverability
  card.skills = config.agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
  }))

  return card
}
