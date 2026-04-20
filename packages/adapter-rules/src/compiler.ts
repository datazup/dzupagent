/**
 * RuleCompiler — projects canonical AdapterRule[] into a provider-specific
 * RuntimePlan for the current request.
 *
 * The compiler performs three steps per rule:
 *   1. provider filter (`appliesToProviders`)
 *   2. match filters (`match.paths`, `match.requestTags`, `match.models`)
 *   3. effect projection into the RuntimePlan slots
 *
 * After all rules are projected, a provider-specific config patch is assembled
 * from the accumulated `auditFlags` (and, in the future, other slots).
 */

import type { AdapterProviderId } from '@dzupagent/adapter-types'

import { projectProviderConfig } from './projectors/index.js'
import type {
  AdapterRule,
  AlertSeverity,
  CompileContext,
  RuleEffect,
  RuleMatch,
  RuntimePlan,
} from './types.js'

export class RuleCompiler {
  compile(rules: AdapterRule[], context: CompileContext): RuntimePlan {
    const plan = this.emptyPlan(context.providerId)

    for (const rule of rules) {
      if (!this.providerMatches(rule, context.providerId)) continue
      if (!this.matchPasses(rule.match, context)) continue

      for (const effect of rule.effects) {
        this.projectEffect(effect, plan)
      }
    }

    plan.providerConfigPatch = this.buildProviderConfigPatch(plan, context)
    return plan
  }

  // -----------------------------------------------------------------------
  // Matching
  // -----------------------------------------------------------------------

  private providerMatches(rule: AdapterRule, providerId: AdapterProviderId): boolean {
    const providers = rule.appliesToProviders
    if (providers.includes('*')) return true
    return providers.includes(providerId)
  }

  private matchPasses(match: RuleMatch | undefined, context: CompileContext): boolean {
    if (!match) return true

    if (match.paths && match.paths.length > 0) {
      const scope = context.pathScope
      if (!scope) return false
      const anyMatch = match.paths.some((p) => scope.startsWith(p))
      if (!anyMatch) return false
    }

    if (match.requestTags && match.requestTags.length > 0) {
      const tags = context.requestTags ?? []
      const anyMatch = match.requestTags.some((t) => tags.includes(t))
      if (!anyMatch) return false
    }

    if (match.models && match.models.length > 0) {
      if (!context.model) return false
      if (!match.models.includes(context.model)) return false
    }

    // match.eventTypes is reserved for runtime event-time evaluation, not
    // compile-time projection — it is intentionally ignored here.

    return true
  }

  // -----------------------------------------------------------------------
  // Effect projection
  // -----------------------------------------------------------------------

  private projectEffect(effect: RuleEffect, plan: RuntimePlan): void {
    switch (effect.kind) {
      case 'prompt_section':
        plan.promptSections.push(effect.content)
        return

      case 'watch_path':
        plan.watchPaths.push(effect.path)
        plan.monitorSubscriptions.push(`artifact:${effect.artifactKind}`)
        return

      case 'require_approval':
        plan.auditFlags.push(`approval:${effect.target}`)
        return

      case 'require_skill':
        plan.requiredSkills.push(effect.skill)
        return

      case 'prefer_agent':
        // last-writer-wins: later rules override earlier preferred agent
        plan.preferredAgent = effect.agent
        return

      case 'deny_path':
        plan.deniedPaths.push(effect.path)
        return

      case 'emit_alert':
        plan.alerts.push({ on: effect.on, severity: effect.severity satisfies AlertSeverity })
        return
    }
  }

  // -----------------------------------------------------------------------
  // Provider-specific config patch
  // -----------------------------------------------------------------------

  private buildProviderConfigPatch(
    plan: RuntimePlan,
    context: CompileContext,
  ): Record<string, unknown> {
    return projectProviderConfig(plan, context)
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emptyPlan(providerId: AdapterProviderId): RuntimePlan {
    return {
      providerId,
      promptSections: [],
      requiredSkills: [],
      preferredAgent: undefined,
      providerConfigPatch: {},
      monitorSubscriptions: [],
      watchPaths: [],
      auditFlags: [],
      deniedPaths: [],
      alerts: [],
    }
  }
}
