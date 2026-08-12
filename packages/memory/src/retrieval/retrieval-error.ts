export type MemoryRetrievalErrorCode =
  | 'invalid-query'
  | 'invalid-profile'
  | 'invalid-candidate-set'
  | 'invalid-lifecycle-resolution'
  | 'invalid-provider-result'

/** Internal value-free error; public callers receive typed result reasons. */
export class MemoryRetrievalError extends TypeError {
  readonly code: MemoryRetrievalErrorCode
  readonly path: readonly string[]

  constructor(code: MemoryRetrievalErrorCode, path: readonly string[] = []) {
    super(`${code} at ${formatPath(path)}`)
    this.name = 'MemoryRetrievalError'
    this.code = code
    this.path = Object.freeze([...path])
  }
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) return '$'
  return `$${path.map(part => /^\d+$/.test(part) ? `[${part}]` : `.${part}`).join('')}`
}
