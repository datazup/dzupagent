/**
 * Core types for ForgeAgent — the top-level agent abstraction.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseMessage } from '@langchain/core/messages'
import type {
  ModelTier,
  ModelRegistry,
  AgentMiddleware,
  MemoryService,
  MessageManagerConfig,
} from '@forgeagent/core'
import type { GuardrailConfig } from '../guardrails/guardrail-types.js'

/** Configuration for creating a ForgeAgent */
export interface ForgeAgentConfig {
  /** Unique agent identifier */
  id: string
  /** Human-readable name */
  name?: string
  /** System instructions for the agent */
  instructions: string
  /** Model to use — either a BaseChatModel instance, a ModelTier string, or a 'provider/model' string */
  model: BaseChatModel | ModelTier | string
  /** Model registry for resolving tier/name strings */
  registry?: ModelRegistry
  /** Tools available to this agent */
  tools?: StructuredToolInterface[]
  /** Middleware hooks (cost tracking, observability, etc.) */
  middleware?: AgentMiddleware[]
  /** Memory service for persistent context */
  memory?: MemoryService
  /** Memory scope for get/put operations */
  memoryScope?: Record<string, string>
  /** Memory namespace to use */
  memoryNamespace?: string
  /** Message compression config */
  messageConfig?: MessageManagerConfig
  /** Safety guardrails */
  guardrails?: GuardrailConfig
  /** Maximum tool-call iterations before forcing a response (default: 10) */
  maxIterations?: number
  /** Description of what this agent does (used when agent is exposed as a tool) */
  description?: string
}

/** Options for a single generate/stream call */
export interface GenerateOptions {
  /** Override max iterations for this call */
  maxIterations?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Additional context to inject as a system message suffix */
  context?: string
  /** Callback for token usage per LLM call */
  onUsage?: (usage: { model: string; inputTokens: number; outputTokens: number }) => void
}

/** Result of a generate() call */
export interface GenerateResult {
  /** The final text response */
  content: string
  /** All messages in the conversation (including tool calls) */
  messages: BaseMessage[]
  /** Token usage across all LLM calls in this generation */
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    llmCalls: number
  }
  /** Whether the agent hit the max iteration limit */
  hitIterationLimit: boolean
}

/** A single streamed event from the agent */
export interface AgentStreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'budget_warning'
  data: Record<string, unknown>
}
