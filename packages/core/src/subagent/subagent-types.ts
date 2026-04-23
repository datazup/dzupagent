import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseMessage } from '@langchain/core/messages'
import type { ModelTier, StructuredOutputModelCapabilities } from '../llm/model-config.js'
import type { AgentMiddleware } from '../middleware/types.js'

/** Configuration for spawning a sub-agent */
export interface SubAgentConfig {
  name: string
  description: string
  systemPrompt: string
  /** Use a specific model instance or a registry tier name */
  model?: BaseChatModel | ModelTier
  /** Optional structured-output capability override for the resolved model. */
  structuredOutputCapabilities?: StructuredOutputModelCapabilities
  tools?: StructuredToolInterface[]
  skills?: string[]
  middleware?: AgentMiddleware[]
  /** Maximum iterations for ReAct tool loop (default: 10) */
  maxIterations?: number
  /** Timeout in ms for the entire sub-agent execution (default: 120_000) */
  timeoutMs?: number
  /** Current depth (internal — prevents infinite recursion). Do not set manually. */
  _depth?: number
  /** Filter parent state before passing to sub-agent */
  contextFilter?: (parentState: Record<string, unknown>) => Record<string, unknown>
}

/** Token usage across all iterations of a sub-agent run */
export interface SubAgentUsage {
  inputTokens: number
  outputTokens: number
  llmCalls: number
}

/** Result returned after a sub-agent completes */
export interface SubAgentResult {
  messages: BaseMessage[]
  files: Record<string, string>
  metadata: Record<string, unknown>
  /** Token usage across all iterations */
  usage?: SubAgentUsage
  /** Whether the agent hit its iteration limit */
  hitIterationLimit?: boolean
}

/** Default values for ReAct loop configuration */
export const REACT_DEFAULTS = {
  maxIterations: 10,
  timeoutMs: 120_000,
  maxDepth: 3,
} as const
