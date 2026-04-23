import type { DomainToolDefinition } from '../types.js'

/**
 * Executable wrapper around a {@link DomainToolDefinition}.
 *
 * The registry stores pure metadata (schemas, permissions). The execution map
 * returned alongside it carries the runtime behaviour. Callers look up a tool
 * by name in the registry, then dispatch execution via the parallel map.
 */
export interface ExecutableDomainTool<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>,
> {
  definition: DomainToolDefinition
  execute(input: TInput): Promise<TOutput>
}
