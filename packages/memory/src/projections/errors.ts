export type MemoryProjectionErrorCode =
  | 'invalid-input'
  | 'unknown-field'
  | 'limit-exceeded'
  | 'scope-mismatch'
  | 'identity-conflict'
  | 'source-mismatch'
  | 'profile-mismatch'
  | 'stale-base'
  | 'projection-tampered'

export class MemoryProjectionError extends Error {
  readonly code: MemoryProjectionErrorCode
  readonly path: readonly string[]

  constructor(code: MemoryProjectionErrorCode, path: readonly string[] = []) {
    super(`Memory projection rejected: ${code}${path.length === 0 ? '' : ` at ${path.join('.')}`}`)
    this.name = 'MemoryProjectionError'
    this.code = code
    this.path = Object.freeze([...path])
  }
}

export function projectionFail(
  code: MemoryProjectionErrorCode,
  path: readonly string[] = [],
): never {
  throw new MemoryProjectionError(code, path)
}
