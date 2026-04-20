/**
 * Gemini provider config projector.
 *
 * Projects a RuntimePlan into a Gemini CLI config patch in the
 * `~/.gemini/settings.json` format. Emits `gemini_api_key`, `model`,
 * and `tool_config` fields when the corresponding inputs are present.
 * Approval effects force `trust_tools: false` so every tool call prompts
 * for confirmation.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectGeminiConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.apiKey !== undefined) {
    patch['gemini_api_key'] = context.apiKey
  }
  if (context.model !== undefined) {
    patch['model'] = context.model
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  const toolConfig: Record<string, unknown> = {}
  if (approvalFlags.length > 0) {
    patch['trust_tools'] = false
    toolConfig['require_confirmation'] = true
    toolConfig['approvals'] = approvalFlags
  }
  if (plan.deniedPaths.length > 0) {
    toolConfig['denied_paths'] = [...plan.deniedPaths]
  }
  if (Object.keys(toolConfig).length > 0) {
    patch['tool_config'] = toolConfig
  }

  return patch
}
