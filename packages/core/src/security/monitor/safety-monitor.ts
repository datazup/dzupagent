/**
 * Runtime Safety Monitor — watches agent activity for security violations.
 *
 * Subscribes to DzupEventBus and scans content on-demand using configurable
 * SafetyRules. Violations are recorded and emitted as safety events.
 *
 * The `prompt_injection` and `pii_leak` rules delegate to the canonical
 * scanners in `@dzupagent/security`. Hosts MAY override those scanners by
 * passing `injectionScanner` / `piiScanner` callbacks, and MAY drive
 * runtime policy via {@link SafetyMonitorConfig.policy}.
 */

import type { SecurityPolicyConfig } from '@dzupagent/security'
import type { DzupEventBus } from '../../events/event-bus.js'
import type {
  SafetyCategory,
  SafetySeverity,
  SafetyAction,
  SafetyViolation,
  SafetyRule,
  InjectionScannerCallback,
  PiiScannerCallback,
} from './built-in-rules.js'
import {
  createInjectionRule,
  createPIILeakRule,
  createToolAbuseRule,
  createEscalationRule,
  createSecretLeakRule,
} from './built-in-rules.js'

export type {
  SafetyCategory,
  SafetySeverity,
  SafetyAction,
  SafetyViolation,
  SafetyRule,
  InjectionScannerCallback,
  PiiScannerCallback,
}

export interface SafetyMonitorConfig {
  /** Custom rules to use instead of (or in addition to) built-in rules */
  rules?: SafetyRule[]
  /** If true, provided rules replace built-in rules; otherwise they extend them */
  replaceBuiltInRules?: boolean
  /** Event bus to attach to */
  eventBus?: DzupEventBus
  /**
   * Optional canonical injection scanner override. When omitted, the
   * canonical detector from `@dzupagent/security` is used.
   */
  injectionScanner?: InjectionScannerCallback
  /**
   * Optional canonical PII scanner override. When omitted, the canonical
   * detector from `@dzupagent/security` is used.
   */
  piiScanner?: PiiScannerCallback
  /**
   * Unified security policy. When provided:
   * - `'off'` skips the corresponding rule entirely.
   * - `'warn'` / `'redact'` reduces severity to `'warning'` (formerly
   *   surfaced as `'medium'` in some hosts) and downgrades the rule action
   *   to `'log'`.
   * - `'block'` keeps the rule's default severity / action.
   *
   * Tool-abuse threshold is taken from `policy.toolAbuse.maxCallsPerTool`
   * when present.
   */
  policy?: SecurityPolicyConfig
}

export interface SafetyMonitor {
  /** Attach to an event bus, subscribing to relevant events */
  attach(eventBus: DzupEventBus): void
  /** Detach from the current event bus */
  detach(): void
  /** Scan content on-demand and return all violations found */
  scanContent(content: string, context?: Record<string, unknown>): SafetyViolation[]
  /** Get all recorded violations */
  getViolations(): ReadonlyArray<SafetyViolation>
  /** Clear recorded violations and unsubscribe */
  dispose(): void
}

type PolicyLevel = 'off' | 'warn' | 'block'

function normalizeInjectionPolicy(value: 'off' | 'warn' | 'block' | undefined): PolicyLevel {
  return value ?? 'block'
}

function normalizePiiPolicy(value: 'off' | 'redact' | 'block' | undefined): PolicyLevel {
  if (value === undefined) return 'block'
  if (value === 'redact') return 'warn'
  return value
}

function applyPolicyToRule(rule: SafetyRule, level: PolicyLevel): SafetyRule | null {
  if (level === 'off') return null
  if (level === 'block') return rule
  // 'warn' — downgrade severity + action while preserving identity / category.
  return {
    ...rule,
    severity: 'warning',
    action: 'log',
    check(content, context) {
      const v = rule.check(content, context)
      if (!v) return null
      return { ...v, severity: 'warning', action: 'log' }
    },
  }
}

/**
 * Build the rule set honouring an optional unified policy.
 */
