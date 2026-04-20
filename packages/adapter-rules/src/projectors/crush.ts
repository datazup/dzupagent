/**
 * Crush provider config projector.
 *
 * Projects a RuntimePlan into a Crush config patch in the
 * `.crush/config.toml` format. Emits `crush_model` and `crush_api_key`
 * fields when the corresponding inputs are present. Approval effects
 * set `safe_mode: true` so every tool call requires interactive approval.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectCrushConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.model !== undefined) {
    patch['crush_model'] = context.model
  }
  if (context.apiKey !== undefined) {
    patch['crush_api_key'] = context.apiKey
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['safe_mode'] = true
  }

  return patch
}
