/**
 * ReAct-style tool calling loop.
 *
 * Iteratively invokes the LLM, executes any tool calls it returns,
 * appends tool results, and re-invokes until the LLM produces a
 * final text response (no tool calls) or limits are reached.
 */
import {
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  type TokenUsage,
  type ToolGovernance,
  type SafetyMonitor,
  type DzupEventBus,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { CompressResult } from '@dzupagent/context'
import type { IterationBudget } from '../guardrails/iteration-budget.js'
import type { StuckDetector } from '../guardrails/stuck-detector.js'
import { StuckError } from './stuck-error.js'
import {
  type ToolArgValidatorConfig,
} from './tool-arg-validator.js'
import type { ToolCall } from './tool-loop/contracts.js'
import { executeModelTurn } from './tool-loop/model-turn-kernel.js'
import { executePolicyEnabledToolCall } from './tool-loop/policy-enabled-tool-executor.js'
import { scheduleToolCalls } from './tool-loop/tool-scheduler-kernel.js'
// Note: parallel-executor.ts still exports the standalone semaphore
// primitive (executeToolsParallel) for callers that want raw parallel
// dispatch without the policy stack. The tool-loop's parallel path was
// refactored to schedule the policy-enabled single-tool stage directly
// under its own semaphore, so the raw primitive is no longer used here.

/** Per-tool execution statistics. */
export interface ToolStat {
  name: string
  calls: number
  errors: number
  totalMs: number
  avgMs: number
}

/** Why the tool loop stopped. */
export type StopReason =
  | 'complete'
  | 'iteration_limit'
  | 'budget_exceeded'
  | 'aborted'
  | 'error'
  | 'stuck'
  | 'token_exhausted'
  /**
   * The loop halted because an approval-required tool was scheduled. The
   * tool was NOT executed; an `approval:requested` event was emitted to the
   * configured event bus carrying the durable runId. Resume of the
   * suspended call is handled by an external mechanism (typically
   * `ApprovalGate` listening for `approval:granted` / `approval:rejected`
   * and re-driving the run via the resume path) — the loop itself does not
   * implement resumption.
   */
  | 'approval_pending'

export type ToolResultScanFailureMode = 'fail-open' | 'fail-closed'

export interface ToolLoopConfig {
  maxIterations: number
  budget?: IterationBudget
  onUsage?: (usage: TokenUsage) => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (name: string, result: string) => void
  onBudgetWarning?: (message: string) => void
  /** Called after each tool invocation with its latency. */
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  invokeModel?: (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage>
  transformToolResult?: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  signal?: AbortSignal
  /** Optional stuck detector for escalating recovery. */
  stuckDetector?: StuckDetector
  /** Called when stuck is detected. */
  onStuckDetected?: (reason: string, recovery: string) => void

  /**
   * Execute independent tool calls in parallel via Promise.allSettled.
   * When disabled (default), tool calls run sequentially.
   */
  parallelTools?: boolean
  /**
   * Maximum number of tool calls to execute concurrently when parallelTools
   * is enabled. Prevents runaway parallelism. Default: 10.
   */
  maxParallelTools?: number

  /**
   * Validate tool arguments against the tool's schema before execution.
   * - `true` enables validation with autoRepair=true
   * - `{ autoRepair: false }` validates without repair
   * - `false` or `undefined` disables validation (default)
   */
  validateToolArgs?: boolean | ToolArgValidatorConfig

  /**
   * Optional tool stats tracker for injecting preferred-tool hints
   * into the system prompt before each LLM invocation.
   * Uses structural typing to avoid importing ToolStatsTracker from core.
   * The hint is refreshed every iteration so rankings reflect the latest stats.
   */
  toolStatsTracker?: { formatAsPromptHint: (limit?: number, intent?: string) => string }

  /** Current intent for per-intent tool ranking in toolStatsTracker hints. */
  intent?: string

  /**
   * Called when stuck is detected with the tool name and escalation stage.
   * Stage 1 = tool blocked, Stage 2 = nudge message injected, Stage 3 = loop aborted.
   */
  onStuck?: (toolName: string, stage: number) => void

  /**
   * Optional checkpoint-aware recovery hook (opt-in). When provided, the
   * tool loop will invoke it BEFORE escalating to stage 2 (nudge) on a
   * stuck detection. The hook should attempt to restore the most recent
   * checkpoint relevant to the run and return a result describing the
   * outcome:
   *   - `{ restored: true, ... }` — recovery succeeded; the loop swallows
   *     the stuck event (resets stage), optionally appends the returned
   *     `nudge` message, and continues the next iteration. The expectation
   *     is that the run state has been rolled back externally so the next
   *     LLM turn sees a sane snapshot.
   *   - `{ restored: false }` or `null`/`undefined` — recovery was not
   *     possible; the loop falls through to normal stage 2 behavior
   *     (nudge message) and, on the next stuck event, stage 3 (abort).
   *
   * Errors thrown from this hook are caught and treated as
   * `{ restored: false }` so a failing recovery never escalates the
   * problem.
   *
   * Rationale: agents that maintain section checkpoints (e.g. via the
   * Codev flow-runtime `checkpoint` node) can self-heal from common
   * loops without escalating to human approval. Agents without this
   * capability simply omit the hook and fall back to the existing
   * 3-stage policy.
   */
  recoverFromCheckpoint?: (info: {
    toolName: string
    reason: string
  }) => Promise<{
    restored: boolean
    /** Optional message to append to history when `restored === true`. */
    nudge?: SystemMessage
    /** Opaque id of the checkpoint that was used; surfaced via `onCheckpointRecovered`. */
    checkpointId?: string
  } | null | undefined>

  /**
   * Called when {@link recoverFromCheckpoint} restores the run successfully.
   * Useful for emitting a `run:checkpoint-recovered` telemetry event.
   */
  onCheckpointRecovered?: (info: {
    toolName: string
    reason: string
    checkpointId?: string
  }) => void

  /**
   * Check after each LLM turn — halt if token budget exhausted.
   *
   * Typically wired to {@link AgentLoopPlugin.shouldHalt} from the token
   * lifecycle plugin. Called after usage has been recorded on the LLM
   * response and BEFORE any tool calls in that turn are executed.
   */
  shouldHalt?: () => boolean

  /**
   * Invoked when the loop halts due to token exhaustion.
   *
   * Callers typically emit a `run:halted:token-exhausted` telemetry event
   * from this callback. It fires exactly once, immediately before the loop
   * breaks with `stopReason === 'token_exhausted'`.
   */
  onHalted?: (reason: 'token_exhausted') => void

  /**
   * Optional hook invoked after each LLM turn's `onUsage` call. When the
   * returned result has `compressed === true`, the tool loop replaces its
   * working message history with `result.messages` before the next
   * iteration.
   *
   * Typically wired to {@link AgentLoopPlugin.maybeCompress} from the
   * token lifecycle plugin — that plugin internally short-circuits when
   * pressure status is `ok` or `warn` and only triggers the actual
   * compression pipeline when pressure transitions to `critical` (or
   * `exhausted`).
   *
   * Errors thrown from this hook are swallowed (compression is best-effort
   * and must never abort an otherwise-healthy run).
   */
  maybeCompress?: (messages: BaseMessage[]) => Promise<CompressResult>

  /**
   * Called when `maybeCompress` returned `compressed: true` and the loop
   * adopted the shrunken message history. Useful for emitting a
   * `context:compressed` telemetry event.
   */
  onCompressed?: (info: { before: number; after: number; summary: string | null }) => void

  /**
   * Optional tool governance layer. When present, each tool call is checked
   * via {@link ToolGovernance.checkAccess}. Blocked tools return a
   * `[blocked]` ToolMessage instead of invoking the underlying tool.
   *
   * Tools whose `checkAccess` result reports `requiresApproval: true` are
   * treated as a HARD execution gate (audit fix RF-AGENT-04, approved by
   * the team 2026-04-26): the underlying tool is NOT invoked, an
   * `approval:requested` event is emitted (carrying {@link runId} as the
   * correlation id when provided, falling back to the local tool_call_id
   * otherwise), an `[approval_pending]` ToolMessage is appended to the
   * conversation, and the surrounding loop terminates with
   * `stopReason === 'approval_pending'`.
   *
   * Rationale: a notify-and-continue policy is unsafe for a framework that
   * markets human-in-the-loop because it lets the side-effecting call land
   * BEFORE the human decision arrives. A hard gate is the only correct
   * behaviour. Resume of an approval-pending run is a SEPARATE concern and
   * is NOT implemented inside the loop — typically the external
   * `ApprovalGate` listens for the approval event, captures the decision,
   * and re-drives the run via the run engine's resume path.
   */
  toolGovernance?: ToolGovernance

  /**
   * Optional safety monitor. When present, every tool result is scanned via
   * {@link SafetyMonitor.scanContent} for prompt-injection or other
   * violations before being appended to message history. Critical or
   * blocking violations replace the tool output with a safe rejection.
   */
  safetyMonitor?: SafetyMonitor

  /**
   * Disable scanning tool results via {@link safetyMonitor}.
   * Defaults to `true` when a safetyMonitor is provided; set to `false`
   * to opt out of scanning (e.g., when upstream scanning already happened).
   */
  scanToolResults?: boolean

  /**
   * Controls what happens when {@link safetyMonitor.scanContent} itself
   * throws while scanning a tool result.
   *
   * - `fail-open` preserves the legacy behavior: emit a sanitized
   *   `safety:violation` event when possible, then continue with the tool
   *   result.
   * - `fail-closed` withholds the tool result, emits a terminal
   *   `tool:error`, and returns a safe scanner-failure marker to the
   *   conversation.
   *
   * Defaults to `fail-open` for backwards compatibility.
   */
  scanFailureMode?: ToolResultScanFailureMode

  /**
   * Optional event bus. When present, the tool loop emits lifecycle events
   * such as `approval:requested` (for governance-gated tools).
   */
  eventBus?: DzupEventBus

  /**
   * Per-tool execution timeouts in milliseconds.
   *
   * When a tool is invoked, the runtime creates a per-call `AbortSignal`
   * and passes it through the LangChain tool invocation config. If the timer
   * fires first, the signal is aborted before the call rejects with
   * `ToolTimeoutError("Tool \"<name>\" timed out after <ms>ms")`. Tools that
   * honor the signal can stop underlying work; tools that ignore it still
   * receive an observational deadline and the surrounding loop records the
   * failure exactly as it would for any other tool error (stuck detection,
   * stats, latency callback, surfaced in the conversation as a `Tool error`
   * message).
   *
   * Enforces {@link ToolGovernanceConfig.maxExecutionMs} semantics at the
   * call-site instead of at the governance layer (governance declares the
   * policy; the loop enforces it). Tools not listed here run without an
   * explicit timeout.
   *
   * Example: `{ fetchUrl: 10_000, expensiveQuery: 60_000 }`.
   */
  toolTimeouts?: Record<string, number>

  /**
   * Optional OTel tracer for emitting one span per tool invocation.
   * Uses structural typing so the agent package does not have to depend on
   * `@dzupagent/otel`. Any object matching `DzupTracer`'s shape works —
   * `startToolSpan(name, options)` returns a span with a `setAttribute`
   * method and an `end()` method, `endSpanWithError(span, error)` closes
   * the span with an error status.
   */
  tracer?: ToolLoopTracer

  /**
   * Identity of the agent that owns this tool loop invocation.
   *
   * When combined with {@link toolPermissionPolicy}, each tool call is
   * checked with `policy.hasPermission(agentId, toolName)` before the
   * tool is invoked. Denied calls throw a
   * `TOOL_PERMISSION_DENIED` {@link ForgeError} with `{agentId, toolName}`
   * in `context`.
   *
   * Also threaded through the canonical tool lifecycle events
   * (`tool:called`, `tool:result`, `tool:error`) so consumers can
   * correlate provenance with the owning agent (RF-AGENT-05).
   */
  agentId?: string

  /**
   * Durable run identifier for canonical tool lifecycle events
   * (RF-AGENT-05). When set, emitted `tool:called` / `tool:result` /
   * `tool:error` events carry `{agentId, runId, toolCallId, ...}` so
   * downstream consumers (audit trail, replay viewer, OTel bridge) can
   * stitch provenance back to a specific run without sniffing message
   * text.
   *
   * Also used as the correlation id on `approval:requested` events
   * emitted when an approval-required tool is gated (RF-AGENT-04). When
   * omitted, the loop falls back to the LLM-supplied `tool_call_id`,
   * which works for in-process tests but is NOT durable across process
   * restarts — real workloads SHOULD set this.
   */
  runId?: string

  /**
   * Pluggable permission policy (MC-GA03). When omitted, no permission
   * checks run — preserves the pre-MC-GA03 surface for existing callers.
   *
   * The policy is consulted BOTH in the policy-enabled single-tool stage
   * and in the parallel pre-validation loop so denied calls never reach
   * `tool.invoke()` in either execution mode.
   */
  toolPermissionPolicy?: ToolPermissionPolicy
}

/**
 * Minimal tool span shape. Structurally compatible with OTel's `Span` and
 * with `@dzupagent/otel`'s `OTelSpan`. Only the calls made by the tool
 * loop are declared.
 */
export interface ToolLoopSpan {
  setAttribute(key: string, value: string | number | boolean): unknown
  end(): void
}

/**
 * Structural tracer interface for the tool loop. Compatible with
 * `DzupTracer` from `@dzupagent/otel` without importing it.
 */
export interface ToolLoopTracer {
  startToolSpan(
    toolName: string,
    options?: { inputSize?: number },
  ): ToolLoopSpan
  endSpanWithError(span: ToolLoopSpan, error: unknown): void
}

export interface ToolLoopResult {
  messages: BaseMessage[]
  totalInputTokens: number
  totalOutputTokens: number
  llmCalls: number
  /** @deprecated Use `stopReason` instead. Kept for backward compatibility. */
  hitIterationLimit: boolean
  /** Why the tool loop terminated. */
  stopReason: StopReason
  /** Per-tool execution statistics (latency, error counts). */
  toolStats: ToolStat[]
  /**
   * When `stopReason` is `'stuck'`, contains the structured StuckError
   * with reason, repeatedTool, and escalationLevel.
   */
  stuckError?: StuckError
}

/**
 * Run the ReAct tool-calling loop.
 *
 * @param model - LLM instance (should already have tools bound if applicable)
 * @param messages - Initial messages including system prompt
 * @param tools - Available tools (used for execution, not for binding)
 * @param config - Loop configuration
 */
export async function runToolLoop(
  model: BaseChatModel,
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
  config: ToolLoopConfig,
): Promise<ToolLoopResult> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const allMessages = [...messages]
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let llmCalls = 0
  let stopReason: StopReason = 'complete'

  // Mutable per-tool stat accumulators
  const statMap = new Map<string, { calls: number; errors: number; totalMs: number }>()

  function getOrCreateStat(name: string) {
    let stat = statMap.get(name)
    if (!stat) {
      stat = { calls: 0, errors: 0, totalMs: 0 }
      statMap.set(name, stat)
    }
    return stat
  }

  // Marker prefix used to identify tool-stats hint SystemMessages so we can
  // replace (not duplicate) them each iteration.
  const TOOL_STATS_HINT_PREFIX = 'Tool performance hint:'

  // Escalating stuck recovery stage: 0 = not stuck, 1 = tool blocked, 2 = nudge sent, 3 = abort
  let stuckStage = 0
  // Track the tool name and reason that triggered stuck, for building StuckError
  let lastStuckToolName: string | undefined
  let lastStuckReason: string | undefined

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    // Check abort signal
    if (config.signal?.aborted) {
      stopReason = 'aborted'
      break
    }

    // Check budget hard limits
    if (config.budget) {
      const check = config.budget.isExceeded()
      if (check.exceeded) {
        stopReason = 'budget_exceeded'
        // Add a message explaining why we stopped
        allMessages.push(new AIMessage(
          `[Agent stopped: ${check.reason}]`,
        ))
        break
      }
    }

    // Record iteration in budget
    if (config.budget) {
      const warnings = config.budget.recordIteration()
      for (const w of warnings) {
        config.onBudgetWarning?.(w.message)
      }
    }

    // Refresh tool-stats hint before each LLM invocation.
    // Remove the previous hint (if any) and insert the latest one so the
    // LLM always sees up-to-date per-intent rankings.
    if (config.toolStatsTracker) {
      // Remove previous hint message
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const m = allMessages[i]!
        if (
          m._getType() === 'system'
          && typeof m.content === 'string'
          && m.content.startsWith(TOOL_STATS_HINT_PREFIX)
        ) {
          allMessages.splice(i, 1)
          break // there is at most one
        }
      }

      const hint = config.toolStatsTracker.formatAsPromptHint(5, config.intent)
      if (hint) {
        // Insert after the last system message, before user/AI/tool messages
        const insertIdx = allMessages.findIndex(m => m._getType() !== 'system')
        const hintMsg = new SystemMessage(`${TOOL_STATS_HINT_PREFIX}\n${hint}`)
        allMessages.splice(insertIdx >= 0 ? insertIdx : allMessages.length, 0, hintMsg)
      }
    }

    // Kernel stage: invoke the model and extract usage. Policy stages around
    // it own budget, compression, halt checks, and telemetry.
    const { response, usage } = await executeModelTurn({
      model,
      messages: allMessages,
      config,
    })
    llmCalls++

    // Track usage
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    config.onUsage?.(usage)

    // Record in budget
    if (config.budget) {
      const warnings = config.budget.recordUsage(usage)
      for (const w of warnings) {
        config.onBudgetWarning?.(w.message)
      }
    }

    allMessages.push(response)

    // Token lifecycle auto-compression — invoked AFTER usage has been
    // recorded on the current LLM response and BEFORE the halt check.
    // The callback (typically AgentLoopPlugin.maybeCompress) internally
    // short-circuits when pressure status is ok/warn, so invoking it on
    // every turn is safe and cheap. When compression runs successfully
    // we swap in the shrunken message history for subsequent iterations.
    if (config.maybeCompress) {
      try {
        const before = allMessages.length
        const compressResult = await config.maybeCompress(allMessages)
        if (compressResult.compressed) {
          allMessages.length = 0
          allMessages.push(...compressResult.messages)
          config.onCompressed?.({
            before,
            after: allMessages.length,
            summary: compressResult.summary,
          })
        }
      } catch {
        // Compression must never abort a run — swallow and continue.
      }
    }

    // Token lifecycle halt check — evaluated AFTER usage is recorded on
    // the current LLM response but BEFORE any tool calls in this turn
    // execute. A `true` return ends the loop with `token_exhausted`.
    if (config.shouldHalt?.()) {
      stopReason = 'token_exhausted'
      config.onHalted?.('token_exhausted')
      break
    }

    // Check for tool calls
    const ai = response as AIMessage
    const toolCalls = ai.tool_calls as ToolCall[] | undefined

    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls — this is the final response
      break
    }

    // Track approval suspension: if any tool in this iteration required
    // approval, the underlying tool was NOT invoked and the loop must halt
    // before the next LLM turn so callers can surface the pause. (RF-AGENT-04)
    let approvalPending = false

    // Kernel stage: schedule tool calls sequentially or in parallel. The
    // supplied executor is the policy-decorated stage, so both scheduling
    // modes share governance, validation, scanning, timeout, telemetry,
    // and stuck-detection behavior.
    const results = await scheduleToolCalls(
      toolCalls,
      {
        parallelTools: config.parallelTools,
        maxParallelTools: config.maxParallelTools,
        signal: config.signal,
        agentId: config.agentId,
        toolPermissionPolicy: config.toolPermissionPolicy,
      },
      (toolCall) => executePolicyEnabledToolCall(toolCall, {
        toolMap,
        config,
        getOrCreateStat,
      }),
    )

    let stoppedHandlingResults = false
    for (const r of results) {
      if (stoppedHandlingResults) {
        // After a hard gate fired in sequential mode, executeToolCallsSequential
        // will have stopped scheduling further calls — but in the parallel
        // mode, in-flight tools still produced messages. Drain remaining
        // messages so partial results are surfaced (the loop below halts
        // after the for-of via approvalPending / stopReason flags).
      }
      allMessages.push(r.message)

      if (r.approvalPending) {
        // Hard gate (RF-AGENT-04): halt the loop. The tool was NOT
        // invoked. Resume must be performed externally — the
        // ApprovalGate emits `approval:granted` / `approval:rejected`
        // and the run engine resume path re-drives the run.
        approvalPending = true
        // In sequential mode `executeToolCallsSequential` already short-
        // circuited so there are no more results to drain. In parallel
        // mode the remaining results were already collected by
        // Promise.allSettled — we keep iterating to surface their
        // ToolMessages but suppress further escalation handling.
        stoppedHandlingResults = true
        continue
      }

      if (r.stuckToolName) {
        // Escalating stuck recovery — applied uniformly across modes.
        stuckStage++
        lastStuckToolName = r.stuckToolName
        lastStuckReason = r.stuckReason
        config.onStuck?.(r.stuckToolName, stuckStage)

        if (stuckStage === 2) {
          // Stage 2: try checkpoint-aware recovery first (opt-in via
          // `recoverFromCheckpoint`). If it restores successfully, swallow
          // the stuck event, reset the staging counter, and continue.
          // Otherwise fall through to the standard nudge.
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
                  allMessages.push(result.nudge)
                }
                config.onCheckpointRecovered?.({
                  toolName: r.stuckToolName,
                  reason: r.stuckReason ?? 'stuck',
                  ...(result.checkpointId !== undefined ? { checkpointId: result.checkpointId } : {}),
                })
                // Reset staging — next stuck event re-enters at stage 1.
                stuckStage = 0
              }
            } catch {
              // Recovery hook failures are swallowed — recovery is
              // best-effort and must never escalate the problem.
            }
          }
          if (!recovered) {
            allMessages.push(new SystemMessage(
              'You appear to be stuck repeating the same tool call. Try a different approach or provide your final answer.',
            ))
          }
        }
        if (stuckStage >= 3) {
          // Stage 3: abort the loop
          stopReason = 'stuck'
          break
        }
      }

      if (r.stuckNudge && stuckStage <= 1) {
        allMessages.push(r.stuckNudge)
      }
      if (r.stuckBreak) {
        stopReason = 'stuck'
        break
      }
    }

    // Break out of outer loop if approval is pending — the loop
    // intentionally does NOT proceed to a follow-up LLM turn because the
    // pending tool result has not actually been produced yet. (RF-AGENT-04)
    if (approvalPending) {
      stopReason = 'approval_pending'
      break
    }

    // Break out of outer loop if stuck was detected from errors
    if (stopReason === 'stuck') {
      break
    }

    // --- Stuck detection: after all tool calls in iteration ---
    if (config.stuckDetector) {
      const idleCheck = config.stuckDetector.recordIteration(toolCalls.length)
      if (idleCheck.stuck) {
        const reason = idleCheck.reason ?? 'No progress detected'
        const recovery = 'Stopping due to idle iterations.'
        config.onStuckDetected?.(reason, recovery)
        lastStuckReason = reason
        stopReason = 'stuck'
        break
      }
    }

    // --- Escalating stuck recovery ---
    // If an inner tool-call stuck handler set stuckStage > 0 this iteration,
    // check if we need to advance to the next stage.
    if (stuckStage >= 3) {
      stopReason = 'stuck'
      break
    }

    // Check if this was the last allowed iteration
    if (iteration === config.maxIterations - 1) {
      stopReason = 'iteration_limit'
    }
  }

  // Build toolStats array from accumulators
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

  // Build StuckError when loop terminated due to stuck detection
  const stuckError = stopReason === 'stuck'
    ? new StuckError({
        reason: lastStuckReason ?? 'Agent stuck with no progress',
        repeatedTool: lastStuckToolName,
        escalationLevel: (Math.max(1, Math.min(stuckStage, 3)) as 1 | 2 | 3),
      })
    : undefined

  return {
    messages: allMessages,
    totalInputTokens,
    totalOutputTokens,
    llmCalls,
    hitIterationLimit: stopReason === 'iteration_limit' || stopReason === 'budget_exceeded',
    stopReason,
    toolStats,
    stuckError,
  }
}
