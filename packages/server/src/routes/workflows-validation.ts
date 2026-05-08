/**
 * Validation helpers for workflow routes.
 */
import type { PersonaResolver, AsyncPersonaResolver } from '@dzupagent/flow-compiler'
import { createPersonaStoreResolver } from '../personas/persona-resolver.js'
import type { WorkflowRouteConfig } from './workflows-types.js'

export function resolveCompilePersonaResolver(
  compile: WorkflowRouteConfig['compile'],
): PersonaResolver | AsyncPersonaResolver | undefined {
  return compile?.personaResolver
    ?? (compile?.personaStore ? createPersonaStoreResolver(compile.personaStore) : undefined)
}
