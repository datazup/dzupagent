/**
 * ReplayEngine — manages replay sessions from captured traces.
 *
 * Creates ReplaySession instances from CapturedTrace data and provides
 * the core session lifecycle (create, get, delete).
 *
 * @module replay/replay-engine
 */

import type {
  ReplaySession,
  CapturedTrace,
  Breakpoint,
} from './replay-types.js'

// ---------------------------------------------------------------------------
// Session ID generator
// ---------------------------------------------------------------------------

let sessionCounter = 0

function generateSessionId(): string {
  sessionCounter++
  return `replay_${Date.now()}_${sessionCounter}`
}

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

/**
 * Manages replay sessions. Each session wraps a captured trace and
 * maintains its own playback position, breakpoints, and speed.
 *
 * ```ts
 * const engine = new ReplayEngine()
 * const session = engine.createSession(capturedTrace)
 * // use ReplayController to navigate the session
 * ```
 */
export class ReplayEngine {
  private readonly sessions = new Map<string, ReplaySession>()

  /**
   * Create a new replay session from a captured trace.
   *
   * @param trace - The captured trace to replay.
   * @param options - Optional session configuration.
   * @returns The created session.
   */
  createSession(
    trace: CapturedTrace,
    options?: { speed?: number; breakpoints?: Breakpoint[] },
  ): ReplaySession {
    const session: ReplaySession = {
      id: generateSessionId(),
      runId: trace.runId,
      events: [...trace.events],
      currentIndex: -1, // Before the first event
      status: 'paused',
      breakpoints: options?.breakpoints ? [...options.breakpoints] : [],
      speed: options?.speed ?? 1,
    }

    this.sessions.set(session.id, session)
    return session
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): ReplaySession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * List all active sessions.
   */
  listSessions(): ReplaySession[] {
    return [...this.sessions.values()]
  }

  /**
   * Delete a session and free its resources.
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /**
   * Delete all sessions.
   */
  clear(): void {
    this.sessions.clear()
  }

  /**
   * Get the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size
  }
}
