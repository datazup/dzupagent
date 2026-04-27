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
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  extractTokenUsage,
  ForgeError,
  requireTerminalToolExecutionRunId,
  type TokenUsage,
  type ToolGovernance,
  type SafetyMonitor,
  type DzupEventBus,
  type ForgeErrorCode,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { CompressResult } from '@dzupagent/context'
import type { IterationBudget } from '../guardrails/iteration-budget.js'
import type { StuckDetector, StuckStatus } from '../guardrails/stuck-detector.js'
import { StuckError } from './stuck-error.js'
import {
  validateAndRepairToolArgs,
  formatSchemaHint,
  type ToolArgValidatorConfig,
} from './tool-arg-validator.js'
// Note: parallel-executor.ts still exports the standalone semaphore
// primitive (executeToolsParallel) for callers that want raw parallel
// dispatch without the policy stack. The tool-loop's parallel path was
// refactored in MJ-AGENT-03 to schedule executeSingleToolCall directly
// under its own semaphore, so the raw primitive is no longer used here.

interface ToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

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
   * Optional event bus. When present, the tool loop emits lifecycle events
   * such as `approval:requested` (for governance-gated tools).
   */
  eventBus?: DzupEventBus

  /**
   * Per-tool execution timeouts in milliseconds.
   *
   * When a tool is invoked, the promise returned by `tool.invoke()` is
   * raced against a timer set to the configured value. If the timer fires
   * first, the call rejects with `Error("Tool \"<name>\" timed out after
   * <ms>ms")` and the surrounding loop records the failure exactly as it
   * would for any other tool error (stuck detection, stats, latency
   * callback, surfaced in the conversation as a `Tool error` message).
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
   * The policy is consulted BOTH in the sequential path (inside
   * `executeSingleToolCall`) and in the parallel pre-validation loop so
   * denied calls never reach `tool.invoke()` in either execution mode.
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

    // Invoke LLM (errors propagate — callers decide how to handle)
    const response = config.invokeModel
      ? await config.invokeModel(model, allMessages)
      : await model.invoke(allMessages)
    llmCalls++

    // Track usage
    const modelName = (model as BaseChatModel & { model?: string }).model
    const usage = extractTokenUsage(response, modelName)
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

    // Execute tool calls. MJ-AGENT-03: both branches feed identical
    // ToolCallResults into the shared handler below so governance,
    // safety-scan, stuck-detection, and approval outcomes have full
    // parity across modes. Both branches schedule the SAME
    // `executeSingleToolCall` policy stack — parallel just runs them
    // under a counting semaphore.
    const results = config.parallelTools && toolCalls.length > 1
      ? await executeToolCallsParallel(toolCalls, toolMap, config, getOrCreateStat)
      : await executeToolCallsSequential(toolCalls, toolMap, config, getOrCreateStat)

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

// ---------- Canonical tool lifecycle telemetry (RF-AGENT-05) ----------

/**
 * Extract the top-level keys of a tool input object.
 *
 * Records ONLY the metadata keys — never the values — so emitting
 * `tool:called` / `tool:result` / `tool:error` events cannot leak
 * secrets, PII, or raw arguments into the audit trail.
 */
function extractInputMetadataKeys(input: unknown): string[] {
  if (input == null || typeof input !== 'object') return []
  if (Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>)
}

/**
 * Outcome status for a terminal tool lifecycle event.
 */
type ToolLifecycleStatus = 'success' | 'error' | 'timeout' | 'denied'

/**
 * Detect the canonical status from a thrown error. Used to label
 * `tool:error` events as `'timeout'` vs generic `'error'` so consumers
 * can branch without parsing message text.
 */
function statusFromError(err: unknown): Extract<ToolLifecycleStatus, 'error' | 'timeout'> {
  const msg = err instanceof Error ? err.message : String(err)
  return /timed out after \d+ms/.test(msg) ? 'timeout' : 'error'
}

