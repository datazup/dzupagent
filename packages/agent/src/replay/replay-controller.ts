/**
 * ReplayController — provides VCR-style playback controls for a replay session.
 *
 * Supports play, pause, step forward/back, seek, and breakpoints.
 * Emits callbacks on each event so the consumer can render or inspect state.
 *
 * @module replay/replay-controller
 */

import type {
  ReplaySession,
  ReplayEvent,
  Breakpoint,
  ReplayStatus,
} from './replay-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback invoked when the controller reaches an event during playback.
 */
export type ReplayEventCallback = (event: ReplayEvent, session: ReplaySession) => void

/**
 * Callback invoked when a breakpoint is hit.
 */
export type BreakpointHitCallback = (breakpoint: Breakpoint, event: ReplayEvent) => void

/**
 * Callback invoked when playback status changes.
 */
export type StatusChangeCallback = (status: ReplayStatus, previousStatus: ReplayStatus) => void

// ---------------------------------------------------------------------------
// ReplayController
// ---------------------------------------------------------------------------

/**
 * Controls playback of a ReplaySession with VCR-like operations.
 *
 * ```ts
 * const controller = new ReplayController(session)
 * controller.onEvent((event) => console.log(event.type))
 * controller.onBreakpointHit((bp) => console.log('Hit breakpoint:', bp.id))
 * await controller.play()
 * ```
 */
export class ReplayController {
  private readonly session: ReplaySession
  private eventCallbacks: ReplayEventCallback[] = []
  private breakpointCallbacks: BreakpointHitCallback[] = []
  private statusCallbacks: StatusChangeCallback[] = []
  private playAbort: AbortController | undefined

  constructor(session: ReplaySession) {
    this.session = session
  }

  // ---------------------------------------------------------------------------
  // Callback registration
  // ---------------------------------------------------------------------------

