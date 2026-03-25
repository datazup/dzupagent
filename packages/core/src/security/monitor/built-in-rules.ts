/**
 * Built-in safety rules for the Runtime Safety Monitor.
 *
 * 5 rules:
 * 1. Prompt injection scanner
 * 2. PII leak scanner
 * 3. Secret leak scanner
 * 4. Tool abuse detector (consecutive tool:error events)
 * 5. Escalation detector (permission/config modification attempts)
 */

export type SafetyCategory =
  | 'prompt_injection'
  | 'pii_leak'
  | 'secret_leak'
  | 'tool_abuse'
  | 'escalation'
  | 'harmful_content'

export type SafetySeverity = 'info' | 'warning' | 'critical' | 'emergency'

export type SafetyAction = 'log' | 'block' | 'kill'

export interface SafetyViolation {
  category: SafetyCategory
  severity: SafetySeverity
  action: SafetyAction
  message: string
  evidence: string
  agentId?: string
  timestamp: Date
}

export interface SafetyRule {
  id: string
  category: SafetyCategory
  severity: SafetySeverity
  action: SafetyAction
  check: (content: string, context?: Record<string, unknown>) => SafetyViolation | null
}

// --- Prompt Injection Patterns ---

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+are/i,
  /\bdo\s+anything\s+now\b/i,
  /\bdan\s+mode\b/i,
  /\bjailbreak\b/i,
  /pretend\s+you\s+(are|have)\s+(no|un)/i,
  /bypass\s+(your\s+)?(safety|content|ethical)\s*(filters?|restrictions?|guidelines?)/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+(restrictions?|limitations?|rules)/i,
  /override\s+(your\s+)?(programming|instructions|safety)/i,
]

function createInjectionRule(): SafetyRule {
  return {
    id: 'builtin:prompt-injection',
    category: 'prompt_injection',
    severity: 'critical',
    action: 'block',
    check(content: string): SafetyViolation | null {
      for (const pattern of INJECTION_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(content)
        if (match) {
          return {
            category: 'prompt_injection',
            severity: 'critical',
            action: 'block',
            message: 'Prompt injection attempt detected',
            evidence: match[0],
            timestamp: new Date(),
          }
        }
      }
      return null
    },
  }
}

// --- PII Leak Patterns ---

const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'SSN' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'email' },
  {
    pattern: /(?<![.\d])(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\.\d)/g,
    label: 'phone',
  },
]

function createPIILeakRule(): SafetyRule {
  return {
    id: 'builtin:pii-leak',
    category: 'pii_leak',
    severity: 'warning',
    action: 'log',
    check(content: string): SafetyViolation | null {
      for (const { pattern, label } of PII_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(content)
        if (match) {
          return {
            category: 'pii_leak',
            severity: 'warning',
            action: 'log',
            message: `PII detected: ${label}`,
            evidence: match[0],
            timestamp: new Date(),
          }
        }
      }
      return null
    },
  }
}

// --- Secret Leak Patterns ---

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key' },
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, label: 'GitHub token' },
  { pattern: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g, label: 'GitLab token' },
  { pattern: /\b(xoxb|xoxp|xapp)-[A-Za-z0-9\-]{10,}/g, label: 'Slack token' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_\-+/=]{20,}\b/g,
    label: 'JWT token',
  },
  {
    pattern: /-----BEGIN\s[\w\s]*PRIVATE KEY-----/g,
    label: 'Private key',
  },
  {
    pattern: /(?:secret|token|password|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-/.+=]{8,}["']/gi,
    label: 'Generic secret assignment',
  },
]

function createSecretLeakRule(): SafetyRule {
  return {
    id: 'builtin:secret-leak',
    category: 'secret_leak',
    severity: 'critical',
    action: 'block',
    check(content: string): SafetyViolation | null {
      for (const { pattern, label } of SECRET_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(content)
        if (match) {
          return {
            category: 'secret_leak',
            severity: 'critical',
            action: 'block',
            message: `Secret leak detected: ${label}`,
            evidence: match[0].slice(0, 40) + (match[0].length > 40 ? '...' : ''),
            timestamp: new Date(),
          }
        }
      }
      return null
    },
  }
}

// --- Tool Abuse Detector ---

/**
 * Detects consecutive tool errors which may indicate tool abuse or
 * an agent in a failure loop. Tracks tool:error events via context.
 */
function createToolAbuseRule(): SafetyRule {
  const THRESHOLD = 5
  let consecutiveErrors = 0
  let lastToolName: string | undefined

  return {
    id: 'builtin:tool-abuse',
    category: 'tool_abuse',
    severity: 'warning',
    action: 'log',
    check(_content: string, context?: Record<string, unknown>): SafetyViolation | null {
      const source = context?.['source'] as string | undefined
      if (source !== 'tool:error') {
        // Reset on non-tool-error content
        consecutiveErrors = 0
        lastToolName = undefined
        return null
      }

      const toolName = (context?.['toolName'] as string | undefined) ?? 'unknown'
      consecutiveErrors++
      lastToolName = toolName

      if (consecutiveErrors >= THRESHOLD) {
        const violation: SafetyViolation = {
          category: 'tool_abuse',
          severity: 'warning',
          action: 'log',
          message: `Tool abuse detected: ${consecutiveErrors} consecutive errors on tool "${lastToolName}"`,
          evidence: `${consecutiveErrors} consecutive tool:error events`,
          timestamp: new Date(),
        }
        // Reset after triggering
        consecutiveErrors = 0
        return violation
      }

      return null
    },
  }
}

// --- Escalation Detector ---

const ESCALATION_PATTERNS: RegExp[] = [
  /\bmodify\s+(my|your|own)\s+(permissions?|roles?|access|config)/i,
  /\bgrant\s+(me|myself|admin|root)\b/i,
  /\bescalate\s+(privileges?|permissions?|access)/i,
  /\bsudo\b/,
  /\bchmod\s+[0-7]*7[0-7]*/,
  /\bchown\s+root\b/i,
  /\bsecurity\.override\b/i,
  /\bdisable\s+(auth|authentication|authorization|security|sandbox)/i,
  /\bbypass\s+(auth|rbac|acl|permission|firewall)/i,
]

function createEscalationRule(): SafetyRule {
  return {
    id: 'builtin:escalation',
    category: 'escalation',
    severity: 'critical',
    action: 'block',
    check(content: string): SafetyViolation | null {
      for (const pattern of ESCALATION_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(content)
        if (match) {
          return {
            category: 'escalation',
            severity: 'critical',
            action: 'block',
            message: 'Privilege escalation attempt detected',
            evidence: match[0],
            timestamp: new Date(),
          }
        }
      }
      return null
    },
  }
}

/**
 * Returns all 5 built-in safety rules.
 */
export function getBuiltInRules(): SafetyRule[] {
  return [
    createInjectionRule(),
    createPIILeakRule(),
    createSecretLeakRule(),
    createToolAbuseRule(),
    createEscalationRule(),
  ]
}
