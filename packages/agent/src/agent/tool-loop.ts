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
  type TokenUsage,
  type ToolGovernance,
  type SafetyMonitor,
  type DzupEventBus,
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
import {
  executeToolsParallel,
  type ParallelToolCall,
  type ToolLookup,
} from './parallel-executor.js'

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
export type StopReason = 'complete' | 'iteration_limit' | 'budget_exceeded' | 'aborted' | 'error' | 'stuck' | 'token_exhausted'

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
   * Tools requiring approval emit an `approval:requested` event (when an
   * event bus is configured) and proceed — full human-in-the-loop gating
   * is expected to be layered externally via the event.
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
   */
  agentId?: string

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

    // Execute tool calls (parallel or sequential based on config)
    if (config.parallelTools && toolCalls.length > 1) {
      const results = await executeToolCallsParallel(
        toolCalls, toolMap, config, getOrCreateStat,
      )
      for (const r of results) {
        allMessages.push(r.message)
        if (r.stuckBreak) {
          stopReason = 'stuck'
        }
        if (r.stuckToolName) {
          // Escalating recovery for parallel path
          stuckStage++
          lastStuckToolName = r.stuckToolName
          lastStuckReason = r.stuckReason
          config.onStuck?.(r.stuckToolName, stuckStage)
          if (stuckStage >= 3) {
            stopReason = 'stuck'
          }
        }
      }
    } else {
      for (const tc of toolCalls) {
        const r = await executeSingleToolCall(
          tc, toolMap, config, getOrCreateStat,
        )
        allMessages.push(r.message)

        if (r.stuckToolName) {
          // Escalating stuck recovery
          stuckStage++
          lastStuckToolName = r.stuckToolName
          lastStuckReason = r.stuckReason
          config.onStuck?.(r.stuckToolName, stuckStage)

          if (stuckStage === 1) {
            // Stage 1: tool already blocked by executeSingleToolCall
            // stuckNudge is already set
          }
          if (stuckStage === 2) {
            // Stage 2: inject a nudge system message
            allMessages.push(new SystemMessage(
              'You appear to be stuck repeating the same tool call. Try a different approach or provide your final answer.',
            ))
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

  // MC-GA03 — permission check (opt-in). Denied calls throw a
  // `TOOL_PERMISSION_DENIED` ForgeError that propagates out of the loop
  // so callers can react (audit, surface to UI, retry with different
  // identity, etc.).
  if (config.toolPermissionPolicy && config.agentId) {
    if (!config.toolPermissionPolicy.hasPermission(config.agentId, toolName)) {
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
      return {
        message: new ToolMessage({
          content: `[blocked] ${reason}`,
          tool_call_id: toolCallId,
          name: toolName,
        }),
      }
    }
    if (access.requiresApproval) {
      // Emit approval:requested so external HITL can observe. The tool
      // loop does not block waiting — wiring the wait is the caller's
      // responsibility (typically via ApprovalGate on the event bus).
      try {
        config.eventBus?.emit({
          type: 'approval:requested',
          runId: toolCallId,
          plan: { toolName, args: tc.args },
        } as never)
      } catch {
        // Non-fatal: event emission must not abort the run
      }
    }
  }

  const tool = toolMap.get(toolName)
  if (!tool) {
    config.onToolResult?.(toolName, '[not found]')
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
    return {
      message: new ToolMessage({
        content: validationError,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    }
  }

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
 * Execute tool calls in parallel using a semaphore-based concurrency limiter.
 *
 * Unlike batch-based approaches (which wait for an entire batch to finish
 * before starting the next), the semaphore pattern fills freed slots
 * immediately, yielding better throughput when tool durations vary.
 *
 * Uses Promise.allSettled so a single tool failure does not block others.
 * Stuck detection runs sequentially on results after all complete.
 */
async function executeToolCallsParallel(
  toolCalls: ToolCall[],
  toolMap: Map<string, StructuredToolInterface>,
  config: ToolLoopConfig,
  getOrCreateStat: StatGetter,
): Promise<ToolCallResult[]> {
  const maxParallel = config.maxParallelTools ?? 10
  const validatorCfg = resolveValidatorConfig(config.validateToolArgs)

  // Pre-validate and resolve args, filter out blocked/missing/invalid tools
  // so the parallel executor only handles actual invocations.
  const preResults: Array<{ index: number; result: ToolCallResult } | null> = []
  const executableCalls: Array<{ index: number; call: ParallelToolCall; validatedArgs: Record<string, unknown> }> = []

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!
    const toolCallId = tc.id ?? `call_${Date.now()}_${i}`

    // MC-GA03 — permission check runs in the pre-validation loop so
    // denied calls NEVER reach the parallel executor. The throw
    // propagates out through `executeToolCallsParallel` → `runToolLoop`.
    if (config.toolPermissionPolicy && config.agentId) {
      if (!config.toolPermissionPolicy.hasPermission(config.agentId, tc.name)) {
        throw new ForgeError({
          code: 'TOOL_PERMISSION_DENIED',
          message: `Tool "${tc.name}" is not accessible to agent "${config.agentId}"`,
          context: { agentId: config.agentId, toolName: tc.name },
        })
      }
    }

    // Check blocked
    if (config.budget?.isToolBlocked(tc.name)) {
      config.onToolResult?.(tc.name, '[blocked]')
      preResults.push({
        index: i,
        result: {
          message: new ToolMessage({
            content: `[Tool "${tc.name}" is blocked by guardrails]`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      })
      continue
    }

    // Check tool exists
    const tool = toolMap.get(tc.name)
    if (!tool) {
      config.onToolResult?.(tc.name, '[not found]')
      preResults.push({
        index: i,
        result: {
          message: new ToolMessage({
            content: `Error: Tool "${tc.name}" not found. Available tools: ${[...toolMap.keys()].join(', ')}`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      })
      continue
    }

    // Validate args
    const { args: validatedArgs, validationError } = maybeValidateArgs(tc, tool, validatorCfg)
    if (validationError) {
      config.onToolResult?.(tc.name, `[validation error]`)
      preResults.push({
        index: i,
        result: {
          message: new ToolMessage({
            content: validationError,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      })
      continue
    }

    preResults.push(null) // placeholder — will be filled from executor results
    executableCalls.push({ index: i, call: { ...tc, args: validatedArgs }, validatedArgs })
  }

  // Build a ToolLookup that wraps the toolMap with transformToolResult support
  // and per-tool timeout enforcement (GA-02).
  const wrappedRegistry: ToolLookup = {
    get(name: string) {
      const tool = toolMap.get(name)
      if (!tool) return undefined
      return {
        async invoke(args: Record<string, unknown>) {
          const result = await invokeWithOptionalTimeout(
            name,
            config.toolTimeouts?.[name],
            () => tool.invoke(args),
          )
          const rawResultStr = typeof result === 'string' ? result : JSON.stringify(result)
          return config.transformToolResult
            ? await config.transformToolResult(name, args, rawResultStr)
            : rawResultStr
        },
      }
    },
    keys() { return toolMap.keys() },
  }

  // Execute through the semaphore-based parallel executor
  const parallelCalls = executableCalls.map(ec => ec.call)
  const execResults = await executeToolsParallel(parallelCalls, wrappedRegistry, {
    maxConcurrency: maxParallel,
    signal: config.signal,
    onToolStart: (name, args) => config.onToolCall?.(name, args),
    onToolEnd: (name, durationMs, error) => {
      config.onToolLatency?.(name, durationMs, error)
    },
  })

  // Map executor results back to ToolCallResults with stats tracking
  for (let j = 0; j < execResults.length; j++) {
    const execResult = execResults[j]!
    const ec = executableCalls[j]!
    const stat = getOrCreateStat(execResult.toolName)
    stat.calls++
    stat.totalMs += execResult.durationMs

    let message: ToolMessage
    if (execResult.error) {
      stat.errors++
      message = new ToolMessage({
        content: `Error executing tool "${execResult.toolName}": ${execResult.error}`,
        tool_call_id: execResult.toolCallId,
        name: execResult.toolName,
      })
      config.onToolResult?.(execResult.toolName, `[error: ${execResult.error}]`)
    } else {
      message = new ToolMessage({
        content: execResult.result ?? '',
        tool_call_id: execResult.toolCallId,
        name: execResult.toolName,
      })
      config.onToolResult?.(execResult.toolName, execResult.result ?? '')
    }

    // Find the placeholder slot for this call's original index
    preResults[ec.index] = { index: ec.index, result: { message } }
  }

  // Return results in original tool-call order
  return preResults
    .filter((r): r is { index: number; result: ToolCallResult } => r !== null)
    .sort((a, b) => a.index - b.index)
    .map(r => r.result)
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
