import type { AgentNode, ValidationError } from '@dzupagent/flow-ast'

import type {
  ProfileRegistry,
  ResolvedProfile,
  ResolvedProfilePolicy,
} from '../profile-registry.js'

import type { WalkContext } from './semantic-context.js'

/**
 * Stage 3 sub-pass — compile-time profile expansion.
 *
 * For every `agent` node with `profile` set:
 *   1. Look up via `profileRegistry.lookup(profileRef)`.
 *   2. If unresolved → emit `UNRESOLVED_PROFILE_REF` and leave the node
 *      untouched (the toolset/runtime stages will continue to validate the
 *      rest of the node).
 *   3. If resolved → backfill missing fields from the profile. Node fields
 *      always win.
 *   4. Strip `node.profile` from the AST so the lowered artifact and the
 *      runtime never see an unresolved ref.
 *
 * This sub-pass MUST run before {@link resolveAgent} (the toolset resolver)
 * so a profile-supplied `toolset` can be expanded by the same compile pass.
 *
 * The pass is synchronous by contract: profile registries are in-process
 * workspace defaults, mirroring the codev-app `InMemoryProfileRegistry`
 * shape. Returning a Promise from `lookup()` is not supported.
 */
export function resolveAgentProfile(
  node: AgentNode,
  path: string,
  ctx: WalkContext,
): void {
  if (typeof node.profile !== 'string' || node.profile.length === 0) {
    return
  }

  // No registry supplied → leave the profile ref in place. The runtime
  // safety net in codev-app's `agent-runtime-deps` will still attempt
  // backfill at run start; we don't fail compilation just because a
  // caller chose not to supply compile-time profiles. Emit a single
  // diagnostic so the situation is observable.
  if (ctx.profileRegistry === undefined) {
    if (!ctx.missingProfileRegistryEmitted) {
      ctx.warnings.push({
        nodeType: node.type,
        nodePath: path,
        code: 'MISSING_PROFILE_REGISTRY',
        category: 'registry',
        message:
          `agent node declares profile "${node.profile}" but no profileRegistry ` +
          'was supplied to the compiler. Profile fields will be resolved at ' +
          'runtime by the consuming application if it implements its own ' +
          'backfill path; otherwise the profile ref is effectively a no-op.',
      })
      ctx.missingProfileRegistryEmitted = true
    }
    return
  }

  let resolved: ResolvedProfile | undefined
  try {
    resolved = ctx.profileRegistry.lookup(node.profile)
  } catch (err) {
    ctx.errors.push({
      nodeType: 'agent',
      nodePath: path,
      code: 'PROFILE_RESOLVER_INFRA_ERROR',
      category: 'internal',
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (resolved === undefined) {
    ctx.errors.push(unresolvedProfileError(path, node.profile, ctx))
    return
  }

  if (!validateProfilePolicy(resolved.policy, path, node.profile, ctx)) {
    return
  }

  applyProfileToNode(node, resolved)
  ctx.expandedAgentProfiles.set(path, { ref: node.profile, resolved })

  // Strip the now-applied profile reference. After this point the AST is
  // profile-free; downstream stages and the runtime never see the ref.
  delete (node as Partial<AgentNode>).profile
}

/**
 * Apply profile defaults to an agent node in-place. Node fields always
 * win — the profile only fills gaps. Exported for direct test access.
 */
export function applyProfileToNode(
  node: AgentNode,
  profile: ResolvedProfile,
): void {
  if (node.model === undefined && profile.model !== undefined) {
    node.model = profile.model
  }
  if (node.provider === undefined && profile.provider !== undefined) {
    node.provider = profile.provider
  }
  // Match the codev-app convention: instructions backfill kicks in when the
  // node's instructions is the empty string. Parser requires the field to
  // exist but allows '' as an opt-in marker for profile-supplied default.
  if ((node.instructions === undefined || node.instructions === '') && profile.instructions !== undefined) {
    node.instructions = profile.instructions
  }
  if (node.toolset === undefined && profile.toolset !== undefined && profile.toolset.length > 0) {
    node.toolset = profile.toolset
  }
  if (profile.policy !== undefined) {
    node.policy = mergePolicy(node.policy, profile.policy)
  }
}

/**
 * Shallow-merge a node policy with a profile policy. Node fields win;
 * nested objects (`approval`, `audit`) are also shallow-merged with the
 * same precedence so a node `audit.captureDiffs=true` does not erase a
 * profile-supplied `audit.captureToolCalls=true`.
 */
function mergePolicy(
  nodePolicy: AgentNode['policy'] | undefined,
  profilePolicy: NonNullable<ResolvedProfile['policy']>,
): AgentNode['policy'] {
  const node = nodePolicy ?? {}
  const out: NonNullable<AgentNode['policy']> = { ...profilePolicy, ...node }

  if (profilePolicy.approval !== undefined || node.approval !== undefined) {
    out.approval = {
      ...(profilePolicy.approval ?? {}),
      ...(node.approval ?? {}),
    }
  }
  if (profilePolicy.audit !== undefined || node.audit !== undefined) {
    out.audit = {
      ...(profilePolicy.audit ?? {}),
      ...(node.audit ?? {}),
    }
  }
  return out
}

function validateProfilePolicy(
  policy: ResolvedProfilePolicy | undefined,
  path: string,
  ref: string,
  ctx: WalkContext,
): boolean {
  if (policy === undefined) return true

  let valid = true
  if (!validatePositiveFinitePolicyNumber(policy.timeoutMs, 'timeoutMs', path, ref, ctx)) {
    valid = false
  }
  if (!validatePositiveFinitePolicyNumber(policy.budgetCents, 'budgetCents', path, ref, ctx)) {
    valid = false
  }
  return valid
}

function validatePositiveFinitePolicyNumber(
  value: number | undefined,
  key: 'timeoutMs' | 'budgetCents',
  path: string,
  ref: string,
  ctx: WalkContext,
): boolean {
  if (value === undefined) return true
  if (!Number.isFinite(value)) {
    ctx.errors.push(invalidProfilePolicyError(path, ref, key, 'must be a finite number'))
    return false
  }
  if (value <= 0) {
    ctx.errors.push(invalidProfilePolicyError(path, ref, key, 'must be greater than 0'))
    return false
  }
  return true
}

function invalidProfilePolicyError(
  path: string,
  ref: string,
  key: 'timeoutMs' | 'budgetCents',
  message: string,
): ValidationError {
  return {
    nodeType: 'agent',
    nodePath: `${path}.policy.${key}`,
    code: 'INVALID_PROFILE_POLICY',
    category: 'policy',
    message: `Profile "${ref}" policy.${key} ${message}.`,
  }
}

function unresolvedProfileError(
  path: string,
  ref: string,
  _ctx: WalkContext,
): ValidationError {
  return {
    nodeType: 'agent',
    nodePath: path,
    code: 'UNRESOLVED_PROFILE_REF',
    category: 'registry',
    message: `Unresolved profile reference: "${ref}".`,
  }
}

/**
 * Re-exported for typing in {@link WalkContext}. Importing from this module
 * keeps the dependency direction from semantic-context.ts forward-only.
 */
export type { ProfileRegistry } from '../profile-registry.js'
