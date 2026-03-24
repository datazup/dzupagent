/**
 * Write policies determine whether a memory record can be persisted automatically,
 * requires human confirmation, or must be rejected outright.
 */

export type WriteAction = 'auto' | 'confirm-required' | 'reject'

export interface WritePolicy {
  /** Policy name for diagnostics */
  name: string
  /** Determine write action based on record content */
  evaluate(value: Record<string, unknown>): WriteAction
}

// --- PII / secret patterns (inline to avoid circular deps) ---

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // email
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,                           // phone
  /\b\d{3}-\d{2}-\d{4}\b/,                                    // SSN
  /\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // credit card
]

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.]{20,}/i,
  /(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}/,  // stripe-style
  /ghp_[A-Za-z0-9]{36,}/,                              // github PAT
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
]

const DECISION_KEYWORDS = [
  /\b(?:decided|decision|constraint|requirement|must not|must always|rule|policy)\b/i,
  /\b(?:architecture|design choice|trade-?off|breaking change)\b/i,
]

function extractText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text']
  return JSON.stringify(value)
}

/**
 * Default write policy:
 * - Reject records containing PII or secrets
 * - Require confirmation for architectural decisions and constraints
 * - Auto-approve everything else
 */
export const defaultWritePolicy: WritePolicy = {
  name: 'default',
  evaluate(value: Record<string, unknown>): WriteAction {
    const text = extractText(value)

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) return 'reject'
    }
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(text)) return 'reject'
    }
    for (const pattern of DECISION_KEYWORDS) {
      if (pattern.test(text)) return 'confirm-required'
    }
    return 'auto'
  },
}

/** Action severity for composition: higher number = more restrictive */
const ACTION_SEVERITY: Record<WriteAction, number> = {
  auto: 0,
  'confirm-required': 1,
  reject: 2,
}

const SEVERITY_TO_ACTION: WriteAction[] = ['auto', 'confirm-required', 'reject']

/**
 * Create a composite policy from multiple policies.
 * The most restrictive action wins (reject > confirm-required > auto).
 */
export function composePolicies(...policies: WritePolicy[]): WritePolicy {
  return {
    name: policies.map(p => p.name).join('+'),
    evaluate(value: Record<string, unknown>): WriteAction {
      let maxSeverity = 0
      for (const policy of policies) {
        const action = policy.evaluate(value)
        const severity = ACTION_SEVERITY[action]
        if (severity > maxSeverity) maxSeverity = severity
      }
      return SEVERITY_TO_ACTION[maxSeverity] ?? 'auto'
    },
  }
}
