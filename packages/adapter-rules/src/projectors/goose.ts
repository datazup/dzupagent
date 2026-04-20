/**
 * Goose provider config projector.
 *
 * Projects a RuntimePlan into a Goose config patch in the
 * `.goose/config.yaml` environment shape. Emits `GOOSE_MODEL` and
 * `GOOSE_PROVIDER` fields when the corresponding inputs are present.
 * Approval effects set `toolkits.require_confirmation: true`, which is
 * the Goose-native gate for tool runs.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectGooseConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (context.model !== undefined) {
    patch['GOOSE_MODEL'] = context.model
  }
  if (context.providerName !== undefined) {
    patch['GOOSE_PROVIDER'] = context.providerName
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['toolkits'] = { require_confirmation: true }
  }

  return patch
}
