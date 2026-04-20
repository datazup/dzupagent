/**
 * Qwen provider config projector.
 *
 * Projects a RuntimePlan into a Qwen config patch in the
 * `~/.qwen/config.json` format. Emits `api_key`, `model`, and
 * `max_tokens` fields when the corresponding inputs are present.
 * Approval effects set `approval_mode: 'require'` so tool calls are
 * confirmed before execution.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectQwenConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.apiKey !== undefined) {
    patch['api_key'] = context.apiKey
  }
  if (context.model !== undefined) {
    patch['model'] = context.model
  }
  if (context.maxTokens !== undefined) {
    patch['max_tokens'] = context.maxTokens
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['approval_mode'] = 'require'
  }

  return patch
}
