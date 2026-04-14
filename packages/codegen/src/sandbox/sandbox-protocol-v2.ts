/**
 * SandboxProtocolV2 — extended sandbox protocol for preview sessions.
 *
 * Adds long-lived session management, streaming execution, and port
 * exposure on top of the base SandboxProtocol.
 */
import type { SandboxProtocol, ExecOptions } from './sandbox-protocol.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  /** Environment variables to inject into the session container. */
  envVars?: Record<string, string>
  /** Timeout in milliseconds for the entire session lifetime. */
  timeoutMs?: number
}

export type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; exitCode: number; timedOut: boolean }

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Extended sandbox protocol supporting long-lived preview sessions.
 *
 * Implementations can provide streaming command execution and port
 * exposure for previewing generated applications.
 */
export interface SandboxProtocolV2 extends SandboxProtocol {
  /**
   * Start a long-lived sandbox session (e.g. a persistent Docker container).
   * Returns a unique session identifier.
   */
  startSession(opts?: SessionOptions): Promise<{ sessionId: string }>

  /**
   * Execute a command inside an active session, yielding stdout/stderr
   * events as they arrive and a final exit event.
   */
  executeStream(sessionId: string, command: string, opts?: ExecOptions): AsyncIterable<ExecEvent>

  /**
   * Expose a port from the session container, returning a URL that
   * can be used to access the running application.
   */
  exposePort(sessionId: string, port: number): Promise<{ url: string }>

  /**
   * Stop and remove a session container.
   */
  stopSession(sessionId: string): Promise<void>
}
