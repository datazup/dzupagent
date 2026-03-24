/**
 * Serializable agent state for checkpoint/resume.
 *
 * Converts LangChain BaseMessage[] to a portable JSON format
 * and back, enabling persistence of agent execution state.
 */
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'

/**
 * Serializable snapshot of agent execution state.
 * Can be saved to a store and restored to resume execution.
 */
export interface AgentStateSnapshot {
  agentId: string
  runId: string
  messages: SerializedMessage[]
  conversationSummary: string | null
  budgetState?: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCostCents: number
    llmCalls: number
    iterations: number
  }
  snapshotAt: string
  metadata?: Record<string, unknown>
}

/** Minimal serialized message format */
export interface SerializedMessage {
  role: 'system' | 'human' | 'ai' | 'tool'
  content: string
  name?: string
  toolCallId?: string
}

/** Map a LangChain message type string to our serialized role */
function messageTypeToRole(msg: BaseMessage): SerializedMessage['role'] {
  const type = msg._getType()
  switch (type) {
    case 'system': return 'system'
    case 'human': return 'human'
    case 'ai': return 'ai'
    case 'tool': return 'tool'
    default: return 'human'
  }
}

/** Extract string content from a message (handles string and array content) */
function extractContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return JSON.stringify(content)
  return String(content)
}

/**
 * Serialize LangChain BaseMessage[] to a portable format.
 */
export function serializeMessages(messages: BaseMessage[]): SerializedMessage[] {
  return messages.map((msg): SerializedMessage => {
    const serialized: SerializedMessage = {
      role: messageTypeToRole(msg),
      content: extractContent(msg.content),
    }

    if (msg.name) {
      serialized.name = msg.name
    }

    // ToolMessage has tool_call_id
    if (serialized.role === 'tool') {
      const toolMsg = msg as ToolMessage
      if (toolMsg.tool_call_id) {
        serialized.toolCallId = toolMsg.tool_call_id
      }
    }

    return serialized
  })
}

/**
 * Deserialize messages back to LangChain BaseMessage[].
 */
export function deserializeMessages(serialized: SerializedMessage[]): BaseMessage[] {
  return serialized.map((msg): BaseMessage => {
    switch (msg.role) {
      case 'system':
        return new SystemMessage({ content: msg.content, name: msg.name })
      case 'human':
        return new HumanMessage({ content: msg.content, name: msg.name })
      case 'ai':
        return new AIMessage({ content: msg.content, name: msg.name })
      case 'tool':
        return new ToolMessage({
          content: msg.content,
          name: msg.name,
          tool_call_id: msg.toolCallId ?? '',
        })
    }
  })
}
