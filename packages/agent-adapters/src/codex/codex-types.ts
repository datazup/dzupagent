/**
 * Codex SDK type declarations and internal raw-entry discriminator.
 *
 * Mirrors the shapes consumed from `@openai/codex-sdk` and defines the
 * {@link CodexRawEntry} discriminated union used by the
 * {@link AdapterStreamSource} contract in {@link CodexAdapter}.
 */

import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// SDK type declarations (mirrors the shapes we consume from @openai/codex-sdk)
// ---------------------------------------------------------------------------

/** Codex thread item discriminated by type — mirrors @openai/codex-sdk ThreadItem */
export interface CodexAgentMessageItem {
  type: 'agent_message'
  id: string
  text: string  // SDK uses .text, not .content
}

export interface CodexCommandExecutionItem {
  type: 'command_execution'
  id: string
  command: string
  aggregated_output: string  // SDK uses .aggregated_output, not .output
  exit_code?: number
  status: string
}

export interface CodexFileChangeItem {
  type: 'file_change'
  id: string
  changes: ReadonlyArray<{ path: string; kind: string }>  // SDK has .changes[], not .filePath/.diff/.action
  status: string
}

export interface CodexMcpToolCallItem {
  type: 'mcp_tool_call'
  id: string
  server: string
  tool: string        // SDK uses .tool, not .toolName
  arguments: unknown  // SDK uses .arguments, not .input
  result?: { content: unknown[]; structured_content: unknown }
  error?: { message: string }
  status: string
}

export interface CodexWebSearchItem {
  type: 'web_search'
  id: string
  query: string
  // results are not a direct field; SDK doesn't expose them in the item type
}

export interface CodexReasoningItem {
  type: 'reasoning'
  id: string
  text: string  // SDK uses .text, not .content
}

export interface CodexTodoListItem {
  type: 'todo_list'
  id: string
  items: ReadonlyArray<{ text: string; completed: boolean }>
}

export interface CodexErrorItem {
  type: 'error'
  id: string
  message: string
}

/** Forward-compatible: emitted by Codex SDK when it needs user approval mid-execution */
export interface CodexApprovalRequestItem {
  type: 'approval_request'
  id: string
  message: string
  kind: 'permission' | 'clarification' | 'confirmation'
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexReasoningItem
  | CodexTodoListItem
  | CodexErrorItem
  | CodexApprovalRequestItem

/** Streaming event emitted by codex.runStreamed() — mirrors @openai/codex-sdk ThreadEvent */
export interface CodexStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: CodexThreadItem
  error?: { message: string } | string
  message?: string
}

/** Shape of a Codex thread returned by startThread / resumeThread */
export interface CodexThread {
  runStreamed(
    input: string | unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<{
    events: AsyncIterable<CodexStreamEvent>
    // NOTE: real SDK StreamedTurn has no finalResponse field
  }>
}

/** Shape of the Codex class constructor options */
export interface CodexCtorOptions {
  apiKey?: string
  codexPathOverride?: string
  env?: Record<string, string>
  config?: Record<string, unknown>
}

/** Shape of startThread / resumeThread options */
export interface CodexThreadOptions {
  [key: string]: unknown
  model?: string
  sandboxMode?: string
  workingDirectory?: string
  approvalPolicy?: string
  networkAccessEnabled?: boolean
  skipGitRepoCheck?: boolean
  allowedTools?: string[]
  blockedTools?: string[]
  toolPolicy?: string
  /** Normalized reasoning effort level forwarded to the Codex SDK */
  modelReasoningEffort?: string
}

/** The Codex class from the SDK */
export interface CodexClass {
  new (opts: CodexCtorOptions): CodexInstance
}

export interface CodexInstance {
  startThread(opts: CodexThreadOptions): CodexThread
  resumeThread(threadId: string, opts: CodexThreadOptions): CodexThread
}

// ---------------------------------------------------------------------------
// CodexRawEntry — discriminated union for AdapterStreamSource<TRaw>
//
// `open()` yields these entries; `mapRawEvent()` dispatches on `kind`:
//   - 'sdk'        — a raw CodexStreamEvent from the SDK; mapped via mapCodexEvent()
//   - 'pre_mapped' — AgentEvents already assembled (approval flow, abort/timeout)
// ---------------------------------------------------------------------------

export type CodexRawEntry =
  | { kind: 'sdk'; event: CodexStreamEvent; ordinal: number; threadProviderEventId: string | null }
  | { kind: 'pre_mapped'; events: AgentEvent[] }
