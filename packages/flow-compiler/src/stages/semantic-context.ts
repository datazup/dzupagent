import type {
  AsyncToolResolver,
  ResolvedTool,
  ToolResolver,
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
  toolResolver: ToolResolver | AsyncToolResolver
  personaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  suggestionDistance: number
  getAvailable: () => string[]
  missingPersonaResolverEmitted: boolean
  target: 'codev-runtime' | undefined
}
