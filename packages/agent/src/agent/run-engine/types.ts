import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { RunJournalEntry } from '@dzupagent/core/persistence'
import type {
  DzupAgentConfig,
  GenerateOptions,
} from '../agent-types.js'
import type { IterationBudget } from '../../guardrails/iteration-budget.js'
import type { StuckDetector } from '../../guardrails/stuck-detector.js'
import type { ToolLoopLearningHook } from '../tool-loop-learning.js'
import type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from '../streaming-tool-types.js'

export interface PreparedRunState {
  maxIterations: number
  budget?: IterationBudget
  preparedMessages: BaseMessage[]
  tools: StructuredToolInterface[]
  toolMap: Map<string, StructuredToolInterface>
  model: BaseChatModel
  stuckDetector?: StuckDetector
  /** Per-run self-learning lifecycle; absent when self-learning is disabled. */
  learningHook?: ToolLoopLearningHook
  /**
   * Per-run memory frame snapshot captured during `prepareMessages`.
   * Threaded through the run state (instead of stored on the agent instance)
   * so concurrent `generate()`/`stream()` calls on the same agent cannot
   * clobber each other's frame reference.
   */
  memoryFrame?: unknown
  /**
   * State produced by the `beforeAgent` middleware chain: the initial run
   * state this engine handed in, with every middleware's returned patch merged
   * over it. Surfaced on `GenerateResult.middlewareState` so the documented
   * "can modify initial state" capability is reachable from a real run instead
   * of being discarded at the seam.
   */
  middlewareState?: Record<string, unknown>
}

export interface PrepareRunStateParams {
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  messages: BaseMessage[]
  options?: GenerateOptions
  prepareMessages: (
    messages: BaseMessage[],
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
  getTools: () => StructuredToolInterface[]
  bindTools: (model: BaseChatModel, tools: StructuredToolInterface[]) => BaseChatModel
  /**
   * Run the `beforeAgent` middleware chain with the engine's initial run
   * state, returning the state with every middleware patch merged in.
   *
   * The `| void` arm keeps pre-existing stub implementations (`async () => {}`)
   * assignable; a `void` return is treated as "no state produced".
   */
  runBeforeAgentHooks: (
    initialState: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | void>
  /**
   * Optional journal used for resume rehydration. When `options._resume.lastStateSeq`
   * is set, the run engine will pull entries up to that seq and reconstruct the
   * message history instead of using `prepareMessages`' result.
   */
  journal?: { getAll: (runId: string) => Promise<RunJournalEntry[]> }
  /** Run id used to query the journal when resuming. */
  runId?: string
}

export interface ExecuteGenerateRunParams {
  agentId: string
  config: DzupAgentConfig
  options?: GenerateOptions
  runState: PreparedRunState
  invokeModel: (model: BaseChatModel, messages: BaseMessage[]) => Promise<BaseMessage>
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  maybeUpdateSummary: (messages: BaseMessage[], memoryFrame?: unknown) => Promise<void>
}

export interface StreamingToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface ExecuteStreamingToolCallParams {
  toolCall: StreamingToolCall
  toolMap: Map<string, StructuredToolInterface>
  budget?: IterationBudget
  stuckDetector?: StuckDetector
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  onToolLatency?: (name: string, durationMs: number, error?: string) => void
  statTracker: ToolStatTracker
  /** Parent run cancellation signal; threaded to the per-tool invocation signal. */
  signal?: AbortSignal
  /**
   * MJ-AGENT-02 — optional public policy bundle. When present, the
   * streaming executor enforces the SAME governance, permission,
   * validation, timeout, safety, and tracing controls as the
   * non-streaming policy-enabled tool execution stage. When `undefined`,
   * the executor preserves the
   * pre-MJ-AGENT-02 "lite" surface (budget block + tool existence)
   * for backwards-compatible callers that didn't thread
   * `toolExecution` through DzupAgentConfig.
   */
  policy?: StreamingToolPolicyOptions
}

export type StreamPhaseResult =
  | { kind: 'short-circuit'; result: StreamingToolExecutionResult }
  | {
      kind: 'success'
      transformedResult: string
      validatedArgs: Record<string, unknown>
      validatedKeys: string[]
    }
