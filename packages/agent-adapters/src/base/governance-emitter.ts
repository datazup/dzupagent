import type { AdapterProviderId, GovernanceEvent } from '../types.js'

export interface RunContext {
  runId: string
  sessionId: string
}

export interface RuleViolation {
  ruleId: string
  severity: 'warn' | 'block'
  detail: string
}

export type RuleViolationCallback = (
  ruleId: string,
  severity: 'warn' | 'block',
  detail: string,
) => void

export interface GuardrailsLike {
  onRuleViolation?: RuleViolationCallback
  getOnRuleViolation?: () => RuleViolationCallback | undefined
  setOnRuleViolation?: (cb: RuleViolationCallback | undefined) => void
}

export interface EmitRuleViolationOpts {
  ruleId: string
  severity: 'warn' | 'block'
  detail: string
  runId?: string
  sessionId?: string
  timestamp?: number
}

/**
 * Governance side-channel emitter for CLI-backed adapters.
 *
 * Manages the listener set, the run-scoped correlation context, and the
 * helpers used to publish approval/authorization decisions, hook
 * executions, rule violations, and dangerous-command detections.
 *
 * `BaseCliAdapter` composes one of these — composition is preferred over
 * inheritance so the governance plane can be unit-tested in isolation.
 */
export class GovernanceEmitter {
  private listeners = new Set<(event: GovernanceEvent) => void>()
  private runContext: RunContext | null = null

  constructor(private readonly providerId: AdapterProviderId) {}

  /**
   * Subscribe to governance events. Returns an unsubscribe function.
   * Errors thrown inside listeners are swallowed so they cannot break the
   * adapter event loop.
   */
  onGovernanceEvent(listener: (event: GovernanceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Emit a governance event to all registered listeners. Listener errors
   * are intentionally swallowed to protect the event loop.
   */
  emit(event: GovernanceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* listener errors must not break the adapter event loop */
      }
    }
  }

  /** Set the run-scoped correlation context (called at top of execute). */
  setRunContext(context: RunContext | null): void {
    this.runContext = context
  }

  /** Get the current run context, if any. */
  getRunContext(): RunContext | null {
    return this.runContext
  }

  /**
   * Emit a `governance:rule_violation` event on the governance side-channel.
   *
   * Stamps the currently-active run context (set via {@link setRunContext})
   * unless an explicit `runId` / `sessionId` is supplied.
   */
  emitRuleViolation(opts: EmitRuleViolationOpts): void {
    const ctx = this.runContext
    const runId = opts.runId ?? ctx?.runId ?? ''
    const sessionId = opts.sessionId ?? ctx?.sessionId
    const event: GovernanceEvent = {
      type: 'governance:rule_violation',
      runId,
      providerId: this.providerId,
      timestamp: opts.timestamp ?? Date.now(),
      ruleId: opts.ruleId,
      severity: opts.severity,
      detail: opts.detail,
      ...(sessionId ? { sessionId } : {}),
    }
    this.emit(event)
  }

  /**
   * Wire an {@link AdapterGuardrails}-like object so its `onRuleViolation`
   * callback is routed into this governance side-channel.
   *
   * The supplied object is mutated: its `onRuleViolation` field is replaced
   * with a composed callback that first forwards to any existing callback
   * and then emits a `governance:rule_violation` event.
   */
  attachGuardrails(guardrails: GuardrailsLike): void {
    const existing = guardrails.getOnRuleViolation
      ? guardrails.getOnRuleViolation()
      : guardrails.onRuleViolation
    const composed = (
      ruleId: string,
      severity: 'warn' | 'block',
      detail: string,
    ): void => {
      try {
        existing?.(ruleId, severity, detail)
      } catch {
        /* host callback errors must not break governance emission */
      }
      this.emitRuleViolation({ ruleId, severity, detail })
    }
    if (guardrails.setOnRuleViolation) {
      guardrails.setOnRuleViolation(composed)
    } else {
      guardrails.onRuleViolation = composed
    }
  }

  /**
   * Detect a hook-execution record on the JSONL stream and emit a
   * `governance:hook_executed` event when one is found. Returns `true` if
   * the record was recognized as a hook execution, `false` otherwise.
   *
   * Providers signal hook runs via:
   * - `type: 'hook_execution'` (Codex pattern)
   * - top-level `hookName` / `hook_name`
   * - nested `hook.name`
   */
  emitHookExecutedIfRecognized(
    record: Record<string, unknown>,
    fallbackContext: { runId: string; sessionId: string },
  ): boolean {
    const recordType = typeof record.type === 'string' ? record.type : ''
    const topLevelHookName =
      (typeof record.hookName === 'string' && record.hookName.length > 0
        ? record.hookName
        : undefined) ??
      (typeof record.hook_name === 'string' && record.hook_name.length > 0
        ? record.hook_name
        : undefined)
    const nestedHookName =
      record.hook &&
      typeof record.hook === 'object' &&
      typeof (record.hook as Record<string, unknown>).name === 'string'
        ? ((record.hook as Record<string, unknown>).name as string)
        : undefined
    const isHookRecord =
      recordType === 'hook_execution' || !!topLevelHookName || !!nestedHookName
    if (!isHookRecord) return false

    const hookName = topLevelHookName ?? nestedHookName ?? recordType
    const exitCode =
      typeof record.exitCode === 'number'
        ? record.exitCode
        : typeof record.exit_code === 'number'
        ? record.exit_code
        : typeof record.hook === 'object' &&
          record.hook !== null &&
          typeof (record.hook as Record<string, unknown>).exitCode === 'number'
        ? ((record.hook as Record<string, unknown>).exitCode as number)
        : undefined
    const runId = this.runContext?.runId ?? fallbackContext.runId
    const sessionId = this.runContext?.sessionId ?? fallbackContext.sessionId
    this.emit({
      type: 'governance:hook_executed',
      runId,
      sessionId,
      providerId: this.providerId,
      timestamp: Date.now(),
      hookName,
      ...(exitCode !== undefined ? { exitCode } : {}),
    })
    return true
  }

  /**
   * Validate a list of rules against a compile context using the supplied
   * validator callback. Any violations reported by the validator are
   * emitted as `governance:rule_violation` events and returned.
   */
  validateAndEmitRules<TRule, TContext>(
    rules: TRule[],
    context: TContext,
    validator: (rules: TRule[], context: TContext) => ReadonlyArray<RuleViolation>,
    opts?: { runId?: string; sessionId?: string },
  ): ReadonlyArray<RuleViolation> {
    let violations: ReadonlyArray<RuleViolation> = []
    try {
      violations = validator(rules, context)
    } catch {
      const runId = opts?.runId ?? this.runContext?.runId ?? ''
      const sessionId = opts?.sessionId ?? this.runContext?.sessionId
      this.emitRuleViolation({
        ruleId: 'rule_compile_error',
        severity: 'block',
        detail: 'Rule validator threw',
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
      })
      return []
    }
    for (const v of violations) {
      this.emitRuleViolation({
        ruleId: v.ruleId,
        severity: v.severity,
        detail: v.detail,
        ...(opts?.runId ? { runId: opts.runId } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      })
    }
    return violations
  }
}
