/**
 * PreflightValidator — pre-execution validation gate for adapters.
 *
 * Runs before the adapter starts a tool loop. Default validators cover:
 *
 * 1. **Budget headroom**: error when {@link AgentInput.maxBudgetUsd} is set to
 *    a non-positive value.
 * 2. **Skill-tool coverage**: warn when the caller declares `skillIds` /
 *    `requiredTools` but no required tools are available on the input options.
 * 3. **Skill degradation**: when a {@link AdapterLearningLoop} is supplied,
 *    warn when any requested skill is marked degraded for the chosen provider
 *    (does not block — the caller may still proceed knowing the risk).
 *
 * Apps can compose additional validators (RBAC, tenant policies, content
 * scanning) via {@link composeValidators}.
 */

import {
  composeValidators,
  failingResult,
  passingResult,
  type AgentInput,
  type ValidationContext,
  type ValidationContract,
  type ValidationIssue,
  type ValidationResult,
} from '@dzupagent/adapter-types'

import type { AdapterLearningLoop } from '../learning/adapter-learning-loop.js'

export interface PreflightValidatorOptions {
  /**
   * Optional learning loop. When supplied, the validator will warn about
   * skills that have been marked degraded for the target provider.
   */
  learningLoop?: AdapterLearningLoop
  /**
   * Extra validators to compose with the built-ins. Run after the built-ins.
   */
  extra?: ValidationContract[]
}

/**
 * Built-in: budget sanity check. Errors when `maxBudgetUsd` is explicitly
 * non-positive (a common app-side bug after dynamic budget calculation).
 */
export const budgetSanityValidator: ValidationContract = {
  name: 'budget-sanity',
  validate(input: AgentInput): ValidationResult {
    if (input.maxBudgetUsd !== undefined && input.maxBudgetUsd <= 0) {
      return failingResult({
        code: 'budget.exhausted',
        severity: 'error',
        message: `maxBudgetUsd must be > 0; got ${input.maxBudgetUsd}`,
        detail: { maxBudgetUsd: input.maxBudgetUsd },
      })
    }
    return passingResult()
  },
}

/**
 * Built-in: skill+tool coverage. Warns (does not block) when a skill set is
 * declared but the caller forgot to wire the matching required tools — the
 * adapter may still work, but the agent will fail at the first tool call.
 */
export const skillToolCoverageValidator: ValidationContract = {
  name: 'skill-tool-coverage',
  validate(_input: AgentInput, ctx: ValidationContext): ValidationResult {
    const issues: ValidationIssue[] = []
    if (ctx.skillIds && ctx.skillIds.length > 0 && (!ctx.requiredTools || ctx.requiredTools.length === 0)) {
      issues.push({
        code: 'skill.tools_missing',
        severity: 'warning',
        message: `Skill set declared (${ctx.skillIds.length} skills) but no required tools listed; tool calls will likely fail`,
        detail: { skillIds: ctx.skillIds },
      })
    }
    return { ok: true, issues }
  },
}

/**
 * Build a skill-degradation validator backed by a learning loop. Warns when
 * any of the caller's `skillIds` is currently flagged degraded for the target
 * provider. This is informational — it does not block execution because a
 * fresh-from-degradation skill must still get the chance to recover.
 */
export function skillDegradationValidator(
  learningLoop: AdapterLearningLoop,
): ValidationContract {
  return {
    name: 'skill-degradation',
    validate(_input: AgentInput, ctx: ValidationContext): ValidationResult {
      if (!ctx.skillIds || ctx.skillIds.length === 0) return passingResult()
      const issues: ValidationIssue[] = []
      for (const skillId of ctx.skillIds) {
        const metrics = learningLoop.getSkillHealth(ctx.providerId, skillId, ctx.tenantId)
        const metric = metrics[0]
        if (metric && metric.degraded) {
          issues.push({
            code: 'skill.degraded',
            severity: 'warning',
            message: `Skill ${skillId} is degraded on ${ctx.providerId} (success rate ${metric.successRate.toFixed(2)} over ${metric.invocationCount} runs)`,
            detail: {
              skillId,
              providerId: ctx.providerId,
              successRate: metric.successRate,
              invocationCount: metric.invocationCount,
            },
          })
        }
      }
      return { ok: true, issues }
    },
  }
}

/**
 * Build a composed pre-flight validator with the framework defaults.
 *
 * Adapters call `validator.validate(input, context)` before starting the tool
 * loop and abort when the result is `ok: false`.
 */
export function buildPreflightValidator(
  options?: PreflightValidatorOptions,
): ValidationContract {
  const validators: ValidationContract[] = [budgetSanityValidator, skillToolCoverageValidator]
  if (options?.learningLoop) {
    validators.push(skillDegradationValidator(options.learningLoop))
  }
  if (options?.extra && options.extra.length > 0) {
    validators.push(...options.extra)
  }
  return composeValidators('preflight', ...validators)
}
