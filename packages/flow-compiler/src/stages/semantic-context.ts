import type {
  AsyncToolResolver,
  AsyncToolsetResolver,
  ResolvedTool,
  ToolResolver,
  ToolsetResolver,
  ValidationError,
} from '@dzupagent/flow-ast'

import type { ProfileRegistry, ResolvedProfile } from '../profile-registry.js'
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
  /**
   * Map from agent node path → the profile ref that was flattened plus the
   * resolved snapshot. Populated by the profile resolver; exposed for
   * observability and tests. AST itself is mutated in-place: after this
   * stage the agent node carries the flattened model/provider/instructions/
   * toolset/policy and `node.profile` is deleted.
   */
  expandedAgentProfiles: Map<string, { ref: string; resolved: ResolvedProfile }>
  toolResolver: ToolResolver | AsyncToolResolver
  toolsetResolver: ToolsetResolver | AsyncToolsetResolver | undefined
  personaResolver: PersonaResolver | AsyncPersonaResolver | undefined
  /**
   * Optional compile-time profile registry. When absent, agent.profile
   * references are left intact and a one-time MISSING_PROFILE_REGISTRY
   * warning is recorded.
   */
  profileRegistry: ProfileRegistry | undefined
  suggestionDistance: number
  getAvailable: () => string[]
  /** Lazy enumeration of known toolset names for "did you mean…?" hints. */
  getAvailableToolsets: () => string[]
  missingPersonaResolverEmitted: boolean
  missingToolsetResolverEmitted: boolean
  missingProfileRegistryEmitted: boolean
  target: 'codev-runtime' | undefined
}
