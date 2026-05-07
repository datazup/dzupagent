/**
 * Type and interface declarations for the tool loop.
 *
 * Extracted from `../tool-loop.ts` (RF-03) so the staged helpers in this
 * directory can depend on the shared shapes without forming an import cycle
 * back through the loop entrypoint.
 *
 * `tool-loop.ts` re-exports every symbol declared here for backward
 * compatibility — existing callers continue to import from
 * `../tool-loop.js`.
 */
import type { SystemMessage, BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { TokenUsage } from '@dzupagent/core/llm'
import type { SafetyMonitor } from '@dzupagent/core/security'
import type { ToolGovernance } from '@dzupagent/core/tools'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { CompressResult } from '@dzupagent/context'
import type { IterationBudget } from '../../guardrails/iteration-budget.js'
import type { StuckDetector } from '../../guardrails/stuck-detector.js'
import type { StuckError } from '../stuck-error.js'
import { type ToolArgValidatorConfig } from '../tool-arg-validator.js'
import type { ToolOutputValidator } from './output-validator.js'

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

/**
 * Per-tool retry policy for transient tool execution failures (RF-09).
 *
 * Wired via {@link ToolLoopConfig.toolRetry}. All fields are optional; the
 * executor fills missing values with the documented defaults.
 *
 * The retry loop uses `calculateBackoff` from `@dzupagent/core/utils` so the
 * delay schedule matches the rest of the framework (LLM invoke retry, MCP
 * connection pool, pipeline executor).
 */
export interface ToolRetryConfig {
  /**
   * Maximum total attempts (including the first try). `1` disables retry.
   * Default: `3`.
   */
  maxAttempts?: number
  /** Initial backoff in ms for attempt 0. Default: `200`. */
  initialBackoffMs?: number
  /** Upper bound on backoff in ms. Default: `4000`. */
  maxBackoffMs?: number
  /** Exponential growth factor. Default: `2`. */
  multiplier?: number
  /** Apply equal-jitter (0.5×–1.0×). Default: `true`. */
  jitter?: boolean
  /**
   * Custom predicate deciding whether a thrown error is retryable. When
   * omitted, the executor falls back to {@link isTransientError} from
   * `@dzupagent/core/llm` (rate-limit, overload, network heuristics).
   *
   * Note: cancellation, timeout, permission and validation errors are
   * filtered out BEFORE this predicate runs — `retryOn` is only consulted
   * for the residual "unknown error" bucket.
   */
  retryOn?: (err: Error) => boolean
}

export interface ToolLoopConfig {
  maxIterations: number
  budget?: IterationBudget
  onUsage?: (usage: TokenUsage) => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (name: string, result: string) => void
  onBudgetWarning?: (message: string) => void
  /** Called after each tool invocation with its latency. */
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  /**
   * Called once per iteration with the loop snapshot. Fires after the LLM
   * turn has completed and tool results (if any) have been appended to the
   * working message history. Used by the run-state snapshot writer
   * (MC-AGT-04 Phase 1) to persist a stable boundary between turns.
   *
   * Errors thrown from this hook are caught and ignored — snapshot
   * writes must never abort an in-progress run.
   */
  onIteration?: (info: {
    iteration: number
    messages: BaseMessage[]
    totalInputTokens: number
    totalOutputTokens: number
    llmCalls: number
  }) => void
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
   * Per-tool retry policy for transient failures (RF-09).
   *
   * Opt-in: tools without an entry retry zero times — preserves the legacy
   * surface. When configured, the policy-enabled executor wraps the tool
   * invocation in a retry loop that uses the canonical `calculateBackoff`
   * helper from `@dzupagent/core` between attempts.
   *
   * Errors that are NEVER retried (regardless of `retryOn`):
   *   - permission/governance/approval denials (the tool never ran)
   *   - validation errors (the tool never ran)
   *   - {@link ToolCancellationError} (run was aborted upstream)
   *   - {@link ToolTimeoutError} (per-call timeout already fired; retrying
   *     would just hit the same deadline again)
   *
   * For all other errors, the retry decision is delegated to:
   *   - `retryOn(err)` when provided, else
   *   - {@link isTransientError} from `@dzupagent/core` (rate-limit / overload
   *     / network heuristics)
   *
   * Defaults when an entry is present but a field is omitted:
   *   - `maxAttempts`: 3 (i.e. up to 2 retries after the initial try)
   *   - `initialBackoffMs`: 200
   *   - `maxBackoffMs`: 4000
   *   - `multiplier`: 2
   *   - `jitter`: true
   *
   * Example: `{ fetchUrl: { maxAttempts: 4 }, slowQuery: { maxAttempts: 3, initialBackoffMs: 500 } }`.
   */
  toolRetry?: Record<string, ToolRetryConfig>

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

  /**
   * RF-08 — Optional tool-output schema validator.
   *
   * When provided, every successful tool result is validated against the
   * registered schema (if any) before being appended to the conversation.
   * Validation failures are SOFT: a `tool:output:invalid` event is emitted
   * to the configured event bus and the corresponding callback fires, but
   * execution continues with the original tool output. Tools without a
   * registered schema are passed through untouched.
   */
  toolOutputValidator?: ToolOutputValidator

  /**
   * Optional callback invoked when {@link toolOutputValidator} reports an
   * invalid tool result. Mirrors the warning event so consumers can wire
   * lightweight observers without subscribing to the event bus.
   */
  onToolOutputInvalid?: (info: {
    toolName: string
    toolCallId: string
    error: string
  }) => void
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