function buildBuiltInRules(config?: SafetyMonitorConfig): SafetyRule[] {
  const policy = config?.policy
  const rules: SafetyRule[] = []

  // Prompt-injection (delegates to @dzupagent/security)
  const injectionLevel = normalizeInjectionPolicy(policy?.promptInjection)
  const injectionRule = applyPolicyToRule(
    createInjectionRule(config?.injectionScanner),
    injectionLevel,
  )
  if (injectionRule) rules.push(injectionRule)

  // PII leak (delegates to @dzupagent/security)
  const piiLevel = normalizePiiPolicy(policy?.pii)
  const piiRule = applyPolicyToRule(createPIILeakRule(config?.piiScanner), piiLevel)
  if (piiRule) rules.push(piiRule)

  // Secret leak — always on; not part of the unified policy surface.
  rules.push(createSecretLeakRule())

  // Tool abuse — host-specific, threshold may come from policy.
  const threshold = policy?.toolAbuse?.maxCallsPerTool ?? 5
  rules.push(createToolAbuseRule(threshold))

  // Escalation — driven by policy.escalation.
  const escalationLevel: PolicyLevel = policy?.escalation ?? 'block'
  const escalationRule = applyPolicyToRule(createEscalationRule(), escalationLevel)
  if (escalationRule) rules.push(escalationRule)

  return rules
}

/**
 * Create a new SafetyMonitor instance with the given configuration.
 */
export function createSafetyMonitor(config?: SafetyMonitorConfig): SafetyMonitor {
  const builtIn = config?.replaceBuiltInRules ? [] : buildBuiltInRules(config)
  const rules: SafetyRule[] = [...builtIn, ...(config?.rules ?? [])]
  const violations: SafetyViolation[] = []
  let unsubscribers: Array<() => void> = []
  let currentBus: DzupEventBus | undefined

  function recordViolation(violation: SafetyViolation, bus?: DzupEventBus): void {
    violations.push(violation)
    const emitBus = bus ?? currentBus
    if (!emitBus) return

    try {
      emitBus.emit({
        type: 'safety:violation',
        category: violation.category,
        severity: violation.severity,
        message: violation.message,
        ...(violation.agentId !== undefined && { agentId: violation.agentId }),
      })

      if (violation.action === 'block') {
        emitBus.emit({
          type: 'safety:blocked',
          category: violation.category,
          action: violation.action,
          ...(violation.agentId !== undefined && { agentId: violation.agentId }),
        })
      } else if (violation.action === 'kill') {
        emitBus.emit({
          type: 'safety:kill_requested',
          agentId: violation.agentId ?? 'unknown',
          reason: violation.message,
        })
      }
    } catch {
      // Non-fatal: event emission failure should not crash the monitor
    }
  }

  function scanContent(content: string, context?: Record<string, unknown>): SafetyViolation[] {
    const found: SafetyViolation[] = []
    for (const rule of rules) {
      try {
        const violation = rule.check(content, context)
        if (violation) {
          found.push(violation)
          recordViolation(violation)
        }
      } catch {
        // Non-fatal: individual rule failure should not block scanning
      }
    }
    return found
  }

  function attach(eventBus: DzupEventBus): void {
    // Detach from any previous bus first
    detach()
    currentBus = eventBus

    // Subscribe to tool:error events for tool abuse detection
    const unsubToolError = eventBus.on('tool:error', (event) => {
      // Scan the error message for potential security issues
      scanContent(event.message, { source: 'tool:error', toolName: event.toolName })
    })
    unsubscribers.push(unsubToolError)

    // Subscribe to memory:written events for memory poisoning detection
    const unsubMemoryWritten = eventBus.on('memory:written', (event) => {
      scanContent(event.key, { source: 'memory:written', namespace: event.namespace })
    })
    unsubscribers.push(unsubMemoryWritten)
  }

  function detach(): void {
    for (const unsub of unsubscribers) {
      try {
        unsub()
      } catch {
        // Non-fatal
      }
    }
    unsubscribers = []
    currentBus = undefined
  }

  function dispose(): void {
    detach()
    violations.length = 0
  }

  const monitor: SafetyMonitor = {
    attach,
    detach,
    scanContent,
    getViolations: () => [...violations],
    dispose,
  }

  // Auto-attach if an event bus was provided in config
  if (config?.eventBus) {
    attach(config.eventBus)
  }

  return monitor
}
