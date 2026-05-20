import type {
  AgentNode,
  AsyncToolsetResolver,
  ToolsetResolver,
  ValidationError,
} from '@dzupagent/flow-ast'

import { topSuggestions } from './semantic-condition.js'
import type { WalkContext } from './semantic-context.js'

const INFRA_FAILURE = Symbol('toolset-infra-failure')

/**
 * Resolve an `AgentNode`'s `toolset` reference and merge the expanded refs
 * with any inline `tools[]` already on the node. Mutates `node.tools` so the
 * lowering stage and downstream runtimes see the canonical post-expansion
 * list. Idempotent: inline tools are preserved and de-duplicated.
 *
 * No-ops when the node has no `toolset` field. Emits
 * `UNRESOLVED_TOOLSET_REF` when the resolver returns `null` for a declared
 * toolset name, `MISSING_TOOLSET_RESOLVER` (once per compile) when a node
 * declares a toolset but no resolver was supplied, and
 * `INVALID_TOOLSET_RESOLVER_RESULT` when the resolver returns a non-string
 * entry.
 */
export async function resolveAgent(
  node: AgentNode,
  path: string,
  ctx: WalkContext,
): Promise<void> {
  if (typeof node.toolset !== 'string' || node.toolset.length === 0) {
    return
  }

  if (ctx.toolsetResolver === undefined) {
    if (!ctx.missingToolsetResolverEmitted) {
      ctx.errors.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_TOOLSET_RESOLVER',
        category: 'registry',
        message:
          `agent node declares toolset "${node.toolset}" but no toolsetResolver ` +
          'was supplied to the compiler. Pass `toolsetResolver` in CompilerOptions.',
      })
      ctx.missingToolsetResolverEmitted = true
    }
    return
  }

  const expanded = await resolveToolsetRef(
    ctx.toolsetResolver,
    node.toolset,
    path,
    ctx.errors,
  )
  if (expanded === INFRA_FAILURE) {
    // Infra error already pushed.
    return
  }
  if (expanded === null) {
    ctx.errors.push(unresolvedToolsetError(path, node.toolset, ctx))
    return
  }

  const sanitized = sanitizeExpansion(expanded, node.toolset, path, ctx.errors)
  if (sanitized === null) {
    return
  }

  const inline = Array.isArray(node.tools) ? node.tools : []
  const merged = mergeTools(inline, sanitized)
  node.tools = merged
  ctx.expandedAgentTools.set(path, merged)
}

async function resolveToolsetRef(
  resolver: ToolsetResolver | AsyncToolsetResolver,
  ref: string,
  nodePath: string,
  errors: ValidationError[],
): Promise<readonly string[] | null | typeof INFRA_FAILURE> {
  try {
    const maybe = resolver.resolve(ref)
    return maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    errors.push({
      nodeType: 'agent',
      nodePath,
      code: 'TOOLSET_RESOLVER_INFRA_ERROR',
      category: 'internal',
      message: err instanceof Error ? err.message : String(err),
    })
    return INFRA_FAILURE
  }
}

function sanitizeExpansion(
  raw: readonly string[],
  toolsetRef: string,
  nodePath: string,
  errors: ValidationError[],
): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push({
      nodeType: 'agent',
      nodePath,
      code: 'INVALID_TOOLSET_RESOLVER_RESULT',
      category: 'registry',
      message:
        `toolset "${toolsetRef}" resolver returned a non-array result; ` +
        `expected readonly string[].`,
    })
    return null
  }
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push({
        nodeType: 'agent',
        nodePath,
        code: 'INVALID_TOOLSET_RESOLVER_RESULT',
        category: 'registry',
        message:
          `toolset "${toolsetRef}" expansion entry [${i}] must be a non-empty string.`,
      })
      return null
    }
    out.push(entry)
  }
  return out
}

function mergeTools(inline: readonly string[], expanded: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  // Inline first — explicit author intent wins for ordering.
  for (const t of inline) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  for (const t of expanded) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function unresolvedToolsetError(
  path: string,
  ref: string,
  ctx: WalkContext,
): ValidationError {
  return {
    nodeType: 'agent',
    nodePath: path,
    code: 'UNRESOLVED_TOOLSET_REF',
    category: 'registry',
    message: buildToolsetErrorMessage(ref, ctx),
  }
}

function buildToolsetErrorMessage(ref: string, ctx: WalkContext): string {
  const base = `Unresolved toolset reference: "${ref}".`
  if (ctx.suggestionDistance <= 0) return base
  const suggestions = topSuggestions(ref, ctx.getAvailableToolsets(), ctx.suggestionDistance)
  if (suggestions.length === 0) return base
  return `${base} Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
}
