/**
 * Enhanced serialized message format with multimodal support and tool calls.
 *
 * Provides a portable, provider-agnostic message format that supports
 * text, images, tool calls, and metadata.
 */

/**
 * A single content block in a multimodal message.
 */
export type MultimodalContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mimeType?: string }

/**
 * Enhanced serialized message format.
 *
 * Supports all common message roles, multimodal content, tool calls,
 * and arbitrary metadata.
 */
export interface SerializedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | MultimodalContent[]
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  toolCallId?: string
  metadata?: Record<string, unknown>
}

/**
 * Legacy message format (for migration).
 */
interface LegacyMessage {
  role?: string
  content?: unknown
  name?: string
  tool_call_id?: string
  toolCallId?: string
  tool_calls?: Array<{
    id?: string
    name?: string
    function?: { name?: string; arguments?: string | Record<string, unknown> }
    args?: Record<string, unknown>
    arguments?: Record<string, unknown>
  }>
  toolCalls?: Array<{
    id?: string
    name?: string
    arguments?: Record<string, unknown>
  }>
}

/**
 * Map legacy role names to the standard set.
 */
function normalizeRole(role: string | undefined): SerializedMessage['role'] {
  switch (role) {
    case 'system':
      return 'system'
    case 'user':
    case 'human':
      return 'user'
    case 'assistant':
    case 'ai':
      return 'assistant'
    case 'tool':
    case 'function':
      return 'tool'
    default:
      return 'user'
  }
}

/**
 * Normalize content to the SerializedMessage content format.
 */
function normalizeContent(
  content: unknown,
): string | MultimodalContent[] {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const blocks: MultimodalContent[] = []
    for (const item of content) {
      if (typeof item === 'string') {
        blocks.push({ type: 'text', text: item })
      } else if (
        item !== null &&
        typeof item === 'object' &&
        'type' in item
      ) {
        const typed = item as Record<string, unknown>
        if (typed['type'] === 'text' && typeof typed['text'] === 'string') {
          blocks.push({ type: 'text', text: typed['text'] })
        } else if (typed['type'] === 'image' && typeof typed['url'] === 'string') {
          const block: MultimodalContent = { type: 'image', url: typed['url'] }
          if (typeof typed['mimeType'] === 'string') {
            block.mimeType = typed['mimeType']
          }
          blocks.push(block)
        } else if (typed['type'] === 'image_url' && typeof typed['image_url'] === 'object') {
          // OpenAI format: { type: 'image_url', image_url: { url: '...' } }
          const imageUrl = typed['image_url'] as Record<string, unknown>
          if (typeof imageUrl['url'] === 'string') {
            blocks.push({ type: 'image', url: imageUrl['url'] })
          }
        } else {
          blocks.push({ type: 'text', text: JSON.stringify(typed) })
        }
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(item) })
      }
    }
    return blocks
  }

  if (content === null || content === undefined) {
    return ''
  }

  return String(content)
}

/**
 * Extract tool calls from a legacy message format.
 */
function extractToolCalls(
  msg: LegacyMessage,
): SerializedMessage['toolCalls'] | undefined {
  // Check new-style toolCalls
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    return msg.toolCalls.map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      name: tc.name ?? 'unknown',
      arguments: tc.arguments ?? {},
    }))
  }

  // Check OpenAI-style tool_calls
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return msg.tool_calls.map((tc, idx) => {
      const name = tc.name ?? tc.function?.name ?? 'unknown'
      let args: Record<string, unknown> = {}

      if (tc.arguments && typeof tc.arguments === 'object') {
        args = tc.arguments
      } else if (tc.args && typeof tc.args === 'object') {
        args = tc.args
      } else if (tc.function?.arguments) {
        if (typeof tc.function.arguments === 'string') {
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            args = { raw: tc.function.arguments }
          }
        } else {
          args = tc.function.arguments
        }
      }

      return {
        id: tc.id ?? `call_${idx}`,
        name,
        arguments: args,
      }
    })
  }

  return undefined
}

/**
 * Serialize a single message (from any supported format) into a SerializedMessage.
 *
 * Handles LangChain messages, OpenAI messages, and plain objects.
 */
export function serializeMessage(msg: unknown): SerializedMessage {
  if (msg === null || msg === undefined) {
    return { role: 'user', content: '' }
  }

  // Handle LangChain BaseMessage (has _getType)
  if (
    typeof msg === 'object' &&
    '_getType' in (msg as Record<string, unknown>) &&
    typeof (msg as Record<string, unknown>)['_getType'] === 'function'
  ) {
    const langMsg = msg as {
      _getType: () => string
      content: unknown
      name?: string
      tool_call_id?: string
      tool_calls?: Array<{
        id?: string
        name: string
        args: Record<string, unknown>
      }>
    }

    const role = normalizeRole(langMsg._getType())
    const content = normalizeContent(langMsg.content)

    const serialized: SerializedMessage = { role, content }

    if (langMsg.tool_calls && langMsg.tool_calls.length > 0) {
      serialized.toolCalls = langMsg.tool_calls.map((tc, idx) => ({
        id: tc.id ?? `call_${idx}`,
        name: tc.name,
        arguments: tc.args,
      }))
    }

    if (langMsg.tool_call_id) {
      serialized.toolCallId = langMsg.tool_call_id
    }

    if (langMsg.name) {
      serialized.metadata = { name: langMsg.name }
    }

    return serialized
  }

  // Handle plain objects (OpenAI format, legacy format, etc.)
  if (typeof msg === 'object') {
    const obj = msg as LegacyMessage
    const role = normalizeRole(obj.role)
    const content = normalizeContent(obj.content)

    const serialized: SerializedMessage = { role, content }

    const toolCalls = extractToolCalls(obj)
    if (toolCalls) {
      serialized.toolCalls = toolCalls
    }

    const toolCallId = obj.tool_call_id ?? obj.toolCallId
    if (toolCallId) {
      serialized.toolCallId = toolCallId
    }

    if (obj.name) {
      serialized.metadata = { name: obj.name }
    }

    return serialized
  }

  // Handle strings
  return { role: 'user', content: String(msg) }
}

/**
 * Migrate an array of messages from any old/mixed format into SerializedMessage[].
 */
export function migrateMessages(old: unknown[]): SerializedMessage[] {
  return old.map(serializeMessage)
}