/**
 * Emit a canonical `tool:called` event.
 *
 * Side-effect-only — never throws (event-bus failures must not abort
 * the run). Also bridges to {@link ToolGovernance.audit} when the
 * governance layer is wired so legacy auditHandler consumers continue
 * to receive notifications.
 */
function emitToolCalled(
  config: ToolLoopConfig,
  args: {
    toolName: string
    toolCallId: string
    input: Record<string, unknown>
    inputMetadataKeys: string[]
  },
): void {
  const { toolName, toolCallId, input, inputMetadataKeys } = args
  try {
    config.eventBus?.emit({
      type: 'tool:called',
      toolName,
      input,
      toolCallId,
      inputMetadataKeys,
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      ...(config.runId !== undefined
        ? { runId: config.runId, executionRunId: config.runId }
        : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop
  }

  // Bridge to ToolGovernance.audit for legacy auditHandler consumers.
  if (config.toolGovernance) {
    void config.toolGovernance.audit({
      toolName,
      input,
      callerAgent: config.agentId ?? 'unknown',
      timestamp: Date.now(),
      allowed: true,
    }).catch(() => { /* non-fatal */ })
  }
}

/**
 * Emit a canonical `tool:result` event for a successful invocation.
 */
function emitToolResult(
  config: ToolLoopConfig,
  args: {
    toolName: string
    toolCallId: string
    durationMs: number
    inputMetadataKeys: string[]
    output: unknown
  },
): void {
  const { toolName, toolCallId, durationMs, inputMetadataKeys, output } = args
  try {
    const executionRunId = requireTerminalToolExecutionRunId({
      eventType: 'tool:result',
      toolName,
      executionRunId: config.runId,
    })
    config.eventBus?.emit({
      type: 'tool:result',
      toolName,
      durationMs,
      toolCallId,
      inputMetadataKeys,
      status: 'success',
      executionRunId,
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      ...(config.runId !== undefined ? { runId: config.runId } : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop
  }

  if (config.toolGovernance) {
    void config.toolGovernance.auditResult({
      toolName,
      output,
      callerAgent: config.agentId ?? 'unknown',
      durationMs,
      success: true,
      timestamp: Date.now(),
    }).catch(() => { /* non-fatal */ })
  }
}

/**
 * Emit a canonical `tool:error` event for any non-success terminal
 * outcome (`error`, `timeout`, `denied`).
 */
function emitToolError(
  config: ToolLoopConfig,
  args: {
    toolName: string
    toolCallId: string
    durationMs: number
    inputMetadataKeys: string[]
    errorCode: ForgeErrorCode
    errorMessage: string
    status: Exclude<ToolLifecycleStatus, 'success'>
  },
): void {
  const {
    toolName,
    toolCallId,
    durationMs,
    inputMetadataKeys,
    errorCode,
    errorMessage,
    status,
  } = args
  try {
    const executionRunId = requireTerminalToolExecutionRunId({
      eventType: 'tool:error',
      toolName,
      executionRunId: config.runId,
    })
    config.eventBus?.emit({
      type: 'tool:error',
      toolName,
      errorCode,
      message: errorMessage,
      errorMessage,
      durationMs,
      toolCallId,
      inputMetadataKeys,
      status,
      executionRunId,
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      ...(config.runId !== undefined ? { runId: config.runId } : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop
  }

  if (config.toolGovernance) {
    void config.toolGovernance.auditResult({
      toolName,
      output: errorMessage,
      callerAgent: config.agentId ?? 'unknown',
      durationMs,
      success: false,
      timestamp: Date.now(),
    }).catch(() => { /* non-fatal */ })
  }
}

/**
 * Best-effort parse of a tool's raw result into a plain object.
 * Returns `null` when the value is not (or cannot be coerced into) an
 * object record. Never throws.
 */
function coerceResultToRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Non-JSON tool result — that is fine, just not a checkpoint shape.
    }
  }
  return null
}

/**
 * Recognise checkpoint/restore shapes in a tool result and emit the
 * corresponding canonical event on the configured event bus.
 *
 * Two shapes are detected:
 *  - `{ checkpointed: true, label, nodeId?, checkpointAt? }` ⇒ `checkpoint:created`
 *  - `{ restored: true | false, label, reason? }`            ⇒ `checkpoint:restored`
 *
 * Side-effect-only — never throws. Failures (no event bus, no runId,
 * malformed payload) are silently ignored to keep the tool loop resilient.
 */
function maybeEmitCheckpointEvent(
  config: ToolLoopConfig,
  toolName: string,
  rawResult: unknown,
): void {
  if (!config.eventBus || !config.runId) return
  const record = coerceResultToRecord(rawResult)
  if (!record) return

  try {
    if (record['checkpointed'] === true && typeof record['label'] === 'string') {
      const nodeIdValue = record['nodeId']
      const checkpointAtValue = record['checkpointAt']
      const nodeId = typeof nodeIdValue === 'string' ? nodeIdValue : toolName
      const checkpointAt =
        typeof checkpointAtValue === 'string' ? checkpointAtValue : new Date().toISOString()
      config.eventBus.emit({
        type: 'checkpoint:created',
        runId: config.runId,
        nodeId,
        label: record['label'],
        checkpointAt,
      } as never)
      return
    }

    if (
      typeof record['restored'] === 'boolean'
      && typeof record['label'] === 'string'
    ) {
      const reasonValue = record['reason']
      config.eventBus.emit({
        type: 'checkpoint:restored',
        runId: config.runId,
        checkpointLabel: record['label'],
        restored: record['restored'] as boolean,
        ...(typeof reasonValue === 'string' ? { reason: reasonValue } : {}),
      } as never)
    }
  } catch {
    // Telemetry must never abort the tool loop.
  }
}

// ---------- Internal tool execution helpers ----------

/** Result of executing a single tool call. */
interface ToolCallResult {
  /** The primary ToolMessage to append to conversation. */
  message: ToolMessage
  /** Optional extra stuck-nudge message to append. */
  stuckNudge?: ToolMessage
  /** If true, the outer loop should break (stuck from errors). */
  stuckBreak?: boolean
  /** Name of the tool that triggered stuck detection (for escalation). */
  stuckToolName?: string
  /** Reason from stuck detector (for building StuckError). */
  stuckReason?: string
  /**
   * If true, the tool was suspended pending human approval (RF-AGENT-04).
   * The tool was NOT invoked; the outer loop should break with
   * `stopReason === 'approval_pending'` and surface the suspension to the
   * caller. Resume is the caller's responsibility (see `ApprovalGate`).
   */
  approvalPending?: boolean
}

type StatGetter = (name: string) => { calls: number; errors: number; totalMs: number }

/**
 * Resolve the validator config from the ToolLoopConfig convenience union.
 */
function resolveValidatorConfig(
  cfg: boolean | ToolArgValidatorConfig | undefined,
): ToolArgValidatorConfig | null {
  if (!cfg) return null
  if (cfg === true) return { autoRepair: true }
  return cfg
}

/**
 * Try to extract a JSON-schema-like object from a StructuredToolInterface.
 * LangChain tools expose `.schema` which is typically a Zod schema; the
 * underlying JSON schema is available via `.jsonSchema` or `._def` depending
 * on the Zod version.
 */
function extractJsonSchema(tool: StructuredToolInterface): Record<string, unknown> | null {
  const schema = (tool as StructuredToolInterface & { schema?: unknown }).schema
  if (!schema) return null

  // Zod v4 uses .jsonSchema; Zod v3 uses ._def / .shape() — we try the
  // most common approaches. If none work, validation is skipped for this tool.
  if (typeof schema === 'object' && schema !== null) {
    // Already a JSON schema object (e.g., from createForgeTool or raw schemas)
    const s = schema as Record<string, unknown>
    if (s.properties || s.type) return s

    // Zod schema — try to convert
    const zodSchema = schema as { jsonSchema?: () => Record<string, unknown> }
    if (typeof zodSchema.jsonSchema === 'function') {
      try {
        return zodSchema.jsonSchema() as Record<string, unknown>
      } catch {
        // Ignore
      }
    }
  }
  return null
}

/**
 * Validate and possibly repair args for a single tool call.
 * Returns the (possibly modified) args and any validation error message.
 */
function maybeValidateArgs(
  tc: ToolCall,
  tool: StructuredToolInterface,
  validatorCfg: ToolArgValidatorConfig | null,
): { args: Record<string, unknown>; validationError?: string } {
  if (!validatorCfg) return { args: tc.args }

  const jsonSchema = extractJsonSchema(tool)
  if (!jsonSchema) return { args: tc.args }

  const result = validateAndRepairToolArgs(tc.args, jsonSchema, validatorCfg)

  if (result.valid && result.repairedArgs) {
    return { args: result.repairedArgs as Record<string, unknown> }
  }

  if (!result.valid) {
    const hint = formatSchemaHint(jsonSchema)
    const errMsg = `Validation failed for tool "${tc.name}": ${result.errors.join('; ')}.\n${hint}`
    return { args: tc.args, validationError: errMsg }
  }

  return { args: tc.args }
}

/**
 * Execute a single tool call with validation, stuck detection, and stat tracking.
 */
async function executeSingleToolCall(
  tc: ToolCall,
  toolMap: Map<string, StructuredToolInterface>,
  config: ToolLoopConfig,
  getOrCreateStat: StatGetter,
): Promise<ToolCallResult> {
  const toolName = tc.name
  const toolCallId = tc.id ?? `call_${Date.now()}`

  // RF-AGENT-05 — top-level keys of the validated tool input. Recorded
  // in every emitted lifecycle event so consumers can audit which fields
  // were supplied without ever seeing the (possibly secret) values.
  const inputMetadataKeys = extractInputMetadataKeys(tc.args)

  // MC-GA03 — permission check (opt-in). Denied calls throw a
  // `TOOL_PERMISSION_DENIED` ForgeError that propagates out of the loop
  // so callers can react (audit, surface to UI, retry with different
  // identity, etc.).
  if (config.toolPermissionPolicy && config.agentId) {
    if (!config.toolPermissionPolicy.hasPermission(config.agentId, toolName)) {
      // Emit canonical denial telemetry BEFORE throwing so audit consumers
      // see the denial regardless of how the caller handles the error.
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
        status: 'denied',
      })
      throw new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${toolName}" is not accessible to agent "${config.agentId}"`,
        context: { agentId: config.agentId, toolName },
      })
    }
  }

  // Check if tool is blocked
  if (config.budget?.isToolBlocked(toolName)) {
    config.onToolResult?.(toolName, '[blocked]')
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_PERMISSION_DENIED',
      errorMessage: `Tool "${toolName}" is blocked by guardrails`,
      status: 'denied',
    })
    return {
      message: new ToolMessage({
        content: `[Tool "${toolName}" is blocked by guardrails]`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }

  // Tool governance: access check (blocked / approval-required)
  if (config.toolGovernance) {
    const access = config.toolGovernance.checkAccess(toolName, tc.args)
    if (!access.allowed) {
      const reason = access.reason ?? 'Tool access denied'
      config.onToolResult?.(toolName, `[blocked: ${reason}]`)
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs: 0,
        inputMetadataKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: reason,
        status: 'denied',
      })
      return {
        message: new ToolMessage({
          content: `[blocked] ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      }
    }
    if (access.requiresApproval) {
      // RF-AGENT-04 (approved 2026-04-26): hard execution gate. The tool
      // is NOT invoked; we emit `approval:requested` carrying the durable
      // runId (falling back to the local tool_call_id when no runId was
      // threaded through the config) and return an `[approval_pending]`
      // ToolMessage. The outer loop breaks with
      // `stopReason === 'approval_pending'` so callers can surface the
      // suspension and arrange resume via the run engine. Resume is
      // explicitly OUT OF SCOPE for the loop itself — see the
      // toolGovernance docstring above for the full rationale.
      const correlationId = config.runId ?? toolCallId
      try {
        config.eventBus?.emit({
          type: 'approval:requested',
          runId: correlationId,
          plan: { toolName, args: tc.args },
        } as never)
      } catch {
        // Non-fatal: event emission must not abort the run
      }
      const reason = access.reason ?? 'Approval required'
      config.onToolResult?.(toolName, `[approval_pending: ${reason}]`)
      return {
        message: new ToolMessage({
          content: `[approval_pending] Tool "${toolName}" requires human approval before execution. ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        approvalPending: true,
      }
    }
  }

  const tool = toolMap.get(toolName)
  if (!tool) {
    config.onToolResult?.(toolName, '[not found]')
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'TOOL_NOT_FOUND',
      errorMessage: `Tool "${toolName}" not found`,
      status: 'error',
    })
    return {
      message: new ToolMessage({
        content: `Error: Tool "${toolName}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }

  // Validate args before execution
  const validatorCfg = resolveValidatorConfig(config.validateToolArgs)
  const { args: validatedArgs, validationError } = maybeValidateArgs(tc, tool, validatorCfg)

  if (validationError) {
    config.onToolResult?.(toolName, `[validation error]`)
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: validationError,
      status: 'error',
    })
    return {
      message: new ToolMessage({
        content: validationError,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }

  // Refresh metadata keys against the (possibly repaired) validated args so
  // the canonical lifecycle events reflect the exact shape that was invoked.
  const validatedKeys = extractInputMetadataKeys(validatedArgs)

  // RF-AGENT-05 — emit canonical `tool:called` BEFORE invocation. The
  // event carries the toolCallId, agentId, runId, and the top-level
  // metadata keys (never the values). Bridges to ToolGovernance.audit
  // for legacy auditHandler consumers.
  emitToolCalled(config, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  })

  config.onToolCall?.(toolName, validatedArgs)

  const stat = getOrCreateStat(toolName)
  const startMs = Date.now()
  let errorMsg: string | undefined
  let message: ToolMessage

  // Optional OTel span per tool invocation. `inputSize` is the rough byte
  // cost of the validated args; the span is closed either in the success
  // branch (via `span.end()`) or via `endSpanWithError` in the catch block.
  const inputSize = JSON.stringify(validatedArgs).length
  const span = config.tracer?.startToolSpan(toolName, { inputSize })

  try {
    const result = await invokeWithOptionalTimeout(
      toolName,
      config.toolTimeouts?.[toolName],
      () => tool.invoke(validatedArgs),
    )
    const rawResultStr = typeof result === 'string' ? result : JSON.stringify(result)
    let resultStr = config.transformToolResult
      ? await config.transformToolResult(toolName, validatedArgs, rawResultStr)
      : rawResultStr

    // Safety scan: inspect the tool result for prompt-injection / unsafe
    // content before surfacing it back to the model. Critical or `block`/`kill`
    // violations replace the output with a safe rejection message.
    if (config.safetyMonitor && config.scanToolResults !== false) {
      try {
        const violations = config.safetyMonitor.scanContent(resultStr, {
          source: 'tool:result',
          toolName,
        })
        const hardBlock = violations.find(
          v => v.action === 'block' || v.action === 'kill' || v.severity === 'critical',
        )
        if (hardBlock) {
          resultStr = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`
          config.onToolResult?.(toolName, '[blocked: unsafe tool output]')
          message = new ToolMessage({
            content: resultStr,
            tool_call_id: toolCallId,
            name: toolName,
          })
          const durationMs = Date.now() - startMs
          stat.calls++
          stat.totalMs += durationMs
          config.onToolLatency?.(toolName, durationMs, 'unsafe-result')
          // RF-AGENT-05 — terminal `tool:error` with `denied` status:
          // unsafe content was produced but blocked before reaching the LLM.
          emitToolError(config, {
            toolName,
            toolCallId,
            durationMs,
            inputMetadataKeys: validatedKeys,
            errorCode: 'TOOL_EXECUTION_FAILED',
            errorMessage: `Tool result blocked: ${hardBlock.category} — ${hardBlock.message}`,
            status: 'denied',
          })
          // Close span on early-return (unsafe-result branch)
          if (span) {
            try {
              span.setAttribute('durationMs', durationMs)
              span.setAttribute('outputSize', resultStr.length)
              span.setAttribute('blocked', true)
              span.end()
            } catch {
              // Tracer failures must not abort the tool loop
            }
          }
          return { message }
        }
      } catch {
        // Non-fatal: safety scan failure must not abort the run
      }
    }

    message = new ToolMessage({
      content: resultStr,
      tool_call_id: toolCallId,
      name: toolName,
    })
    config.onToolResult?.(toolName, resultStr)
    // RF-AGENT-05 — terminal `tool:result` with `success` status. Emitted
    // AFTER transformToolResult and the safety-scan early return so the
    // success event always reflects the bytes that reached the LLM.
    emitToolResult(config, {
      toolName,
      toolCallId,
      durationMs: Date.now() - startMs,
      inputMetadataKeys: validatedKeys,
      output: resultStr,
    })
    // Surface checkpoint/restore semantics from flow-runtime tools to the
    // event bus. Tool results carrying `{ checkpointed: true, label }` or
    // `{ restored: <bool>, label }` are translated into canonical
    // `checkpoint:created` / `checkpoint:restored` events. The raw result is
    // preferred over the (possibly transformed) string so we still recognise
    // structured payloads when `transformToolResult` returns a JSON string.
    maybeEmitCheckpointEvent(config, toolName, result ?? resultStr)
    if (span) {
      try {
        span.setAttribute('durationMs', Date.now() - startMs)
        span.setAttribute('outputSize', resultStr.length)
        span.end()
      } catch {
        // Tracer failures must not abort the tool loop
      }
    }
  } catch (err: unknown) {
    errorMsg = err instanceof Error ? err.message : String(err)
    message = new ToolMessage({
      content: `Error executing tool "${toolName}": ${errorMsg}`,
      tool_call_id: toolCallId,
      name: toolName,
    })
    config.onToolResult?.(toolName, `[error: ${errorMsg}]`)
    stat.errors++
    // RF-AGENT-05 — terminal `tool:error`. Discriminate `'timeout'` from
    // generic `'error'` so consumers can branch without parsing message text.
    const lifecycleStatus = statusFromError(err)
    emitToolError(config, {
      toolName,
      toolCallId,
      durationMs: Date.now() - startMs,
      inputMetadataKeys: validatedKeys,
      errorCode: lifecycleStatus === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_EXECUTION_FAILED',
      errorMessage: errorMsg,
      status: lifecycleStatus,
    })
    if (span) {
      try {
        span.setAttribute('durationMs', Date.now() - startMs)
        config.tracer?.endSpanWithError(span, err)
      } catch {
        // Tracer failures must not abort the tool loop
      }
    }
  }

  const durationMs = Date.now() - startMs
  stat.calls++
  stat.totalMs += durationMs
  config.onToolLatency?.(toolName, durationMs, errorMsg)

  // --- Stuck detection ---
  let stuckBreak = false
  let stuckNudge: ToolMessage | undefined
  let stuckToolName: string | undefined
  let stuckReason: string | undefined
  if (config.stuckDetector) {
    const stuckCheck: StuckStatus = errorMsg
      ? config.stuckDetector.recordError(new Error(errorMsg))
      : config.stuckDetector.recordToolCall(toolName, tc.args)

    if (stuckCheck.stuck) {
      const reason = stuckCheck.reason ?? 'Unknown stuck condition'
      stuckToolName = toolName
      stuckReason = reason
      if (errorMsg) {
        const recovery = 'Stopping due to repeated errors.'
        config.onStuckDetected?.(reason, recovery)
        stuckBreak = true
      } else {
        const recovery = `Tool "${toolName}" has been blocked. Try a different approach.`
        config.budget?.blockTool(toolName)
        config.onStuckDetected?.(reason, recovery)
        stuckNudge = new ToolMessage({
          content: `[Agent appears stuck: ${reason}. ${recovery}]`,
          tool_call_id: toolCallId,
          name: toolName,
        })
      }
    }
  }

  return { message, stuckNudge, stuckBreak, stuckToolName, stuckReason }
}

/**
 * Execute tool calls sequentially. Thin wrapper around
 * {@link executeSingleToolCall} that short-circuits on approval-pending or
 * stage-3 stuck so we don't keep invoking tools after the loop has decided
 * to halt. Returns the executed results in original order.
 */
async function executeToolCallsSequential(
  toolCalls: ToolCall[],
  toolMap: Map<string, StructuredToolInterface>,
  config: ToolLoopConfig,
  getOrCreateStat: StatGetter,
): Promise<ToolCallResult[]> {
  const out: ToolCallResult[] = []
  for (const tc of toolCalls) {
    const r = await executeSingleToolCall(tc, toolMap, config, getOrCreateStat)
    out.push(r)
    // Stop running additional tools as soon as a hard gate fires —
    // matches the pre-MJ-AGENT-03 behaviour of breaking the inner for-of
    // when approval is pending or stuck escalation forced a stop.
    if (r.approvalPending || r.stuckBreak) break
  }
  return out
}

/**
 * Execute tool calls in parallel using a semaphore-based concurrency
 * limiter.
 *
 * MJ-AGENT-03 (audit fix, 2026-04-26): the parallel path now schedules
 * the SAME {@link executeSingleToolCall} function as the sequential path
 * via a counting semaphore, instead of duplicating a partial policy stack
 * and delegating raw invocation to a separate executor. This guarantees
 * full parity across modes:
 *
 *   - permission policy (MC-GA03)
 *   - guardrail tool blocks (budget.isToolBlocked)
 *   - tool governance access checks (block / approval — RF-AGENT-04)
 *   - tool-not-found handling
 *   - argument validation + auto-repair
 *   - per-tool timeouts (GA-02)
 *   - tool result transformation
 *   - **safety scanning of tool results** (was missing pre-MJ-AGENT-03)
 *   - **per-tool stuck detection** (was missing pre-MJ-AGENT-03)
 *   - canonical lifecycle telemetry (RF-AGENT-05)
 *   - OTel spans
 *
 * Concurrency is capped by `config.maxParallelTools` (default 10). Results
 * are returned in the same order as the input `toolCalls` array regardless
 * of completion order — preserved by recording each call's original index
 * before scheduling.
 *
 * Uses `Promise.allSettled` so a single tool failure (or a thrown
 * permission-denied ForgeError) does not block other in-flight calls; the
 * first thrown error is re-raised after the batch settles to preserve the
 * sequential path's "throw on permission denied" surface.
 */
async function executeToolCallsParallel(
  toolCalls: ToolCall[],
  toolMap: Map<string, StructuredToolInterface>,
  config: ToolLoopConfig,
  getOrCreateStat: StatGetter,
): Promise<ToolCallResult[]> {
  // Pre-validation: check permissions for ALL tool calls before executing any.
  // Ensures no tool fires when at least one call is denied — matches the
  // sequential path's "throw on first denied" contract but applied eagerly
  // so neither allowed nor denied tools execute on a mixed batch.
  if (config.toolPermissionPolicy && config.agentId) {
    for (const tc of toolCalls) {
      if (!config.toolPermissionPolicy.hasPermission(config.agentId, tc.name)) {
        throw new ForgeError({
          code: 'TOOL_PERMISSION_DENIED',
          message: `Tool "${tc.name}" is not accessible to agent "${config.agentId}"`,
          context: { agentId: config.agentId, toolName: tc.name },
        })
      }
    }
  }

  const maxParallel = Math.max(1, config.maxParallelTools ?? 10)

  // Counting-semaphore so freed slots are picked up immediately by the
  // next pending call (matches the throughput characteristics of the
  // standalone executeToolsParallel primitive).
  let running = 0
  const waiting: Array<() => void> = []
  function acquire(): Promise<void> {
    if (running < maxParallel) {
      running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }
  function release(): void {
    const next = waiting.shift()
    if (next) {
      // Hand the slot directly to the next waiter so concurrency stays at cap.
      next()
    } else {
      running--
    }
  }

  // Run executeSingleToolCall under the semaphore. Abort signal is checked
  // both before acquiring the slot and after waking, mirroring the
  // standalone executor's cooperative cancellation contract.
  async function runOne(
    tc: ToolCall,
    index: number,
  ): Promise<{ index: number; result: ToolCallResult; thrown?: unknown }> {
    if (config.signal?.aborted) {
      const toolCallId = tc.id ?? `call_${Date.now()}_${index}`
      return {
        index,
        result: {
          message: new ToolMessage({
            content: `Error executing tool "${tc.name}": Aborted`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      }
    }

    await acquire()
    try {
      if (config.signal?.aborted) {
        const toolCallId = tc.id ?? `call_${Date.now()}_${index}`
        return {
          index,
          result: {
            message: new ToolMessage({
              content: `Error executing tool "${tc.name}": Aborted`,
              tool_call_id: toolCallId,
              name: tc.name,
            }),
          },
        }
      }
      // Delegate to the SHARED policy stack. Any thrown ForgeError
      // (e.g. TOOL_PERMISSION_DENIED) is captured and re-raised after
      // the whole batch settles so we don't leave in-flight tools
      // half-running.
      const result = await executeSingleToolCall(tc, toolMap, config, getOrCreateStat)
      return { index, result }
    } catch (err) {
      const toolCallId = tc.id ?? `call_${Date.now()}_${index}`
      return {
        index,
        thrown: err,
        result: {
          message: new ToolMessage({
            content: `Error executing tool "${tc.name}": ${err instanceof Error ? err.message : String(err)}`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      }
    } finally {
      release()
    }
  }

  const settled = await Promise.allSettled(
    toolCalls.map((tc, idx) => runOne(tc, idx)),
  )

  // Collect results in original order; surface the first thrown error
  // after settling (preserves sequential-path semantics for
  // TOOL_PERMISSION_DENIED, which is documented to throw out of the loop).
  const ordered: Array<{ index: number; result: ToolCallResult; thrown?: unknown }> = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!
    if (outcome.status === 'fulfilled') {
      ordered.push(outcome.value)
    } else {
      const tc = toolCalls[i]!
      const toolCallId = tc.id ?? `call_${Date.now()}_${i}`
      ordered.push({
        index: i,
        thrown: outcome.reason,
        result: {
          message: new ToolMessage({
            content: `Error executing tool "${tc.name}": ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      })
    }
  }

  ordered.sort((a, b) => a.index - b.index)

  const firstThrown = ordered.find(r => r.thrown !== undefined)
  if (firstThrown) {
    throw firstThrown.thrown
  }

  return ordered.map(r => r.result)
}

// ---------- Tool timeout enforcement (GA-02) ----------

/**
 * Invoke a tool and optionally race it against a timeout.
 *
 * When `timeoutMs` is falsy (`undefined`, `null`, or `0`), the invocation
 * runs unbounded (preserves the prior behaviour). When a positive
 * `timeoutMs` is provided, the promise is raced against a timer and
 * rejects with `Error("Tool \"<name>\" timed out after <ms>ms")` if the
 * timer wins. The timer is cleared in either branch so it never leaks.
 */
async function invokeWithOptionalTimeout<T>(
  toolName: string,
  timeoutMs: number | undefined,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return invoke()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([invoke(), timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
