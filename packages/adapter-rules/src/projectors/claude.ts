/**
 * Claude provider config projector.
 *
 * Projects a RuntimePlan into a Claude SDK config patch shaped like
 * `{ permissions: { additionalPermissions: string[] } }`, which is the
 * native shape consumed by @anthropic-ai/claude-agent-sdk.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectClaudeConfig(
  plan: RuntimePlan,
  _context: CompileContext,
): Record<string, unknown> {
  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length === 0) return {}
  return {
    permissions: {
      additionalPermissions: approvalFlags,
    },
  }
}
