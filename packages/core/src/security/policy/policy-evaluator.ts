/**
 * Zero-Trust Policy Engine — Evaluator
 *
 * Pure, synchronous policy evaluation with deny-overrides semantics.
 * No I/O, no async, no LLM — suitable for hot-path enforcement.
 */

import type {
  PolicySet,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  PolicyCondition,
  ConditionOperator,
} from './policy-types.js'

// ---------------------------------------------------------------------------
// Glob matcher (simple — supports only trailing `*` and `**`)
// ---------------------------------------------------------------------------

/**
 * Match a value against a glob pattern.
 * Supports `*` (single segment) and full glob via conversion to regex.
 */
function globMatch(pattern: string, value: string): boolean {
  // Fast path: exact match
  if (pattern === value) return true
  if (pattern === '*') return true

  // Convert glob to regex:
  // - Escape regex-special chars except *
  // - Replace ** with .* (greedy)
  // - Replace remaining * with [^.]* (single segment)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^.]*')
    .replace(/\u0000/g, '.*')

  const re = new RegExp(`^${escaped}$`)
  return re.test(value)
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function resolveField(field: string, ctx: PolicyContext): unknown {
  // Support dotted paths: principal.type, environment.ip, etc.
  const parts = field.split('.')

  // Top-level context fields
  let current: unknown = ctx as unknown as Record<string, unknown>
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function evaluateCondition(condition: PolicyCondition, ctx: PolicyContext): boolean {
  const actual = resolveField(condition.field, ctx)
  return applyOperator(condition.operator, actual, condition.value)
}

function applyOperator(op: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected

    case 'neq':
      return actual !== expected

    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected

    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected

    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected

    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected

    case 'in':
      return Array.isArray(expected) && expected.includes(actual)

    case 'not_in':
      return Array.isArray(expected) && !expected.includes(actual)

    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected)
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected)
      }
      return false
    }

    case 'glob':
      return typeof actual === 'string' && typeof expected === 'string' && globMatch(expected, actual)

    case 'regex': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false
      try {
        return new RegExp(expected).test(actual)
      } catch {
        return false
      }
    }

    default: {
      // Exhaustive check
      const _: never = op
      void _
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function isExpired(rule: PolicyRule): boolean {
  if (!rule.expiresAt) return false
  return new Date(rule.expiresAt).getTime() <= Date.now()
}

function principalMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (!rule.principals) return true
  const { types, ids, roles } = rule.principals

  if (types && types.length > 0 && !types.includes(ctx.principal.type)) return false
  if (ids && ids.length > 0 && !ids.includes(ctx.principal.id)) return false
  if (roles && roles.length > 0) {
    const principalRoles = ctx.principal.roles ?? []
    const hasOverlap = roles.some((r) => principalRoles.includes(r))
    if (!hasOverlap) return false
  }
  return true
}

function actionMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  return rule.actions.some((pattern) => globMatch(pattern, ctx.action))
}

function resourceMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (!rule.resources || rule.resources.length === 0) return true
  if (!ctx.resource) return false
  return rule.resources.some((pattern) => globMatch(pattern, ctx.resource!))
}

function conditionsMatch(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (!rule.conditions || rule.conditions.length === 0) return true
  return rule.conditions.every((c) => evaluateCondition(c, ctx))
}

function ruleMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (isExpired(rule)) return false
  return (
    principalMatches(rule, ctx) &&
    actionMatches(rule, ctx) &&
    resourceMatches(rule, ctx) &&
    conditionsMatch(rule, ctx)
  )
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateRule(rule: PolicyRule, index: number): string[] {
  const errors: string[] = []
  if (!rule.id || typeof rule.id !== 'string') {
    errors.push(`Rule[${index}]: missing or invalid id`)
  }
  if (rule.effect !== 'allow' && rule.effect !== 'deny') {
    errors.push(`Rule[${index}] (${rule.id}): effect must be "allow" or "deny"`)
  }
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    errors.push(`Rule[${index}] (${rule.id}): actions must be a non-empty array`)
  }
  if (rule.conditions) {
    for (let ci = 0; ci < rule.conditions.length; ci++) {
      const c = rule.conditions[ci]!
      if (!c.field) errors.push(`Rule[${index}] (${rule.id}): condition[${ci}] missing field`)
      if (!c.operator) errors.push(`Rule[${index}] (${rule.id}): condition[${ci}] missing operator`)
    }
  }
  if (rule.expiresAt) {
    const d = new Date(rule.expiresAt)
    if (isNaN(d.getTime())) {
      errors.push(`Rule[${index}] (${rule.id}): invalid expiresAt date`)
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// PolicyEvaluator
// ---------------------------------------------------------------------------

export class PolicyEvaluator {
  /**
   * Evaluate a policy set against a request context.
   *
   * Semantics:
   * - Rules sorted by priority (descending). Higher priority first.
   * - **Deny-overrides**: if any matched rule denies, the result is deny.
   * - **Default-deny**: if no rules match, the result is deny.
   */
  evaluate(policySet: PolicySet, context: PolicyContext): PolicyDecision {
    const start = performance.now()

    // Sort by priority descending (higher first)
    const sorted = [...policySet.rules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )

    const matchedRules: PolicyRule[] = []
    for (const rule of sorted) {
      if (ruleMatches(rule, context)) {
        matchedRules.push(rule)
      }
    }

    const elapsed = (performance.now() - start) * 1000 // ms -> us

    // Default deny: no matches
    if (matchedRules.length === 0) {
      return {
        effect: 'deny',
        matchedRules: [],
        evaluationTimeUs: elapsed,
      }
    }

    // Deny-overrides: any deny rule wins
    const denyRule = matchedRules.find((r) => r.effect === 'deny')
    if (denyRule) {
      return {
        effect: 'deny',
        matchedRules,
        decidingRule: denyRule,
        evaluationTimeUs: elapsed,
      }
    }

    // All matched rules are allow — use highest-priority one as deciding
    // Safe: matchedRules is non-empty (checked above)
    const decidingRule = matchedRules[0]
    return {
      effect: 'allow',
      matchedRules,
      ...(decidingRule !== undefined && { decidingRule }),
      evaluationTimeUs: elapsed,
    }
  }

  /**
   * Validate a policy set for structural correctness.
   */
  validate(policySet: PolicySet): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!policySet.id) errors.push('PolicySet: missing id')
    if (!policySet.name) errors.push('PolicySet: missing name')
    if (typeof policySet.version !== 'number') errors.push('PolicySet: version must be a number')
    if (!Array.isArray(policySet.rules)) {
      errors.push('PolicySet: rules must be an array')
      return { valid: false, errors }
    }

    // Check for duplicate rule IDs
    const ids = new Set<string>()
    for (let i = 0; i < policySet.rules.length; i++) {
      const rule = policySet.rules[i]!
      if (ids.has(rule.id)) {
        errors.push(`Rule[${i}] (${rule.id}): duplicate id`)
      }
      ids.add(rule.id)
      errors.push(...validateRule(rule, i))
    }

    return { valid: errors.length === 0, errors }
  }
}
