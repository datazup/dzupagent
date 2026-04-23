import type { AdapterProviderId } from './provider.js'

/** Task descriptor used by the router to decide which adapter to use */
export interface TaskDescriptor {
  prompt: string
  tags: string[]
  budgetConstraint?: 'low' | 'medium' | 'high' | 'unlimited' | undefined
  preferredProvider?: AdapterProviderId | undefined
  requiresExecution?: boolean | undefined
  requiresReasoning?: boolean | undefined
  workingDirectory?: string | undefined
}

/** Decision made by the task router */
export interface RoutingDecision {
  provider: AdapterProviderId | 'auto'
  reason: string
  fallbackProviders?: AdapterProviderId[] | undefined
  confidence: number
}

/** Pluggable strategy for routing tasks to adapters */
export interface TaskRoutingStrategy {
  readonly name: string
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision
}
