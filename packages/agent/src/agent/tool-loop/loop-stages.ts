/**
 * Staged helpers extracted from `runToolLoop` (RF-03).
 *
 * Each helper takes a `ToolLoopState` value object and returns a typed
 * transition. They are deliberately callable without constructing a full
 * `DzupAgent` so unit tests can drive them directly.
 */
import {
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core/llm'
import type { IterationBudget } from '../../guardrails/iteration-budget.js'
import { StuckError } from '../stuck-error.js'
import type { ToolCallResult } from './contracts.js'
import type { StopReason, ToolLoopConfig, ToolStat } from '../tool-loop.js'

/**
 * Marker prefix used to identify tool-stats hint SystemMessages so we can
 * replace (not duplicate) them each iteration.
 */
export const TOOL_STATS_HINT_PREFIX = 'Tool performance hint:'

/**
 * Mutable per-iteration state threaded through the loop helpers.
 *
 * Helpers mutate this in place to keep the call-site shape close to the
 * pre-extraction inline form (and to avoid awkward tuple returns from the
 * parts that record usage / push messages).
 */
export interface ToolLoopState {
  messages: BaseMessage[]
  totalInputTokens: number
  totalOutputTokens: number
  stuckStage: number
  lastStuckToolName: string | undefined
  lastStuckReason: string | undefined
}

/** Structural slice of `ToolStatsTracker` consumed by the hint injector. */
export interface ToolStatsHintSource {
  formatAsPromptHint(limit?: number, intent?: string): string
}

/** Loop transition signal returned by `handleToolResults`. */
export type LoopTransition =
  | { kind: 'continue' }
  | { kind: 'halt'; stopReason: StopReason }

/**
 * Refresh the tool-stats hint SystemMessage in-place. Removes any prior hint
 * and inserts the latest formatted ranking after the trailing system block so
 * the LLM always sees the most recent per-intent ordering.
 */
export function injectToolStatsHint(
  messages: BaseMessage[],
  tracker: ToolStatsHintSource | undefined,
  intent: string | undefined,
): void {
  if (!tracker) return

  // Remove previous hint message (there is at most one).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (
      m._getType() === 'system'
      && typeof m.content === 'string'
      && m.content.startsWith(TOOL_STATS_HINT_PREFIX)
    ) {
      messages.splice(i, 1)
      break
    }
  }

  const hint = tracker.formatAsPromptHint(5, intent)
  if (hint) {
    const insertIdx = messages.findIndex(m => m._getType() !== 'system')
    const hintMsg = new SystemMessage(`${TOOL_STATS_HINT_PREFIX}\n${hint}`)
    messages.splice(insertIdx >= 0 ? insertIdx : messages.length, 0, hintMsg)
  }
}

/**
 * Record token usage from a single LLM turn into both the loop state and the
 * iteration budget, surfacing budget warnings via the supplied callback.
 */
export function recordTurnUsage(
  state: ToolLoopState,
  usage: TokenUsage,
  budget: IterationBudget | undefined,
  callbacks: {
    onUsage?: (usage: TokenUsage) => void
    onBudgetWarning?: (message: string) => void
  },
): void {
  state.totalInputTokens += usage.inputTokens
  state.totalOutputTokens += usage.outputTokens
  callbacks.onUsage?.(usage)

  if (budget) {
    const warnings = budget.recordUsage(usage)
    for (const w of warnings) {
      callbacks.onBudgetWarning?.(w.message)
    }
  }
}

/**
 * Best-effort token-lifecycle compression. Swaps in the shrunken history when
 * the hook reports `compressed: true` and never throws — compression must
 * never abort an otherwise-healthy run. When the hook itself throws, a
 * sanitized `context:compress_failed` event is emitted to the configured
 * event bus (M-01) for observability.
 */
export async function maybeCompressTurn(
  state: ToolLoopState,
  config: Pick<ToolLoopConfig, 'maybeCompress' | 'onCompressed' | 'eventBus'>,
): Promise<void> {
  if (!config.maybeCompress) return
  try {
    const before = state.messages.length
    const compressResult = await config.maybeCompress(state.messages)
    if (compressResult.compressed) {
      state.messages.length = 0
      state.messages.push(...compressResult.messages)
      config.onCompressed?.({
        before,
        after: state.messages.length,
        summary: compressResult.summary,
      })
    }
  } catch (err) {
    // Compression must never abort a run — emit event for observability then continue.
    config.eventBus?.emit({
      type: 'context:compress_failed',
      error: err instanceof Error ? err.message : String(err),
      phase: 'tool-loop',
    })
  }
}

/**
 * Drain the per-iteration tool-call results into the conversation, applying
 * approval-gating and the 3-stage stuck-recovery escalation policy.
 *
 * Returns either `{ kind: 'continue' }` to allow the outer loop to proceed to
 * the next iteration, or `{ kind: 'halt', stopReason }` to terminate.
 */
