/**
 * SafetyMonitor — detects prompt injection, tool misuse, and data exfiltration.
 *
 * Runs pattern-based detection on agent inputs and outputs via DzupEventBus.
 * All detection is **non-blocking** — it never stops agent execution, only
 * records events and optionally emits alerts.
 *
 * @example
 * ```ts
 * const bus = createEventBus()
 * const monitor = new SafetyMonitor()
 * monitor.attach(bus)
 *
 * // After agent run:
 * const events = monitor.getEvents()
 * ```
 */

import type { DzupEventBus } from '@dzupagent/core'

// ------------------------------------------------------------------ Types

export type SafetyCategory =
  | 'prompt_injection_input'
  | 'prompt_injection_output'
  | 'tool_misuse'
  | 'memory_poisoning'
  | 'data_exfiltration'
  | 'excessive_resource_usage'

export type SafetySeverity = 'info' | 'warning' | 'critical'

export interface SafetyEvent {
  category: SafetyCategory
  severity: SafetySeverity
  message: string
  confidence: number // 0.0 - 1.0
  agentId?: string | undefined
  details?: Record<string, unknown> | undefined
  timestamp: Date
}

export interface SafetyPatternRule {
  pattern: RegExp
  category: SafetyCategory
  severity: SafetySeverity
}

export interface SafetyMonitorConfig {
  /** Patterns to detect in inputs (regex) */
  inputPatterns?: SafetyPatternRule[]
  /** Patterns to detect in outputs (regex) */
  outputPatterns?: SafetyPatternRule[]
  /** Consecutive tool failure threshold before alerting (default: 3) */
  toolFailureThreshold?: number
  /** Event bus for emitting safety events */
  eventBus?: DzupEventBus
}

// ------------------------------------------------------- Default patterns

const DEFAULT_INPUT_PATTERNS: SafetyPatternRule[] = [
  {
    pattern: /ignore\s+(?:all\s)?previous\s+instructions/i,
    category: 'prompt_injection_input',
    severity: 'critical',
  },
  {
    pattern: /system\s+prompt\s*:/i,
    category: 'prompt_injection_input',
    severity: 'critical',
  },
  {
    pattern: /<\|im_start\|>system/i,
    category: 'prompt_injection_input',
    severity: 'critical',
  },
  {
    pattern: /you\s+are\s+now\b/i,
    category: 'prompt_injection_input',
    severity: 'warning',
  },
  {
    pattern: /disregard\s+all\b/i,
    category: 'prompt_injection_input',
    severity: 'critical',
  },
  {
    pattern: /forget\s+(?:all\s)?(?:your\s)?(?:previous\s)?instructions/i,
    category: 'prompt_injection_input',
    severity: 'critical',
  },
]

const DEFAULT_OUTPUT_PATTERNS: SafetyPatternRule[] = [
  {
    // URLs with long base64-encoded query params (potential data exfiltration)
    pattern: /https?:\/\/[^\s]+\?[^\s]*[A-Za-z0-9+/=]{64,}/i,
    category: 'data_exfiltration',
    severity: 'warning',
  },
  {
    // data: URIs in outputs
    pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,/i,
    category: 'data_exfiltration',
    severity: 'warning',
  },
  {
    // Markdown image injection with external URL
    pattern: /!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/i,
    category: 'data_exfiltration',
    severity: 'info',
  },
]

// -------------------------------------------------------------- Class

export class SafetyMonitor {
  private readonly _inputPatterns: SafetyPatternRule[]
  private readonly _outputPatterns: SafetyPatternRule[]
  private readonly _toolFailureThreshold: number
  private readonly _events: SafetyEvent[] = []
  private _unsubscribes: Array<() => void> = []

  /** Tracks consecutive failures per tool */
  private readonly _toolFailures = new Map<string, number>()

  constructor(config?: SafetyMonitorConfig) {
    this._inputPatterns = [
      ...DEFAULT_INPUT_PATTERNS,
      ...(config?.inputPatterns ?? []),
    ]
    this._outputPatterns = [
      ...DEFAULT_OUTPUT_PATTERNS,
      ...(config?.outputPatterns ?? []),
    ]
    this._toolFailureThreshold = config?.toolFailureThreshold ?? 3

    if (config?.eventBus) {
      this.attach(config.eventBus)
    }
  }

  // ------------------------------------------------------ Lifecycle

  /**
   * Attach to a DzupEventBus.
   * Listens for tool:called (scan input), tool:result (scan output),
   * and tool:error (track consecutive failures).
   */
  attach(eventBus: DzupEventBus): void {
    this.detach()

    this._unsubscribes.push(
      eventBus.on('tool:called', (e) => {
        try {
          const inputStr = typeof e.input === 'string'
            ? e.input
            : JSON.stringify(e.input)
          this.scanInput(inputStr)
        } catch {
          // Non-blocking — swallow errors
        }
      }),

      eventBus.on('tool:error', (e) => {
        try {
          this._trackToolFailure(e.toolName, e.message)
        } catch {
          // Non-blocking
        }
      }),

      eventBus.on('tool:result', (e) => {
        // Reset consecutive failure counter on success
        this._toolFailures.set(e.toolName, 0)
      }),
    )
  }

  /**
   * Detach from the event bus.
   */
  detach(): void {
    for (const unsub of this._unsubscribes) {
      unsub()
    }
    this._unsubscribes = []
  }

  // --------------------------------------------------- Scanning

  /**
   * Scan text for input injection patterns.
   * Returns any detected safety events.
   */
  scanInput(text: string, agentId?: string): SafetyEvent[] {
    return this._scan(text, this._inputPatterns, agentId)
  }

  /**
   * Scan text for output exfiltration/injection patterns.
   * Returns any detected safety events.
   */
  scanOutput(text: string, agentId?: string): SafetyEvent[] {
    return this._scan(text, this._outputPatterns, agentId)
  }

  /**
   * Get all recorded safety events.
   */
  getEvents(): SafetyEvent[] {
    return [...this._events]
  }

  /**
   * Clear all recorded events and failure counters.
   */
  reset(): void {
    this._events.length = 0
    this._toolFailures.clear()
  }

  // --------------------------------------------------- Internal

  private _scan(
    text: string,
    patterns: SafetyPatternRule[],
    agentId?: string,
  ): SafetyEvent[] {
    const detected: SafetyEvent[] = []

    for (const rule of patterns) {
      if (rule.pattern.test(text)) {
        const event: SafetyEvent = {
          category: rule.category,
          severity: rule.severity,
          message: `Pattern detected: ${rule.pattern.source}`,
          confidence: rule.severity === 'critical' ? 0.9 : 0.7,
          agentId,
          details: { pattern: rule.pattern.source },
          timestamp: new Date(),
        }
        detected.push(event)
        this._events.push(event)
      }
    }

    return detected
  }

  private _trackToolFailure(toolName: string, message: string): void {
    const count = (this._toolFailures.get(toolName) ?? 0) + 1
    this._toolFailures.set(toolName, count)

    if (count >= this._toolFailureThreshold) {
      const event: SafetyEvent = {
        category: 'tool_misuse',
        severity: 'warning',
        message: `Tool "${toolName}" failed ${count} consecutive times: ${message}`,
        confidence: 0.8,
        details: { toolName, consecutiveFailures: count },
        timestamp: new Date(),
      }
      this._events.push(event)
    }
  }
}
