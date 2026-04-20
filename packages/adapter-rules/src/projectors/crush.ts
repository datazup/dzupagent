/**
 * Crush provider config projector.
 *
 * Projects a RuntimePlan into a Crush config patch in the
 * `crush.json` format. Emits `model` and `api_key` fields when present in
 * context, sets `permissionMode: 'ask'` when approval effects are present,
 * and forwards MCP server references (carried by `monitorSubscriptions`
 * with an `mcp:` prefix) into the `mcp.servers` array.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectCrushConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.model !== undefined) {
    patch['model'] = context.model
  }
  if (context.apiKey !== undefined) {
    patch['api_key'] = context.apiKey
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['permissionMode'] = 'ask'
  }

  const mcpServers = plan.monitorSubscriptions
    .filter((s) => s.startsWith('mcp:'))
    .map((s) => s.slice('mcp:'.length))
  if (mcpServers.length > 0) {
    patch['mcp'] = { servers: mcpServers }
  }

  return patch
}
