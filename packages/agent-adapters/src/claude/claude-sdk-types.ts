/**
 * Claude Agent SDK type declarations and type guards.
 *
 * The SDK is an optional peer dependency, so we declare structural types
 * locally rather than importing from `@anthropic-ai/claude-agent-sdk`.
 */

// ---------------------------------------------------------------------------
// SDK type declarations (optional peer dep — cannot import statically)
// ---------------------------------------------------------------------------

/** Shape of the object returned by query(). */
export interface ClaudeConversation {
  [Symbol.asyncIterator](): AsyncIterator<ClaudeSDKMessage>
  interrupt(): void
}

/** Union of SDK message types we handle. */
export interface ClaudeSDKMessage {
  type: 'system' | 'assistant' | 'result' | 'tool_progress' | 'stream_event'
  [key: string]: unknown
}

/** Resolved SDK module shape. */
export interface ClaudeSDKModule {
  query(opts: Record<string, unknown>): ClaudeConversation
  listSessions?(): Promise<unknown[]>
  getSessionInfo?(sessionId: string): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Type guards for SDK messages
// ---------------------------------------------------------------------------

export function isSystemMessage(
  msg: ClaudeSDKMessage,
): msg is ClaudeSDKMessage & { session_id: string; tools?: unknown[]; model?: string } {
  return msg.type === 'system' && typeof (msg as Record<string, unknown>)['session_id'] === 'string'
}

export function isAssistantMessage(
  msg: ClaudeSDKMessage,
): msg is ClaudeSDKMessage & { content: unknown[] } {
  return msg.type === 'assistant' && Array.isArray((msg as Record<string, unknown>)['content'])
}

export interface ResultMessage extends ClaudeSDKMessage {
  subtype: string
  result?: string
  session_id?: string
  usage?: Record<string, unknown>
  duration_ms?: number
  error?: string
}

export function isResultMessage(msg: ClaudeSDKMessage): msg is ResultMessage {
  return msg.type === 'result' && typeof (msg as Record<string, unknown>)['subtype'] === 'string'
}

export interface ToolProgressMessage extends ClaudeSDKMessage {
  tool_name: string
  input?: unknown
  output?: string
  status: 'started' | 'completed' | 'failed'
  duration_ms?: number
}

export function isToolProgressMessage(msg: ClaudeSDKMessage): msg is ToolProgressMessage {
  return msg.type === 'tool_progress' && typeof (msg as Record<string, unknown>)['tool_name'] === 'string'
}

export interface StreamEventMessage extends ClaudeSDKMessage {
  delta?: string
}

export function isStreamEvent(msg: ClaudeSDKMessage): msg is StreamEventMessage {
  return msg.type === 'stream_event'
}

// ---------------------------------------------------------------------------
// Content block helpers
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type: string
  text?: string
  tool_use?: { name: string; input: unknown }
}

export function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null && 'type' in value
}

export function extractTextFromContentBlocks(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (isContentBlock(block)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}
