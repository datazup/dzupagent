import type {
  ActionNode,
  AsyncToolResolver,
  FlowNode,
  ResolvedTool,
  ToolResolver,
  ValidationError,
} from '@dzupagent/flow-ast'
import { validateFlowToolSecurityPolicy } from '@dzupagent/flow-ast'

import { topSuggestions } from './semantic-condition.js'
import { resolvePersonaRef } from './semantic-persona-resolver.js'
import type { WalkContext } from './semantic-context.js'

/** Sentinel returned by {@link resolveToolRef} when the resolver threw. */
const INFRA_FAILURE = Symbol('infra-failure')

/**
 * Resolve an `ActionNode`'s tool reference (and optional persona ref).
 *
 * STAGE 2 already complains about missing/empty toolRef. We still try to
 * resolve when present so STAGE 3 stays focused on resolution outcomes.
 */
export async function resolveAction(
  node: ActionNode,
  path: string,
  ctx: WalkContext,
): Promise<void> {
  if (typeof node.toolRef === 'string' && node.toolRef.length > 0) {
    // codev-runtime target: treat any `codev.*` ref as externally resolved.
    // The runtime will wire these at execution time, so we never emit
    // UNRESOLVED_TOOL_REF for them when compiling for this target.
    if (ctx.target === 'codev-runtime' && node.toolRef.startsWith('codev.')) {
      ctx.resolved.set(path, {
        ref: node.toolRef,
        kind: 'skill',
        inputSchema: {},
        handle: {
          ref: node.toolRef,
          external: true,
          target: 'codev-runtime',
        },
      })
    } else {
      const hit = await resolveToolRef(ctx.toolResolver, node.toolRef, node.type, path, ctx.errors)
      if (hit === INFRA_FAILURE) {
        // Infra error already pushed by resolveToolRef; do NOT also emit
        // UNRESOLVED_TOOL_REF — infra failure supersedes unresolved-ref
        // messaging on the same node.
      } else if (hit !== null) {
        ctx.resolved.set(path, hit)
        validateResolvedToolPolicy(hit, node.type, path, ctx)
      } else {
        ctx.errors.push(unresolvedToolError(node.type, path, node.toolRef, ctx))
      }
    }
  }

  if (node.personaRef !== undefined) {
    await resolvePersonaRef(node.type, path, node.personaRef, ctx)
  }
}

function validateResolvedToolPolicy(
  tool: ResolvedTool,
  nodeType: FlowNode['type'],
  nodePath: string,
  ctx: WalkContext,
): void {
  if (tool.securityPolicy === undefined) {
    if (ctx.admissionProfile === 'unattended') {
      ctx.errors.push({
        nodeType,
        nodePath: `${nodePath}.toolRef`,
        code: 'TOOL_SECURITY_POLICY_REQUIRED',
        category: 'policy',
        message: `Unattended tool "${tool.ref}" requires a reviewed classification, credential, effect, output, and evidence policy.`,
      })
    }
    return
  }
  for (const issue of validateFlowToolSecurityPolicy(tool.securityPolicy)) {
    ctx.errors.push({
      nodeType,
      nodePath: `${nodePath}.toolRef`,
      code: 'INVALID_TOOL_SECURITY_POLICY',
      category: 'policy',
      message: `Tool "${tool.ref}" has an invalid security policy: ${issue}.`,
    })
  }
}

/**
 * Duck-typed dispatch: sync resolvers return `ResolvedTool | null`; async
 * resolvers return `Promise<ResolvedTool | null>`. Rejection surfaces as a
 * `RESOLVER_INFRA_ERROR` so the stage boundary never throws, and this
 * function returns the {@link INFRA_FAILURE} sentinel so the caller knows
 * not to layer an UNRESOLVED_TOOL_REF on top.
 */
async function resolveToolRef(
  resolver: ToolResolver | AsyncToolResolver,
  ref: string,
  nodeType: FlowNode['type'],
  nodePath: string,
  errors: ValidationError[],
): Promise<ResolvedTool | null | typeof INFRA_FAILURE> {
  try {
    const maybe = resolver.resolve(ref)
    return maybe instanceof Promise ? await maybe : maybe
  } catch (err) {
    errors.push({
      nodeType,
      nodePath,
      code: 'RESOLVER_INFRA_ERROR',
      category: 'internal',
      message: err instanceof Error ? err.message : String(err),
    })
    return INFRA_FAILURE
  }
}

function unresolvedToolError(
  nodeType: FlowNode['type'],
  path: string,
  ref: string,
  ctx: WalkContext,
): ValidationError {
  return {
    nodeType,
    nodePath: path,
    code: 'UNRESOLVED_TOOL_REF',
    category: 'registry',
    message: buildToolErrorMessage(ref, ctx),
  }
}

function buildToolErrorMessage(ref: string, ctx: WalkContext): string {
  const base = `Unresolved tool reference: "${ref}".`
  if (ctx.suggestionDistance <= 0) return base
  const suggestions = topSuggestions(ref, ctx.getAvailable(), ctx.suggestionDistance)
  if (suggestions.length === 0) return base
  return `${base} Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
}
