import type { FlowNode, PersonaNode } from '@dzupagent/flow-ast'

import type { AsyncPersonaResolver, PersonaResolver } from '../types.js'

import { topSuggestions } from './semantic-condition.js'
import type { WalkContext } from './semantic-walk.js'

const ROOT_PATH = 'root'
const DEFAULT_SUGGESTION_DISTANCE = 3

/**
 * Resolve a `PersonaNode`'s persona id, delegating to the shared persona-ref
 * resolution path so error/diagnostic shape matches `ActionNode.personaRef`.
 */
export async function resolvePersonaNode(
  node: PersonaNode,
  path: string,
  ctx: WalkContext,
): Promise<void> {
  if (typeof node.personaId === 'string' && node.personaId.length > 0) {
    await resolvePersonaRef(node.type, path, node.personaId, ctx)
  }
}

/**
 * Resolve a single persona reference. Aggregates `UNRESOLVED_PERSONA_REF` /
 * `RESOLVER_INFRA_ERROR` into `ctx.errors` and records successful resolutions
 * in `ctx.resolvedPersonas`.
 *
 * If no `personaResolver` was provided, emits a single root-level
 * `UNRESOLVED_PERSONA_REF` for the entire flow (deduped via
 * `ctx.missingPersonaResolverEmitted`) — callers compiling without a persona
 * registry get one diagnostic, not one per persona reference.
 */
export async function resolvePersonaRef(
  nodeType: FlowNode['type'],
  path: string,
  ref: string,
  ctx: WalkContext,
): Promise<void> {
  if (ctx.personaResolver === undefined) {
    if (!ctx.missingPersonaResolverEmitted) {
      ctx.missingPersonaResolverEmitted = true
      ctx.errors.push({
        nodeType,
        nodePath: ROOT_PATH,
        code: 'UNRESOLVED_PERSONA_REF',
        category: 'resolution',
        message: 'personaResolver not provided',
      })
    }
    return
  }

  let ok: boolean
  try {
    const maybe = ctx.personaResolver.resolve(ref)
    ok = maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    ctx.errors.push({
      nodeType,
      nodePath: path,
      code: 'RESOLVER_INFRA_ERROR',
      category: 'internal',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (ok) {
    ctx.resolvedPersonas.set(path, ref)
    return
  }

  ctx.errors.push({
    nodeType,
    nodePath: path,
    code: 'UNRESOLVED_PERSONA_REF',
    category: 'resolution',
    message: buildPersonaErrorMessage(ref, ctx.personaResolver),
  })
}

function buildPersonaErrorMessage(
  ref: string,
  resolver: PersonaResolver | AsyncPersonaResolver,
): string {
  const base = `Unresolved persona reference: "${ref}".`
  // PersonaResolver.list() is optional and not declared on the interface. If
  // an implementation exposes it, surface "did you mean" candidates as a
  // courtesy. Treat any non-function value as absent.
  const maybeList = (resolver as unknown as { list?: () => string[] }).list
  if (typeof maybeList !== 'function') return base
  const candidates = maybeList.call(resolver)
  if (!Array.isArray(candidates) || candidates.length === 0) return base
  const suggestions = topSuggestions(ref, candidates, DEFAULT_SUGGESTION_DISTANCE)
  if (suggestions.length === 0) return base
  return `${base} Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
}