export async function handleToolResults(
  results: ToolCallResult[],
  state: ToolLoopState,
  config: Pick<
    ToolLoopConfig,
    'onStuck' | 'recoverFromCheckpoint' | 'onCheckpointRecovered'
  >,
): Promise<LoopTransition> {
  let approvalPending = false
  let halt: StopReason | undefined

  for (const r of results) {
    state.messages.push(r.message)

    if (r.approvalPending) {
      // Hard gate (RF-AGENT-04): drain remaining messages but suppress
      // further escalation handling. Loop terminates after this drain.
      approvalPending = true
      continue
    }

    if (r.stuckToolName) {
      state.stuckStage++
      state.lastStuckToolName = r.stuckToolName
      state.lastStuckReason = r.stuckReason
      config.onStuck?.(r.stuckToolName, state.stuckStage)

      if (state.stuckStage === 2) {
        // Stage 2: try checkpoint-aware recovery first (opt-in).
        let recovered = false
        if (config.recoverFromCheckpoint) {
          try {
            const result = await config.recoverFromCheckpoint({
              toolName: r.stuckToolName,
              reason: r.stuckReason ?? 'stuck',
            })
            if (result?.restored) {
              recovered = true
              if (result.nudge) {
                state.messages.push(result.nudge)
              }
              config.onCheckpointRecovered?.({
                toolName: r.stuckToolName,
                reason: r.stuckReason ?? 'stuck',
                ...(result.checkpointId !== undefined
                  ? { checkpointId: result.checkpointId }
                  : {}),
              })
              state.stuckStage = 0
            }
          } catch {
            // Recovery hook failures are swallowed — recovery is
            // best-effort and must never escalate the problem.
          }
        }
        if (!recovered) {
          state.messages.push(
            new SystemMessage(
              'You appear to be stuck repeating the same tool call. Try a different approach or provide your final answer.',
            ),
          )
        }
      }
      if (state.stuckStage >= 3) {
        halt = 'stuck'
        break
      }
    }

    if (r.stuckNudge && state.stuckStage <= 1) {
      state.messages.push(r.stuckNudge)
    }
    if (r.stuckBreak) {
      halt = 'stuck'
      break
    }
  }

  if (approvalPending) {
    return { kind: 'halt', stopReason: 'approval_pending' }
  }
  if (halt) {
    return { kind: 'halt', stopReason: halt }
  }
  return { kind: 'continue' }
}

/**
 * Append the budget-exceeded sentinel AIMessage that the loop has historically
 * produced when an iteration budget hits a hard limit. Kept as a tiny helper
 * so the hot loop reads as a sequence of named stages.
 */
export function appendBudgetExceededMessage(
  state: ToolLoopState,
  reason: string | undefined,
): void {
  state.messages.push(new AIMessage(`[Agent stopped: ${reason}]`))
}

/**
 * Check pre-turn guards that can stop the loop before the model is invoked.
 * Mirrors the historical inline abort/budget handling in `runToolLoop`.
 */
export function runPreIterationGuards(
  state: ToolLoopState,
  config: Pick<ToolLoopConfig, 'signal' | 'budget' | 'onBudgetWarning'>,
): LoopTransition {
  if (config.signal?.aborted) {
    return { kind: 'halt', stopReason: 'aborted' }
  }

  if (config.budget) {
    const check = config.budget.isExceeded()
    if (check.exceeded) {
      appendBudgetExceededMessage(state, check.reason)
      return { kind: 'halt', stopReason: 'budget_exceeded' }
    }

    const warnings = config.budget.recordIteration()
    for (const w of warnings) {
      config.onBudgetWarning?.(w.message)
    }
  }

  return { kind: 'continue' }
}

/**
 * Run the token lifecycle halt hook after model usage has been recorded.
 */
export function runPostTurnHaltCheck(
  config: Pick<ToolLoopConfig, 'shouldHalt' | 'onHalted'>,
): LoopTransition | null {
  if (!config.shouldHalt?.()) return null
  config.onHalted?.('token_exhausted')
  return { kind: 'halt', stopReason: 'token_exhausted' }
}

/**
 * Evaluate idle stuck detection after all tool calls in an iteration finish.
 */
export function runStuckDetectorCheck(
  state: ToolLoopState,
  toolCallCount: number,
  config: Pick<ToolLoopConfig, 'stuckDetector' | 'onStuckDetected'>,
): LoopTransition | null {
  if (!config.stuckDetector) return null

  const idleCheck = config.stuckDetector.recordIteration(toolCallCount)
  if (!idleCheck.stuck) return null

  const reason = idleCheck.reason ?? 'No progress detected'
  const recovery = 'Stopping due to idle iterations.'
  config.onStuckDetected?.(reason, recovery)
  state.lastStuckReason = reason
  return { kind: 'halt', stopReason: 'stuck' }
}

/**
 * Emit a best-effort run-state snapshot at the end of an iteration.
 */
export function emitIterationSnapshot(
  state: ToolLoopState,
  iteration: number,
  llmCalls: number,
  config: Pick<ToolLoopConfig, 'onIteration'>,
): void {
  if (!config.onIteration) return
  try {
    config.onIteration({
      iteration: iteration + 1,
      messages: [...state.messages],
      totalInputTokens: state.totalInputTokens,
      totalOutputTokens: state.totalOutputTokens,
      llmCalls,
    })
  } catch {
    // Snapshot hooks must never disturb the run loop.
  }
}

/**
 * Convert mutable per-tool accumulators into the public ToolStat array.
 */
export function buildToolStats(
  statMap: Map<string, { calls: number; errors: number; totalMs: number }>,
): ToolStat[] {
  const toolStats: ToolStat[] = []
  for (const [name, stat] of statMap) {
    toolStats.push({
      name,
      calls: stat.calls,
      errors: stat.errors,
      totalMs: stat.totalMs,
      avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
    })
  }
  return toolStats
}

/**
 * Build a structured StuckError when the loop stops due to stuck detection.
 */
export function buildStuckError(
  stopReason: StopReason,
  state: ToolLoopState,
): StuckError | undefined {
  if (stopReason !== 'stuck') return undefined
  return new StuckError({
    reason: state.lastStuckReason ?? 'Agent stuck with no progress',
    ...(state.lastStuckToolName !== undefined
      ? { repeatedTool: state.lastStuckToolName }
      : {}),
    escalationLevel: (Math.max(1, Math.min(state.stuckStage, 3)) as 1 | 2 | 3),
  })
}
