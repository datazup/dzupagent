export type AgentRunnerSafePoint =
  | 'before-model-dispatch'
  | 'after-model-dispatch'
  | 'before-tool-dispatch'
  | 'after-tool-dispatch'

export type RunControlAcknowledgement =
  | {
      readonly accepted: true
      readonly requestId: string
      readonly kind: 'pause' | 'cancel'
      readonly state: 'requested'
    }
  | {
      readonly accepted: false
      readonly kind: 'pause' | 'cancel'
      readonly reason: 'already-paused' | 'request-pending' | 'terminal'
    }

export type RunControlObservation =
  | {
      readonly requestId: string
      readonly kind: 'pause' | 'cancel'
      readonly state: 'observed-at-safe-point'
      readonly safePoint: AgentRunnerSafePoint
    }
  | {
      readonly requestId: string
      readonly kind: 'pause' | 'cancel'
      readonly state: 'not-observed'
      readonly reason: 'terminal-before-safe-point'
    }

type ControlRequest = {
  readonly requestId: string
  readonly kind: 'pause' | 'cancel'
}

type ObservationWaiter = {
  readonly promise: Promise<RunControlObservation>
  readonly resolve: (observation: RunControlObservation) => void
}

export type RunControlSafePointDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'pause'; readonly requestId: string }
  | { readonly action: 'cancel'; readonly requestId: string }

export class RunControl {
  #nextRequest = 1
  #pending: ControlRequest | undefined
  #paused = false
  #terminal = false
  #releaseAction: 'resume' | 'cancel' | undefined
  #releasePause: ((action: 'resume' | 'cancel') => void) | undefined
  readonly #observations = new Map<string, ObservationWaiter>()

  requestPause(): RunControlAcknowledgement {
    return this.#request('pause')
  }

  requestCancel(): RunControlAcknowledgement {
    return this.#request('cancel')
  }

  async waitForObservation(requestId: string): Promise<RunControlObservation> {
    const waiter = this.#observations.get(requestId)
    if (waiter === undefined) throw new Error(`Unknown control request: ${requestId}`)
    return waiter.promise
  }

  resume(): boolean {
    if (!this.#paused) return false
    const release = this.#releasePause
    this.#releasePause = undefined
    this.#paused = false
    if (release === undefined) this.#releaseAction = 'resume'
    else release('resume')
    return true
  }

  observeAtSafePoint(safePoint: AgentRunnerSafePoint): RunControlSafePointDecision {
    const request = this.#pending
    if (request === undefined) return { action: 'continue' }
    this.#pending = undefined
    this.#observations.get(request.requestId)?.resolve({
      requestId: request.requestId,
      kind: request.kind,
      state: 'observed-at-safe-point',
      safePoint,
    })
    if (request.kind === 'cancel') return { action: 'cancel', requestId: request.requestId }
    this.#paused = true
    return { action: 'pause', requestId: request.requestId }
  }

  waitUntilReleased(): Promise<'resume' | 'cancel'> {
    if (this.#releaseAction !== undefined) {
      const action = this.#releaseAction
      this.#releaseAction = undefined
      return Promise.resolve(action)
    }
    if (this.#pending?.kind === 'cancel') return Promise.resolve('cancel')
    if (!this.#paused) return Promise.resolve('resume')
    return new Promise((resolve) => {
      this.#releasePause = resolve
    })
  }

  markTerminal(): void {
    this.#terminal = true
    this.#paused = false
    this.#releaseAction = undefined
    const release = this.#releasePause
    this.#releasePause = undefined
    release?.('cancel')
    const pending = this.#pending
    this.#pending = undefined
    if (pending !== undefined) {
      this.#observations.get(pending.requestId)?.resolve({
        requestId: pending.requestId,
        kind: pending.kind,
        state: 'not-observed',
        reason: 'terminal-before-safe-point',
      })
    }
  }

  #request(kind: 'pause' | 'cancel'): RunControlAcknowledgement {
    if (this.#terminal) return { accepted: false, kind, reason: 'terminal' }
    if (this.#pending !== undefined) {
      return { accepted: false, kind, reason: 'request-pending' }
    }
    if (kind === 'pause' && this.#paused) {
      return { accepted: false, kind, reason: 'already-paused' }
    }
    const requestId = `control-${this.#nextRequest++}`
    let resolveObservation: (observation: RunControlObservation) => void = () => undefined
    const promise = new Promise<RunControlObservation>((resolve) => {
      resolveObservation = resolve
    })
    this.#observations.set(requestId, { promise, resolve: resolveObservation })
    this.#pending = { requestId, kind }
    if (kind === 'cancel' && this.#paused && this.#releasePause !== undefined) {
      const release = this.#releasePause
      this.#releasePause = undefined
      this.#paused = false
      release('cancel')
    } else if (kind === 'cancel' && this.#paused) {
      this.#paused = false
      this.#releaseAction = 'cancel'
    }
    return { accepted: true, requestId, kind, state: 'requested' }
  }
}
