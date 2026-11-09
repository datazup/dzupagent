/**
 * A2A v0.3.0 agent card, derived from the legacy {@link AgentCard}.
 * Served at `/.well-known/agent-card.json` (A2A-05-SERVER-V030-20261108-R1).
 *
 * Deliberately narrow: `securitySchemes`, streaming and push-notification
 * capabilities are not advertised because this server does not yet serve them
 * under their v0.3.0 names.
 */
import type { AgentCard } from './agent-card.js'

export interface AgentCardV030Skill {
  id: string
  name: string
  description: string
  tags: string[]
}

export interface AgentCardV030 {
  protocolVersion: '0.3.0'
  name: string
  description: string
  /** The JSON-RPC endpoint, not the site root. */
  url: string
  preferredTransport: 'JSONRPC'
  version: string
  capabilities: {
    streaming: false
    pushNotifications: false
    stateTransitionHistory: false
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentCardV030Skill[]
}

export function toAgentCardV030(card: AgentCard): AgentCardV030 {
  const source = card.skills ?? card.capabilities.map(({ name, description }) => ({ name, description }))
  return {
    protocolVersion: '0.3.0',
    name: card.name,
    description: card.description,
    url: `${card.url.replace(/\/+$/, '')}/a2a`,
    preferredTransport: 'JSONRPC',
    version: card.version,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: source.map(({ name, description }) => ({ id: name, name, description, tags: [] })),
  }
}
