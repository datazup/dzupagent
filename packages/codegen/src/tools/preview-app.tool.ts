/**
 * preview_app tool — starts a dev server inside a sandbox session and
 * exposes a port for previewing the running application.
 *
 * Relies on SandboxProtocolV2 for session management and port exposure.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { SandboxProtocolV2 } from '../sandbox/sandbox-protocol-v2.js'

const inputSchema = z.object({
  command: z.string().describe('Shell command to start the dev server (e.g. "npm run dev")'),
  port: z.number().int().positive().describe('Port the dev server listens on inside the sandbox'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How long to wait for the server to start (default: 30000)'),
  sessionId: z
    .string()
    .optional()
    .describe('Reuse an existing session instead of creating a new one'),
})

export interface PreviewAppResult {
  sessionId: string
  url: string
  health: 'starting' | 'ready' | 'error'
  message?: string
}

/**
 * Create a `preview_app` LangChain tool backed by a SandboxProtocolV2 implementation.
 *
 * The tool:
 * 1. Starts (or reuses) a sandbox session
 * 2. Launches the provided command inside the session
 * 3. Exposes the requested port
 * 4. Waits briefly for a health signal (stdout activity) or timeout
 * 5. Returns `{ sessionId, url, health }` so the LLM can share the URL
 */
export function createPreviewAppTool(sandbox: SandboxProtocolV2) {
  return new DynamicStructuredTool({
    name: 'preview_app',
    description:
      'Start a dev server inside a sandbox and expose a port for preview. ' +
      'Returns a URL to access the running application. Reuse a sessionId ' +
      'to run additional commands in the same sandbox.',
    schema: inputSchema,
    func: async (input) => {
      const { command, port, timeoutMs = 30_000, sessionId: existingSessionId } = input

      let sessionId: string

      // 1. Start or reuse session
      try {
        if (existingSessionId) {
          sessionId = existingSessionId
        } else {
          const session = await sandbox.startSession({ timeoutMs })
          sessionId = session.sessionId
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const result: PreviewAppResult = {
          sessionId: '',
          url: '',
          health: 'error',
          message: `Failed to start session: ${msg}`,
        }
        return JSON.stringify(result)
      }

      // 2. Expose the port (best done before starting the server so the
      //    mapping is ready when the process binds)
      let url: string
      try {
        const exposed = await sandbox.exposePort(sessionId, port)
        url = exposed.url
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const result: PreviewAppResult = {
          sessionId,
          url: '',
          health: 'error',
          message: `Failed to expose port ${port}: ${msg}`,
        }
        return JSON.stringify(result)
      }

      // 3. Launch the command via streaming execution and wait for early
      //    output that signals the server is starting up.
      let health: PreviewAppResult['health'] = 'starting'
      let message: string | undefined

      try {
        const startTime = Date.now()
        const streamTimeout = Math.min(timeoutMs, 10_000) // wait up to 10s for first output

        for await (const event of sandbox.executeStream(sessionId, command, {
          timeoutMs,
        })) {
          if (event.type === 'stdout') {
            // Any stdout activity suggests the server is coming up
            health = 'ready'
            message = event.data
            break
          }
          if (event.type === 'stderr') {
            // stderr may be informational (e.g. "Listening on ...") or an error
            // Treat as ready — the user can inspect the URL
            health = 'ready'
            message = event.data
            break
          }
          if (event.type === 'exit') {
            health = event.exitCode === 0 ? 'ready' : 'error'
            message = `Process exited with code ${event.exitCode}`
            break
          }

          // Guard against waiting too long for first output
          if (Date.now() - startTime > streamTimeout) {
            // No output yet but process is still running — optimistic
            health = 'starting'
            message = 'Server started but no output received yet'
            break
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        health = 'error'
        message = `Error executing command: ${msg}`
      }

      const result: PreviewAppResult = { sessionId, url, health }
      if (message !== undefined) result.message = message
      return JSON.stringify(result)
    },
  })
}
