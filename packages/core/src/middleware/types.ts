/**
 * Middleware interface for agent pipelines.
 * Inspired by DeepAgentsJS AgentMiddleware pattern.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'

export interface AgentMiddleware {
  /** Human-readable middleware name */
  name: string

  /** Additional tools this middleware provides */
  tools?: StructuredToolInterface[]

  /** Wrap a model call — intercept before/after LLM invocation */
  wrapModelCall?: (
    model: BaseChatModel,
    messages: BaseMessage[],
    config?: Record<string, unknown>,
  ) => Promise<BaseMessage>

  /** Wrap a tool call result — intercept/transform tool outputs */
  wrapToolCall?: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>

  /**
   * Run before the agent starts — can modify initial state.
   *
   * `state` is the run's accumulated initial state, not an empty placeholder:
   * the run engine seeds it with the facts settled at that point (`agentId`,
   * `runId` when known, the final `messages` transcript, `maxIterations`, and
   * the `tools` names the model will be offered), and each middleware in the
   * chain additionally sees every patch contributed by the middlewares before
   * it.
   *
   * The returned object is a PATCH: it is shallow-merged over the accumulated
   * state (later keys win) and the merged result is surfaced on
   * `GenerateResult.middlewareState`. Return `{}` to contribute nothing.
   * A throwing hook is non-fatal and contributes no patch.
   */
  beforeAgent?: (
    state: Record<string, unknown>,
  ) => Promise<Partial<Record<string, unknown>>>
}
