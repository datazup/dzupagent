import { ForgeError } from '../errors/forge-error.js'
import type { RegisterAgentInput, RegisteredAgent } from './types.js'

export function assertValidRegistrationInput(input: RegisterAgentInput): void {
  if (!input.name || !input.description) {
    throw new ForgeError({
      code: 'REGISTRY_INVALID_INPUT',
      message: 'Agent name and description are required',
      recoverable: false,
    })
  }

  if (!input.capabilities || input.capabilities.length === 0) {
    throw new ForgeError({
      code: 'REGISTRY_INVALID_INPUT',
      message: 'At least one capability is required',
      recoverable: false,
    })
  }
}

export function getRegisteredAgentOrThrow(
  agents: ReadonlyMap<string, RegisteredAgent>,
  agentId: string,
): RegisteredAgent {
  const agent = agents.get(agentId)
  if (!agent) {
    throw new ForgeError({
      code: 'REGISTRY_AGENT_NOT_FOUND',
      message: `Agent not found: ${agentId}`,
      recoverable: false,
    })
  }
  return agent
}

export function createCardFetchFailedError(cardUrl: string): ForgeError {
  return new ForgeError({
    code: 'REGISTRY_CARD_FETCH_FAILED',
    message: `Cannot fetch agent card in InMemoryRegistry: ${cardUrl}`,
    recoverable: false,
    suggestion: 'Use a registry implementation that supports HTTP fetching, or register manually.',
  })
}
