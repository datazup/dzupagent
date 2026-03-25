/**
 * Error class for orchestration pattern failures.
 */
export type OrchestrationPattern =
  | 'supervisor'
  | 'sequential'
  | 'parallel'
  | 'debate'
  | 'contract-net'
  | 'map-reduce'
  | 'topology-mesh'
  | 'topology-ring'
  | 'topology-hierarchical'
  | 'topology-pipeline'
  | 'topology-star'
  | 'playground'

export class OrchestrationError extends Error {
  override readonly name = 'OrchestrationError'

  constructor(
    message: string,
    public readonly pattern: OrchestrationPattern,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message)
  }
}
