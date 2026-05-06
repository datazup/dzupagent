/**
 * Built-in safety rules for the Runtime Safety Monitor.
 *
 * 5 rules:
 * 1. Prompt injection scanner (delegates to `@dzupagent/security`)
 * 2. PII leak scanner (delegates to `@dzupagent/security`)
 * 3. Secret leak scanner (regex-based, host-specific)
 * 4. Tool abuse detector (consecutive tool:error events)
 * 5. Escalation detector (permission/config modification attempts)
 *
 * Rules 1 and 2 call through to the canonical scanners exported by
 * `@dzupagent/security` so DzupAgent has a single source of truth for
 * prompt-injection and PII detection.
 */

import {
  PromptInjectionDetector,
  PiiDetector,
  type InjectionFinding,
  type PiiMatch,
} from '@dzupagent/security'

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

/**
 * Callback shape for delegating prompt-injection detection to a host-supplied
 * scanner. Allows downstream consumers to swap the canonical
 * `@dzupagent/security` detector for an enterprise/custom implementation
 * without forking the safety monitor.
 */
export interface InjectionScannerCallback {
  (content: string): { detected: boolean; confidence: number; pattern?: string }
}

/**
 * Callback shape for delegating PII detection to a host-supplied scanner.
 */
export interface PiiScannerCallback {
  (content: string): { detected: boolean; types: string[]; sample?: string }
}

// --- Default canonical scanners (singletons) ---

const defaultInjectionDetector = new PromptInjectionDetector()
const defaultPiiDetector = new PiiDetector()

const defaultInjectionScanner: InjectionScannerCallback = (content) => {
  const result = defaultInjectionDetector.scan(content, 'warn')
  if (result.findings.length === 0) {
    return { detected: false, confidence: 0 }
  }
  const top = result.findings[0] as InjectionFinding
  return {
    detected: true,
    // Confidence proxy: more findings = higher confidence (capped at 1).
    confidence: Math.min(1, 0.5 + 0.1 * result.findings.length),
    pattern: top.match,
  }
}

const defaultPiiScanner: PiiScannerCallback = (content) => {
  const result = defaultPiiDetector.scanDetailed(content)
  if (!result.hasPii) {
    return { detected: false, types: [] }
  }
  const sample = result.matches.length > 0 ? (result.matches[0] as PiiMatch).value : undefined
  return {
    detected: true,
    types: result.types,
    ...(sample !== undefined ? { sample } : {}),
  }
}

// --- Prompt Injection Rule (delegates to canonical scanner) ---

export function createInjectionRule(scanner: InjectionScannerCallback = defaultInjectionScanner): SafetyRule {
  return {
    id: 'builtin:prompt-injection',
    category: 'prompt_injection',
    severity: 'critical',
    action: 'block',
    check(content: string): SafetyViolation | null {
      const result = scanner(content)
      if (!result.detected) return null
      return {
        category: 'prompt_injection',
        severity: 'critical',
        action: 'block',
        message: 'Prompt injection attempt detected',
        evidence: result.pattern ?? '[redacted]',
        timestamp: new Date(),
      }
    },
  }
}

// --- PII Leak Rule (delegates to canonical scanner) ---

export function createPIILeakRule(scanner: PiiScannerCallback = defaultPiiScanner): SafetyRule {
  return {
    id: 'builtin:pii-leak',
    category: 'pii_leak',
    severity: 'warning',
    action: 'log',
    check(content: string): SafetyViolation | null {
      const result = scanner(content)
      if (!result.detected) return null
      const label = result.types[0] ?? 'PII'
      return {
        category: 'pii_leak',
        severity: 'warning',
        action: 'log',
        message: `PII detected: ${label}`,
        evidence: result.sample ?? label,
        timestamp: new Date(),
      }
    },
  }
}

// --- Secret Leak Patterns (host-specific, not in canonical scanner) ---

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
export function createToolAbuseRule(threshold = 5): SafetyRule {
  const maxConsecutiveErrors = Number.isFinite(threshold) && threshold > 0
    ? Math.floor(threshold)
    : 5
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
      consecutiveErrors = toolName === lastToolName ? consecutiveErrors + 1 : 1
      lastToolName = toolName

      if (consecutiveErrors >= maxConsecutiveErrors) {
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

// --- Escalation Detector (host-specific, not in canonical scanner) ---

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

export function createEscalationRule(): SafetyRule {
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
 * Returns all 5 built-in safety rules. Consumers MAY pass custom scanner
 * callbacks for the prompt-injection and PII rules; when omitted, the
 * canonical scanners from `@dzupagent/security` are used.
 */
export function getBuiltInRules(options?: {
  injectionScanner?: InjectionScannerCallback
  piiScanner?: PiiScannerCallback
}): SafetyRule[] {
  return [
    createInjectionRule(options?.injectionScanner),
    createPIILeakRule(options?.piiScanner),
    createSecretLeakRule(),
    createToolAbuseRule(),
    createEscalationRule(),
  ]
}

export {
  createSecretLeakRule,
}
