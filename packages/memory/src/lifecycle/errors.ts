type MemoryTransitionErrorCode =
  | 'invalid-command'
  | 'invalid-state'
  | 'invalid-event'
  | 'unsafe-input'
  | 'limit-exceeded'
  | 'identity-mismatch'
  | 'idempotency-conflict'
  | 'sequence-gap'
  | 'sequence-reorder'
  | 'sequence-conflict'
  | 'stale-generation'
  | 'stale-version'
  | 'stale-digest'
  | 'time-reversal'
  | 'illegal-transition'
  | 'terminal-transition'
  | 'policy-precondition'
  | 'effect-precondition'
  | 'legal-hold'
  | 'projection-conflict'

/** A value-free lifecycle error safe to retain in bounded diagnostics. */
export class MemoryTransitionError extends TypeError {
  readonly code: MemoryTransitionErrorCode
  readonly path: readonly string[]

  constructor(code: MemoryTransitionErrorCode, path: readonly string[] = []) {
    super(`${code} at ${formatPath(path)}`)
    this.name = 'MemoryTransitionError'
    this.code = code
    this.path = Object.freeze([...path])
  }
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) return '$'
  return `$${path.map(part => /^\d+$/.test(part) ? `[${part}]` : `.${part}`).join('')}`
}

export function transitionFail(
  code: ConstructorParameters<typeof MemoryTransitionError>[0],
  path: readonly string[] = [],
): never {
  throw new MemoryTransitionError(code, path)
}