  /**
   * Register a callback for each event reached during playback.
   */
  onEvent(callback: ReplayEventCallback): () => void {
    this.eventCallbacks.push(callback)
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Register a callback for breakpoint hits.
   */
  onBreakpointHit(callback: BreakpointHitCallback): () => void {
    this.breakpointCallbacks.push(callback)
    return () => {
      this.breakpointCallbacks = this.breakpointCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Register a callback for status changes.
   */
  onStatusChange(callback: StatusChangeCallback): () => void {
    this.statusCallbacks.push(callback)
    return () => {
      this.statusCallbacks = this.statusCallbacks.filter(cb => cb !== callback)
    }
  }

  // ---------------------------------------------------------------------------
  // Playback controls
  // ---------------------------------------------------------------------------

  /**
   * Start continuous playback from current position at the session's speed.
   * Resolves when playback reaches the end or is paused/stopped by a breakpoint.
   */
  async play(): Promise<void> {
    if (this.session.events.length === 0) {
      this.setStatus('completed')
      return
    }

    // If already at the end, do nothing
    if (this.session.currentIndex >= this.session.events.length - 1) {
      this.setStatus('completed')
      return
    }

    this.playAbort = new AbortController()
    this.setStatus('playing')

    while (this.session.status === 'playing') {
      const nextIndex = this.session.currentIndex + 1
      if (nextIndex >= this.session.events.length) {
        this.setStatus('completed')
        break
      }

      // Calculate delay based on speed and timestamp deltas
      const delay = this.calculateDelay(nextIndex)
      if (delay > 0) {
        const aborted = await this.wait(delay, this.playAbort.signal)
        if (aborted) break
      }

      this.session.currentIndex = nextIndex
      const event = this.session.events[nextIndex]!
      this.emitEvent(event)

      // Check breakpoints
      const hitBp = this.checkBreakpoints(event)
      if (hitBp) {
        this.setStatus('paused')
        this.emitBreakpointHit(hitBp, event)
        break
      }

      // Check if we reached the end
      if (nextIndex >= this.session.events.length - 1) {
        this.setStatus('completed')
        break
      }
    }
  }

  /**
   * Pause playback at the current position.
   */
  pause(): void {
    if (this.session.status === 'playing') {
      this.playAbort?.abort()
      this.setStatus('paused')
    }
  }

  /**
   * Advance exactly one event forward.
   * Returns the event or undefined if at the end.
   */
  step(): ReplayEvent | undefined {
    if (this.session.currentIndex >= this.session.events.length - 1) {
      this.setStatus('completed')
      return undefined
    }

    this.setStatus('stepping')
    this.session.currentIndex++
    const event = this.session.events[this.session.currentIndex]!
    this.emitEvent(event)

    if (this.session.currentIndex >= this.session.events.length - 1) {
      this.setStatus('completed')
    } else {
      this.setStatus('paused')
    }

    return event
  }

  /**
   * Go back one event. Uses the previous event's state snapshot if available.
   * Returns the event at the new position, or undefined if already at the start.
   */
  stepBack(): ReplayEvent | undefined {
    if (this.session.currentIndex <= 0) {
      // At or before start
      this.session.currentIndex = -1
      this.setStatus('paused')
      return undefined
    }

    this.setStatus('stepping')
    this.session.currentIndex--
    const event = this.session.events[this.session.currentIndex]!
    this.emitEvent(event)
    this.setStatus('paused')

    return event
  }

  /**
   * Jump to a specific event index.
   * Returns the event at that index, or undefined if the index is out of bounds.
   */
  seekTo(index: number): ReplayEvent | undefined {
    if (index < 0 || index >= this.session.events.length) {
      return undefined
    }

    // If playing, pause first
    if (this.session.status === 'playing') {
      this.playAbort?.abort()
    }

    this.session.currentIndex = index
    const event = this.session.events[index]!
    this.emitEvent(event)

    if (index >= this.session.events.length - 1) {
      this.setStatus('completed')
    } else {
      this.setStatus('paused')
    }

    return event
  }

  /**
   * Reset playback to the beginning.
   */
  reset(): void {
    if (this.session.status === 'playing') {
      this.playAbort?.abort()
    }
    this.session.currentIndex = -1
    this.setStatus('paused')
  }

  // ---------------------------------------------------------------------------
  // Breakpoint management
  // ---------------------------------------------------------------------------

  /**
   * Add a breakpoint to the session.
   */
  addBreakpoint(breakpoint: Breakpoint): void {
    this.session.breakpoints.push(breakpoint)
  }

  /**
   * Remove a breakpoint by ID.
   */
  removeBreakpoint(breakpointId: string): boolean {
    const idx = this.session.breakpoints.findIndex(bp => bp.id === breakpointId)
    if (idx < 0) return false
    this.session.breakpoints.splice(idx, 1)
    return true
  }

  /**
   * Toggle a breakpoint's enabled state.
   */
  toggleBreakpoint(breakpointId: string): boolean {
    const bp = this.session.breakpoints.find(b => b.id === breakpointId)
    if (!bp) return false
    bp.enabled = !bp.enabled
    return true
  }

  /**
   * Clear all breakpoints.
   */
  clearBreakpoints(): void {
    this.session.breakpoints.length = 0
  }

  // ---------------------------------------------------------------------------
  // State reconstruction
  // ---------------------------------------------------------------------------

  /**
   * Reconstruct the execution state at a given event index by finding the
   * nearest prior snapshot and replaying state-bearing events forward.
   *
   * Returns undefined if no snapshots are available.
   */
  getState(index: number): Record<string, unknown> | undefined {
    if (index < 0 || index >= this.session.events.length) return undefined

    // Find the nearest snapshot at or before `index`
    let snapshotState: Record<string, unknown> | undefined
    let snapshotIndex = -1

    for (let i = index; i >= 0; i--) {
      const evt = this.session.events[i]!
      if (evt.stateSnapshot) {
        snapshotState = structuredClone(evt.stateSnapshot)
        snapshotIndex = i
        break
      }
    }

    if (!snapshotState) return undefined

    // Apply state-bearing event data from snapshotIndex+1 through index
    const state = snapshotState
    for (let i = snapshotIndex + 1; i <= index; i++) {
      const evt = this.session.events[i]!
      // Merge any stateSnapshot from subsequent events
      if (evt.stateSnapshot) {
        Object.assign(state, structuredClone(evt.stateSnapshot))
      }
    }

    return state
  }

  /**
   * Get the current session snapshot.
   */
  getSession(): Readonly<ReplaySession> {
    return this.session
  }

  /**
   * Set playback speed.
   */
  setSpeed(speed: number): void {
    if (speed <= 0) throw new Error('Speed must be positive')
    this.session.speed = speed
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private setStatus(status: ReplayStatus): void {
    const prev = this.session.status
    if (prev === status) return
    this.session.status = status
    for (const cb of this.statusCallbacks) {
      cb(status, prev)
    }
  }

  private emitEvent(event: ReplayEvent): void {
    for (const cb of this.eventCallbacks) {
      cb(event, this.session)
    }
  }

  private emitBreakpointHit(bp: Breakpoint, event: ReplayEvent): void {
    for (const cb of this.breakpointCallbacks) {
      cb(bp, event)
    }
  }

  private checkBreakpoints(event: ReplayEvent): Breakpoint | undefined {
    for (const bp of this.session.breakpoints) {
      if (!bp.enabled) continue

      switch (bp.type) {
        case 'event-type':
          if (event.type === bp.value) return bp
          break
        case 'node-id':
          if (event.nodeId === bp.value) return bp
          break
        case 'error':
          if (event.data['error'] !== undefined || event.data['message'] !== undefined) return bp
          break
        case 'condition':
          if (bp.condition && bp.condition(event)) return bp
          break
      }
    }

    return undefined
  }

  private calculateDelay(nextIndex: number): number {
    if (this.session.speed <= 0) return 0
    if (nextIndex <= 0) return 0

    const current = this.session.events[this.session.currentIndex]
    const next = this.session.events[nextIndex]
    if (!current || !next) return 0

    const realDelta = next.timestamp - current.timestamp
    // Cap at 2 seconds max real-time delay to avoid very long waits
    const capped = Math.min(realDelta, 2000)
    return Math.max(0, capped / this.session.speed)
  }

  private wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve(true)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
