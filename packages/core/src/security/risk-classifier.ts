/**
 * Tool risk classification for agent safety.
 *
 * Classifies tool calls into three tiers:
 * - `auto`             — safe read-only, proceed without logging
 * - `log`              — write operations, proceed but emit audit event
 * - `require-approval` — destructive operations, block until human approves
 */

import {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from './tool-permission-tiers.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskTier = 'auto' | 'log' | 'require-approval'

export interface RiskClassification {
  tier: RiskTier
  reason: string
  toolName: string
}

export interface RiskClassifierConfig {
  /** Tools that are always auto-approved (safe read-only operations). */
  autoApproveTools?: readonly string[]
  /** Tools that are logged but proceed (write operations). */
  logTools?: readonly string[]
  /** Tools that always require human approval (destructive operations). */
  requireApprovalTools?: readonly string[]
  /** Default tier for unclassified tools (default: 'log'). */
  defaultTier?: RiskTier
  /** Optional custom classifier for dynamic classification based on args. */
  customClassifier?: (toolName: string, args: Record<string, unknown>) => RiskTier | undefined
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export interface RiskClassifier {
  classify(toolName: string, args?: Record<string, unknown>): RiskClassification
}

/**
 * Creates a risk classifier with the given (or default) configuration.
 *
 * Classification order:
 * 1. Static tool-name lookup against the three configured tiers
 * 2. Custom classifier function (can override based on args)
 * 3. Configured default tier (falls back to `'log'`)
 */
export function createRiskClassifier(config?: Partial<RiskClassifierConfig>): RiskClassifier {
  const autoSet = new Set<string>(config?.autoApproveTools ?? DEFAULT_AUTO_APPROVE_TOOLS)
  const logSet = new Set<string>(config?.logTools ?? DEFAULT_LOG_TOOLS)
  const approvalSet = new Set<string>(config?.requireApprovalTools ?? DEFAULT_REQUIRE_APPROVAL_TOOLS)
  const defaultTier: RiskTier = config?.defaultTier ?? 'log'
  const customClassifier = config?.customClassifier

  function classifyToolRisk(
    toolName: string,
    args: Record<string, unknown> = {},
  ): RiskClassification {
    // 1. Static tier lookup
    if (approvalSet.has(toolName)) {
      return { tier: 'require-approval', reason: `Tool "${toolName}" is in the require-approval list`, toolName }
    }
    if (logSet.has(toolName)) {
      return { tier: 'log', reason: `Tool "${toolName}" is in the log list`, toolName }
    }
    if (autoSet.has(toolName)) {
      return { tier: 'auto', reason: `Tool "${toolName}" is in the auto-approve list`, toolName }
    }

    // 2. Custom classifier (may inspect args)
    if (customClassifier) {
      const overrideTier = customClassifier(toolName, args)
      if (overrideTier !== undefined) {
        return { tier: overrideTier, reason: `Custom classifier assigned "${overrideTier}" for "${toolName}"`, toolName }
      }
    }

    // 3. Default
    return { tier: defaultTier, reason: `Tool "${toolName}" is unclassified; using default tier "${defaultTier}"`, toolName }
  }

  return { classify: classifyToolRisk }
}
