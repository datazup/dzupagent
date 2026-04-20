/**
 * Goose provider config projector.
 *
 * Projects a RuntimePlan into a Goose config patch in the
 * `.goose/config.yaml` format. Emits a nested `provider` block for model
 * and credential fields, a `goose.mode: 'approve'` toggle when approval
 * effects are present, and appends watcher registrations as `extensions`
 * entries so Goose picks them up on launch. When `providerName` is
 * absent but `model` is set, the model is also exposed as the legacy
 * `GOOSE_MODEL` env-style key for backwards compatibility with older
 * Goose CLIs.
 */

import type { CompileContext, RuntimePlan } from '../types.js'

export function projectGooseConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  const provider: Record<string, unknown> = {}
  if (context.model !== undefined) {
    provider['model'] = context.model
  }
  if (context.apiKey !== undefined) {
    provider['api_key'] = context.apiKey
  }
  if (context.providerName !== undefined) {
    provider['name'] = context.providerName
  }
  if (Object.keys(provider).length > 0) {
    patch['provider'] = provider
  }

  // Legacy env-style fallback: some Goose CLI builds still read GOOSE_MODEL.
  if (context.model !== undefined) {
    patch['GOOSE_MODEL'] = context.model
  }

  const approvalFlags = plan.auditFlags.filter((f) => f.startsWith('approval:'))
  if (approvalFlags.length > 0) {
    patch['goose'] = { mode: 'approve' }
  }

  if (plan.watchPaths.length > 0) {
    patch['extensions'] = plan.watchPaths.map((path) => ({
      type: 'watcher',
      path,
    }))
  }

  return patch
}
