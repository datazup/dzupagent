/**
 * Claude adapter session-management helpers.
 *
 * Pure functions for session forking and CLI binary detection — kept outside
 * the adapter class so the main file can stay focused on the AgentCLIAdapter
 * surface.
 */
import { ForgeError } from '@dzupagent/core/events'
import {
  type ClaudeConversation,
  type ClaudeSDKMessage,
  type ClaudeSDKModule,
  isSystemMessage,
} from './claude-sdk-types.js'

/**
 * Implements `AgentCLIAdapter.forkSession` for Claude. The SDK fork primitive
 * is "start a new query with `forkSession: true` and capture the new
 * `session_id` from the first system event"; we wrap that in a Promise.
 */
export function forkClaudeSession(
  sdk: ClaudeSDKModule,
  sessionId: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const abortController = new AbortController()
    const conversation = sdk.query({
      prompt: '',
      options: {
        resume: sessionId,
        forkSession: true,
        abortController,
      },
    })

    const iterate = async (): Promise<void> => {
      try {
        for await (const message of conversation as AsyncIterable<ClaudeSDKMessage>) {
          if (isSystemMessage(message)) {
            // We got the new session ID from the forked session
            abortController.abort()
            resolve(message.session_id)
            return
          }
        }
        reject(
          new ForgeError({
            code: 'ADAPTER_SESSION_NOT_FOUND',
            message: `Failed to fork session ${sessionId}: no system event received`,
          }),
        )
      } catch (err: unknown) {
        // Abort errors are expected after we resolve
        if (abortController.signal.aborted) {
          return
        }
        reject(
          ForgeError.wrap(err, {
            code: 'ADAPTER_EXECUTION_FAILED',
            context: { providerId: 'claude', sessionId, operation: 'forkSession' },
          }),
        )
      }
    }

    void iterate()
  })
}

/**
 * Best-effort interrupt of an in-flight Claude conversation.
 *
 * Sequencing matters: we attach a no-op catch on `conversation.return()` so
 * the SDK's internal abort rejection does not surface as an unhandledRejection
 * before invoking `conversation.interrupt()`. Both calls are wrapped in their
 * own try/catch since either may throw synchronously.
 */
export function interruptClaudeConversation(
  conversation: ClaudeConversation | null,
  abortController: AbortController | null,
): void {
  if (conversation) {
    const conv = conversation as unknown as AsyncIterator<unknown>
    if (typeof conv.return === 'function') {
      conv.return(undefined).catch(() => {})
    }
  }
  try {
    if (conversation) conversation.interrupt()
  } catch {
    // SDK interrupt may throw — already covered by abort below
  }
  try {
    if (abortController) abortController.abort()
  } catch {
    // Ignore synchronous throws raised by abort listeners
  }
}

/**
 * Best-effort probe for the `claude` CLI binary. Returns `true` when the
 * `--version` invocation succeeds within the timeout, `false` otherwise.
 */
export async function isClaudeCliAvailable(timeoutMs = 5000): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('claude', ['--version'], { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/**
 * Open a Claude conversation as an async iterable. Wraps the raw `sdk.query`
 * call with consistent error handling and signal-driven termination so the
 * adapter's `open()` method stays a thin wrapper.
 */
export interface OpenClaudeConversationArgs {
  sdk: ClaudeSDKModule
  queryOptions: Record<string, unknown>
  signal: AbortSignal
  /** Used purely for ForgeError context when sdk.query throws. */
  errorContext: { model: string | undefined; promptLength: number }
  /** Receives the live conversation handle so the caller can interrupt it. */
  onConversation: (conv: ReturnType<ClaudeSDKModule['query']> | null) => void
}

export async function* openClaudeConversation({
  sdk,
  queryOptions,
  signal,
  errorContext,
  onConversation,
}: OpenClaudeConversationArgs): AsyncIterable<ClaudeSDKMessage> {
  // Inject the runner's AbortController signal into the SDK query options
  const opts = queryOptions['options'] as Record<string, unknown>
  opts['abortController'] = { signal, abort: () => { /* runner owns abort */ } }

  let conversation: ReturnType<ClaudeSDKModule['query']>
  try {
    conversation = sdk.query(queryOptions)
    onConversation(conversation)
  } catch (err: unknown) {
    throw ForgeError.wrap(err, {
      code: 'ADAPTER_EXECUTION_FAILED',
      suggestion: 'Verify Claude Agent SDK is correctly installed and configured',
      context: {
        providerId: 'claude',
        model: errorContext.model,
        promptLength: errorContext.promptLength,
      },
    })
  }

  try {
    for await (const message of conversation as AsyncIterable<ClaudeSDKMessage>) {
      if (signal.aborted) break
      yield message
    }
  } finally {
    onConversation(null)
  }
}
