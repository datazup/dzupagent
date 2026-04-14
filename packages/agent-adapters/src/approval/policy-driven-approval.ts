/**
 * Policy-driven approval bridge.
 *
 * Wires the core PolicyEvaluator + RiskClassifier into the AdapterApprovalGate
 * `condition` function so that approval decisions are driven by structured
 * policy rules rather than hard-coded logic.
 *
 * Evaluation order (first match wins):
 *   1. Tool risk tier: if the tool is `require-approval`, always require approval.
 *   2. Cost threshold: if estimatedCostCents >= costApprovalThresholdCents, require approval.
 *   2.5. Blast radius: if blastRadius meets or exceeds blastRadiusThreshold, require approval.
 *   2.6. Confidence score: if confidenceScore is below confidenceScoreMinimum, require approval.
 *   3. Policy set evaluation: if policy set is provided and denies the action, require approval.
 *   4. Default: no approval required.
 *
 * @example
 * ```ts
 * const gate = new AdapterApprovalGate({
 *   mode: 'conditional',
 *   condition: createPolicyCondition({
 *     riskClassifier: createRiskClassifier(),
 *     policySet: myPolicySet,
 *     costApprovalThresholdCents: 500,
 *   }),
 * })
 * ```
 */

import { PolicyEvaluator } from '@dzupagent/core'
import type { PolicySet, PolicyContext } from '@dzupagent/core'
import { createRiskClassifier } from '@dzupagent/core'
import type { RiskClassifier, RiskClassifierConfig } from '@dzupagent/core'

import type { ApprovalContext } from './adapter-approval.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PolicyConditionConfig {
  /**
   * Risk classifier for tool-level tier evaluation.
   * If omitted, a default classifier is created using DEFAULT_* tiers.
   */
  riskClassifier?: RiskClassifier

  /**
   * Optional risk classifier config (used when riskClassifier is not provided).
   */
  riskClassifierConfig?: Partial<RiskClassifierConfig>

  /**
   * Policy set to evaluate for structured RBAC/ABAC decisions.
   * Optional — when omitted, only risk tier and cost checks are applied.
   */
  policySet?: PolicySet

  /**
   * Require approval when estimated cost exceeds this threshold (cents).
   * Optional — when omitted, no cost-based approval trigger is applied.
   */
  costApprovalThresholdCents?: number

  /**
   * Require approval when estimated blast radius meets or exceeds this level.
   * Optional — when omitted, no blast-radius-based approval trigger is applied.
   */
  blastRadiusThreshold?: 'low' | 'medium' | 'high' | 'critical'

  /**
   * Require approval when AI confidence score is BELOW this minimum (0–1).
   * Optional — when omitted, no confidence-based approval trigger is applied.
   */
  confidenceScoreMinimum?: number

  /**
   * How to resolve the principal for policy evaluation.
   * Defaults to { type: 'agent', id: context.providerId }.
   */
  resolvePrincipal?: (context: ApprovalContext) => PolicyContext['principal']

  /**
   * Map ApprovalContext tags/metadata to environment for condition evaluation.
   * Defaults to spreading context.metadata into environment.
   */
  resolveEnvironment?: (context: ApprovalContext) => Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `condition` function for `AdapterApprovalGate` that uses structured
 * policy rules, risk classification, and cost thresholds to decide whether
 * human approval is needed.
 *
 * Returns `true` when approval IS needed, `false` when it can proceed.
 */
export function createPolicyCondition(
  config: PolicyConditionConfig,
): (context: ApprovalContext) => boolean | Promise<boolean> {
  const classifier = config.riskClassifier ?? createRiskClassifier(config.riskClassifierConfig)
  const evaluator = config.policySet ? new PolicyEvaluator() : undefined

  return (context: ApprovalContext): boolean => {
    // 1. Tool risk tier check
    const toolName = extractToolName(context)
    if (toolName) {
      const classification = classifier.classify(toolName, {})
      if (classification.tier === 'require-approval') {
        return true
      }
    }

    // 2. Cost threshold check
    if (
      config.costApprovalThresholdCents !== undefined &&
      context.estimatedCostCents !== undefined &&
      context.estimatedCostCents >= config.costApprovalThresholdCents
    ) {
      return true
    }

    // 2.5. Blast radius check
    if (
      config.blastRadiusThreshold !== undefined &&
      context.blastRadius !== undefined &&
      compareBlastRadius(context.blastRadius, config.blastRadiusThreshold) >= 0
    ) {
      return true
    }

    // 2.6. Confidence score check
    if (
      config.confidenceScoreMinimum !== undefined &&
      context.confidenceScore !== undefined &&
      context.confidenceScore < config.confidenceScoreMinimum
    ) {
      return true
    }

    // 3. Policy set evaluation
    if (config.policySet && evaluator) {
      const principal = config.resolvePrincipal
        ? config.resolvePrincipal(context)
        : { type: 'agent' as const, id: context.providerId }

      const environment = config.resolveEnvironment
        ? config.resolveEnvironment(context)
        : { ...(context.metadata ?? {}), tags: context.tags ?? [] }

      const policyContext: PolicyContext = {
        principal,
        action: 'adapter:execute',
        resource: context.runId,
        environment,
      }

      const decision = evaluator.evaluate(config.policySet, policyContext)
      if (decision.effect === 'deny') {
        return true
      }
    }

    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Blast-radius severity level. */
type BlastRadiusLevel = 'low' | 'medium' | 'high' | 'critical'

/** Severity rank for blast-radius levels. */
const BLAST_RADIUS_RANK: Record<BlastRadiusLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

/**
 * Compare two blast-radius levels.
 * Returns negative if `a < b`, zero if equal, positive if `a > b`.
 */
export function compareBlastRadius(
  a: 'low' | 'medium' | 'high' | 'critical',
  b: 'low' | 'medium' | 'high' | 'critical',
): number {
  return BLAST_RADIUS_RANK[a] - BLAST_RADIUS_RANK[b]
}

/**
 * Extract a tool name hint from the approval context.
 * Looks in `context.metadata.toolName` and `context.tags` for a `tool:*` tag.
 */
function extractToolName(context: ApprovalContext): string | undefined {
  if (context.metadata?.toolName && typeof context.metadata.toolName === 'string') {
    return context.metadata.toolName
  }

  const toolTag = context.tags?.find((t) => t.startsWith('tool:'))
  if (toolTag) {
    return toolTag.slice('tool:'.length)
  }

  return undefined
}
