import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  ResolvedTool,
  ToolResolver,
  ToolsetResolver,
  ValidationError,
} from '@dzupagent/flow-ast'

import type { AsyncPersonaResolver, PersonaResolver } from '../types.js'

/**
 * Mutable context threaded through the semantic AST walk. Sub-passes mutate
 * `errors` / `warnings` / `resolved` / `resolvedPersonas` directly so the
 * orchestrator can return them without a final merge step.
 */
export interface WalkContext {
  errors: ValidationError[]
  warnings: ValidationError[]
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  /**
   * Map from agent node path to the expanded tool refs (post toolset merge).
   * Populated by `resolveAgent` so callers/tests can introspect what the
   * compiler decided without re-reading the mutated AST.
   */
  expandedAgentTools: Map<string, readonly string[]>
  toolResolver: ToolResolver | AsyncToolResolver
  toolsetResolver: ToolsetResolver | AsyncToolsetResolver | undefined
  personaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  suggestionDistance: number
  getAvailable: () => string[]
  /** Lazy enumeration of known toolset names for "did you mean…?" hints. */
  getAvailableToolsets: () => string[]
  missingPersonaResolverEmitted: boolean
  missingToolsetResolverEmitted: boolean
  target: 'codev-runtime' | undefined
}
