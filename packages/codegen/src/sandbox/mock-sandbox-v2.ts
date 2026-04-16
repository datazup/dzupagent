/**
 * MockSandboxV2 — in-memory test double for SandboxProtocolV2.
 *
 * Records all method calls for assertion and returns configurable
 * responses. Enables testing of session-based streaming in isolation
 * without Docker or any real sandbox runtime.
 */
import type { SandboxProtocolV2, SessionOptions, ExecEvent } from './sandbox-protocol-v2.js'
import type { ExecResult, ExecOptions } from './sandbox-protocol.js'

interface ConfiguredStream {
  matcher: RegExp | string
  events: ExecEvent[]
}

export class MockSandboxV2 implements SandboxProtocolV2 {
  // -----------------------------------------------------------------------
  // Recorded calls for assertion
  // -----------------------------------------------------------------------
  readonly sessionCalls: Array<{ options?: SessionOptions }> = []
  readonly executeStreamCalls: Array<{ sessionId: string; command: string; opts?: ExecOptions }> = []
  readonly exposePortCalls: Array<{ sessionId: string; port: number }> = []
  readonly stopSessionCalls: Array<{ sessionId: string }> = []

  // -----------------------------------------------------------------------
  // Internal state
  // -----------------------------------------------------------------------
  private sessionIdSequence = 0
  private readonly activeSessions = new Set<string>()
  private readonly streamConfigs: ConfiguredStream[] = []
  private pendingSessionError: Error | undefined

  // V1 mock state (for SandboxProtocol base methods)
  private files: Record<string, string> = {}
  private executedCommands: string[] = []
  private available = true

  // -----------------------------------------------------------------------
  // Configuration API
  // -----------------------------------------------------------------------

  /**
   * Configure what `executeStream` returns for a given command pattern.
   * Patterns are checked in insertion order; first match wins.
   */
  configureStream(commandPattern: string | RegExp, events: ExecEvent[]): this {
    this.streamConfigs.push({
      matcher: commandPattern,
      events,
    })
    return this
  }

  /**
   * Cause the next `startSession()` call to throw the given error.
   * The error is consumed after one use.
   */
  failNextSession(error: Error): this {
    this.pendingSessionError = error
    return this
  }

  /** Set whether `isAvailable()` returns true or false. */
  setAvailable(value: boolean): this {
    this.available = value
    return this
  }

  /** Get the set of currently active session IDs. */
  getActiveSessions(): string[] {
    return [...this.activeSessions]
  }

  // -----------------------------------------------------------------------
  // SandboxProtocolV2 methods
  // -----------------------------------------------------------------------

  async startSession(opts?: SessionOptions): Promise<{ sessionId: string }> {
    this.sessionCalls.push({ options: opts })

    if (this.pendingSessionError) {
      const error = this.pendingSessionError
      this.pendingSessionError = undefined
      throw error
    }

    this.sessionIdSequence += 1
    const sessionId = `session-${this.sessionIdSequence}`
    this.activeSessions.add(sessionId)
    return { sessionId }
  }

  async *executeStream(
    sessionId: string,
    command: string,
    opts?: ExecOptions,
  ): AsyncGenerator<ExecEvent, void, undefined> {
    this.executeStreamCalls.push({ sessionId, command, opts })

    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Find matching configured stream
    for (const { matcher, events } of this.streamConfigs) {
      const matches =
        typeof matcher === 'string'
          ? command === matcher || command.includes(matcher)
          : matcher.test(command)

      if (matches) {
        for (const event of events) {
          yield event
        }
        return
      }
    }

    // Default: empty output, successful exit
    yield { type: 'exit', exitCode: 0, timedOut: false }
  }

  async exposePort(sessionId: string, port: number): Promise<{ url: string }> {
    this.exposePortCalls.push({ sessionId, port })

    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return { url: `http://localhost:${port}` }
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopSessionCalls.push({ sessionId })
    this.activeSessions.delete(sessionId)
  }

  // -----------------------------------------------------------------------
  // SandboxProtocol (V1) base methods
  // -----------------------------------------------------------------------

  async execute(command: string, _options?: ExecOptions): Promise<ExecResult> {
    this.executedCommands.push(command)
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
  }

  async uploadFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      this.files[path] = content
    }
  }

  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const path of paths) {
      const content = this.files[path]
      if (content !== undefined) {
        result[path] = content
      }
    }
    return result
  }

  async cleanup(): Promise<void> {
    this.files = {}
    this.executedCommands = []
    this.activeSessions.clear()
    this.sessionIdSequence = 0
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }
}
