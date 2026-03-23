import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseMessage } from '@langchain/core/messages'
import type { ModelTier } from '../llm/model-config.js'
import type { AgentMiddleware } from '../middleware/types.js'

/** Configuration for spawning a sub-agent */
export interface SubAgentConfig {
  name: string
  description: string
  systemPrompt: string
  /** Use a specific model instance or a registry tier name */
  model?: BaseChatModel | ModelTier
  tools?: StructuredToolInterface[]
  skills?: string[]
  middleware?: AgentMiddleware[]
  maxIterations?: number
  /** Filter parent state before passing to sub-agent */
  contextFilter?: (parentState: Record<string, unknown>) => Record<string, unknown>
}

/** Result returned after a sub-agent completes */
export interface SubAgentResult {
  messages: BaseMessage[]
  files: Record<string, string>
  metadata: Record<string, unknown>
}
