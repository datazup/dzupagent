export type MemoryRecordDecodeErrorCode =
  | 'invalid-type'
  | 'unknown-field'
  | 'invalid-value'
  | 'invalid-schema'
  | 'invalid-time-order'
  | 'invalid-content-digest'
  | 'unsafe-object'
  | 'accessor-property'
  | 'cyclic-value'
  | 'limit-exceeded'
  | 'unsupported-value'

/** A value-free validation error safe to retain in logs and test output. */
export class MemoryRecordDecodeError extends TypeError {
  readonly code: MemoryRecordDecodeErrorCode
  readonly path: readonly string[]

  constructor(code: MemoryRecordDecodeErrorCode, path: readonly string[]) {
    super(`${code} at ${formatPath(path)}`)
    this.name = 'MemoryRecordDecodeError'
    this.code = code
    this.path = Object.freeze([...path])
  }
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) return '$'
  return `$${path.map(part => /^\d+$/.test(part) ? `[${part}]` : `.${part}`).join('')}`
}
