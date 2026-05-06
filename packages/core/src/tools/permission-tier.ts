/**
 * Permission tiers — control which tools an agent may see and invoke.
 *
 * The same vocabulary is used by `@dzupagent/codegen`'s sandbox configuration
 * (Docker / E2B run flags); this module owns the canonical type so framework
 * packages (`@dzupagent/agent`, etc.) can depend on the tier without pulling
 * in the codegen sandbox surface.
 *
 * Tier ordering (most → least restrictive):
 *
 *   read-only   <  workspace-write  <  full-access
 *
 * An agent on a given tier may only invoke tools tagged with the same tier
 * or a more restrictive one — see {@link tierSatisfies}.
 */

/**
 * Permission tier that controls which tools an agent may see and invoke.
 *
 * - `read-only`       — safest, default. No writes, no network, no processes.
 * - `workspace-write` — allows scoped workspace mutations (file edits, etc.).
 * - `full-access`     — full filesystem, network, and process spawning.
 */
export type PermissionTier = 'read-only' | 'workspace-write' | 'full-access'

/**
 * Numeric ordering for tier comparison.
 *
 * Higher value = more permissive. Kept private so callers compare tiers via
 * the exported {@link tierSatisfies} helper rather than reaching for raw
 * numeric values.
 */
const TIER_ORDER: Record<PermissionTier, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
}

/**
 * Returns `true` when tier `a` satisfies the requirement of tier `b` —
 * i.e. when `a` is at least as permissive as `b` (`a >= b` in the ordering
 * defined by {@link TIER_ORDER}).
 *
 * Example:
 * ```ts
 * tierSatisfies('full-access', 'workspace-write') // true
 * tierSatisfies('read-only',   'workspace-write') // false
 * tierSatisfies('read-only',   'read-only')       // true
 * ```
 */
export function tierSatisfies(a: PermissionTier, b: PermissionTier): boolean {
  return TIER_ORDER[a] >= TIER_ORDER[b]
}
