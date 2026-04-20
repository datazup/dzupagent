/**
 * Codex provider config projector.
 *
 * Projects a RuntimePlan into a Codex SDK config patch shaped like
 * `{ approvalPolicy: 'on-failure' }`, which is the native shape consumed
 * by @openai/codex-sdk.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectCodexConfig(
  plan: RuntimePlan,
  _context: CompileContext,
): Record<string, unknown> {
  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length === 0) return {}
  return { approvalPolicy: 'on-failure' }
}
