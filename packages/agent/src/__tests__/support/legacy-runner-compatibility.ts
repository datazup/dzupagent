import type { AgentRunJsonValue } from '@dzupagent/agent-types/run'

export type LegacyRunnerCompatibilityCapability =
  | 'ordered-text-items'
  | 'read-calls'
  | 'usage'
  | 'terminal-outcome'
  | 'pre-dispatch-cancellation'
  | 'memory'
  | 'guardrails'
  | 'middleware'
  | 'structured-output'
  | 'streaming-deltas'
  | 'run-handle-control'

export type LegacyRunnerCompatibilityReason =
  | 'exact-match'
  | 'value-mismatch'
  | 'measurement-unavailable'
  | 'outcome-provenance-not-comparable'
  | 'scenario-not-observed'
  | 'runner-obligation-not-represented'

export interface CompatibilityTextItem {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface CompatibilityRead {
  readonly callId: string
  readonly toolId: string
  readonly arguments: AgentRunJsonValue
  readonly result: AgentRunJsonValue
}

export interface CompatibilityUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export type CompatibilityTerminalOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled-before-dispatch' }
  | { readonly status: 'failed-before-dispatch'; readonly code: string }
  | { readonly status: 'outcome-unknown'; readonly code: string }
  | { readonly status: 'failed'; readonly code: string }

export interface LegacyRunnerCompatibilityObservation {
  readonly orderedTextItems: readonly CompatibilityTextItem[]
  readonly reads: readonly CompatibilityRead[]
  readonly usage?: CompatibilityUsage
  readonly outcome: CompatibilityTerminalOutcome
  readonly dispatches: {
    readonly model: number
    readonly tool: number
  }
}

export type LegacyRunnerCompatibilityComparison =
  | {
      readonly capability: LegacyRunnerCompatibilityCapability
      readonly status: 'exact'
      readonly reason: 'exact-match'
    }
  | {
      readonly capability: LegacyRunnerCompatibilityCapability
      readonly status: 'different'
      readonly reason: 'value-mismatch' | 'outcome-provenance-not-comparable'
    }
  | {
      readonly capability: LegacyRunnerCompatibilityCapability
      readonly status: 'unsupported'
      readonly reason:
        | 'measurement-unavailable'
        | 'outcome-provenance-not-comparable'
        | 'scenario-not-observed'
        | 'runner-obligation-not-represented'
    }

function exact(capability: LegacyRunnerCompatibilityCapability): LegacyRunnerCompatibilityComparison {
  return { capability, status: 'exact', reason: 'exact-match' }
}

function different(
  capability: LegacyRunnerCompatibilityCapability,
  reason: 'value-mismatch' | 'outcome-provenance-not-comparable' = 'value-mismatch',
): LegacyRunnerCompatibilityComparison {
  return { capability, status: 'different', reason }
}

export function unsupportedLegacyRunnerCapability(
  capability: LegacyRunnerCompatibilityCapability,
  reason: Exclude<LegacyRunnerCompatibilityReason, 'exact-match' | 'value-mismatch'> =
    'runner-obligation-not-represented',
): LegacyRunnerCompatibilityComparison {
  return { capability, status: 'unsupported', reason }
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function compareCompletedLegacyRunnerExecution(
  legacy: LegacyRunnerCompatibilityObservation,
  runner: LegacyRunnerCompatibilityObservation,
): readonly LegacyRunnerCompatibilityComparison[] {
  const usage = legacy.usage === undefined || runner.usage === undefined
    ? unsupportedLegacyRunnerCapability('usage', 'measurement-unavailable')
    : equal(legacy.usage, runner.usage)
      ? exact('usage')
      : different('usage')

  return [
    equal(legacy.orderedTextItems, runner.orderedTextItems)
      ? exact('ordered-text-items')
      : different('ordered-text-items'),
    equal(legacy.reads, runner.reads)
      ? exact('read-calls')
      : different('read-calls'),
    usage,
    compareTerminalOutcome(legacy.outcome, runner.outcome),
  ]
}

export function compareTerminalOutcome(
  legacy: CompatibilityTerminalOutcome,
  runner: CompatibilityTerminalOutcome,
): LegacyRunnerCompatibilityComparison {
  const legacyCode = 'code' in legacy ? legacy.code : undefined
  const runnerCode = 'code' in runner ? runner.code : undefined
  if (legacy.status === 'outcome-unknown' || runner.status === 'outcome-unknown') {
    return legacy.status === runner.status && legacyCode === runnerCode
      ? exact('terminal-outcome')
      : unsupportedLegacyRunnerCapability(
          'terminal-outcome',
          'outcome-provenance-not-comparable',
        )
  }

  if (legacy.status === 'failed' || runner.status === 'failed') {
    return legacy.status === runner.status && legacyCode === runnerCode
      ? exact('terminal-outcome')
      : different('terminal-outcome', 'outcome-provenance-not-comparable')
  }

  return equal(legacy, runner)
    ? exact('terminal-outcome')
    : different('terminal-outcome')
}

export function comparePreDispatchCancellation(
  legacy: LegacyRunnerCompatibilityObservation,
  runner: LegacyRunnerCompatibilityObservation,
): LegacyRunnerCompatibilityComparison {
  const observed = legacy.outcome.status === 'cancelled-before-dispatch'
    && runner.outcome.status === 'cancelled-before-dispatch'
  if (!observed) {
    return unsupportedLegacyRunnerCapability(
      'pre-dispatch-cancellation',
      'scenario-not-observed',
    )
  }

  return equal(legacy.dispatches, { model: 0, tool: 0 })
      && equal(runner.dispatches, { model: 0, tool: 0 })
    ? exact('pre-dispatch-cancellation')
    : different('pre-dispatch-cancellation')
}
