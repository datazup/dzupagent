/**
 * Zero-Trust Policy Engine — Type definitions
 *
 * Defines the policy model: rules, conditions, sets, contexts, and decisions.
 * Used by PolicyEvaluator for enforcement and PolicyTranslator for authoring.
 */

// ---------------------------------------------------------------------------
// Enums / Literals
// ---------------------------------------------------------------------------

/** Whether a rule permits or forbids an action. */
export type PolicyEffect = 'allow' | 'deny'

/** The type of entity requesting an action. */
export type PrincipalType = 'agent' | 'user' | 'service' | 'system'

/** Operators available in policy conditions. */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'glob'
  | 'regex'

// ---------------------------------------------------------------------------
// Rule primitives
// ---------------------------------------------------------------------------

/** A single condition that must hold for a rule to match. */
export interface PolicyCondition {
  /** Dot-path into PolicyContext.environment (or top-level field). */
  field: string
  operator: ConditionOperator
  value: unknown
}

/** Describes who a rule applies to. */
export interface PolicyPrincipal {
  types?: PrincipalType[]
  ids?: string[]
  roles?: string[]
}

/** A single policy rule. */
export interface PolicyRule {
  id: string
  effect: PolicyEffect
  /** Higher priority rules are evaluated first. Default 0. */
  priority?: number
  /** If omitted, rule matches all principals. */
  principals?: PolicyPrincipal
  /** Action names or glob patterns (e.g. "runs.*"). */
  actions: string[]
  /** Resource identifiers or glob patterns. */
  resources?: string[]
  /** All conditions must hold for the rule to match (AND). */
  conditions?: PolicyCondition[]
  /** Human-readable description for auditing. */
  description?: string
  /** ISO-8601 expiration timestamp. Expired rules are skipped. */
  expiresAt?: string
}

// ---------------------------------------------------------------------------
// Policy set (versioned collection of rules)
// ---------------------------------------------------------------------------

/** A named, versioned collection of rules. */
export interface PolicySet {
  id: string
  name: string
  version: number
  rules: PolicyRule[]
  active: boolean
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Evaluation context & decision
// ---------------------------------------------------------------------------

/** The request context evaluated against a policy set. */
export interface PolicyContext {
  principal: {
    type: PrincipalType
    id: string
    roles?: string[]
  }
  action: string
  resource?: string
  environment?: Record<string, unknown>
}

/** The result of evaluating a policy set against a context. */
export interface PolicyDecision {
  effect: PolicyEffect
  matchedRules: PolicyRule[]
  /** The single rule that decided the final effect (highest-priority deny, or highest-priority allow). */
  decidingRule?: PolicyRule
  /** Wall-clock evaluation time in microseconds. */
  evaluationTimeUs: number
}

// ---------------------------------------------------------------------------
// Policy store interface
// ---------------------------------------------------------------------------

/** Persistence abstraction for policy sets. */
export interface PolicyStore {
  get(id: string): Promise<PolicySet | undefined>
  save(policySet: PolicySet): Promise<void>
  list(): Promise<PolicySet[]>
  getVersions(id: string): Promise<PolicySet[]>
  delete(id: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// In-memory store (tests & development)
// ---------------------------------------------------------------------------

/**
 * Simple in-memory PolicyStore implementation.
 * Stores all versions; `get` returns the latest.
 */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly _versions = new Map<string, PolicySet[]>()

  async get(id: string): Promise<PolicySet | undefined> {
    const versions = this._versions.get(id)
    if (!versions || versions.length === 0) return undefined
    // Return latest version (highest version number)
    return versions[versions.length - 1]
  }

  async save(policySet: PolicySet): Promise<void> {
    const existing = this._versions.get(policySet.id) ?? []
    existing.push({ ...policySet })
    this._versions.set(policySet.id, existing)
  }

  async list(): Promise<PolicySet[]> {
    const result: PolicySet[] = []
    for (const versions of this._versions.values()) {
      const latest = versions[versions.length - 1]
      if (latest) result.push(latest)
    }
    return result
  }

  async getVersions(id: string): Promise<PolicySet[]> {
    return [...(this._versions.get(id) ?? [])]
  }

  async delete(id: string): Promise<boolean> {
    return this._versions.delete(id)
  }
}
