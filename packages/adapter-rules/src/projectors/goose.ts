/**
 * Goose provider config projector.
 *
 * Projects only settings proven by the Goose v1.7.0 config contract.
 * Provider and model are top-level GOOSE_* settings; approval mode is
 * GOOSE_MODE. Generic API keys and watcher paths are intentionally omitted
 * because v1.7.0 has no provider-neutral credential or watcher shape.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectGooseConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.providerName !== undefined) {
    patch['GOOSE_PROVIDER'] = context.providerName
  }
  if (context.model !== undefined) {
    patch['GOOSE_MODEL'] = context.model
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['GOOSE_MODE'] = 'approve'
  }

  return patch
}
