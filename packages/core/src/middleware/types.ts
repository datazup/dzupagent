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

  /** Run before agent starts — can modify initial state */
  beforeAgent?: (
    state: Record<string, unknown>,
  ) => Promise<Partial<Record<string, unknown>>>
}
