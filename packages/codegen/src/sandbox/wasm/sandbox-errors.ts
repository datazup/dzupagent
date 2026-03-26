/**
 * Error classes for WASM sandbox resource limit violations.
 *
 * Each error extends Error with a proper `name` field for reliable
 * `instanceof` checking and structured error handling.
 */

// ---------------------------------------------------------------------------
// SandboxResourceError — memory / generic resource limits
// ---------------------------------------------------------------------------

export class SandboxResourceError extends Error {
  override readonly name = 'SandboxResourceError'
  readonly resource: string
  readonly limit: number
  readonly actual: number

  constructor(resource: string, limit: number, actual: number) {
    super(
      `Sandbox resource limit exceeded: ${resource} — limit ${limit}, actual ${actual}`,
    )
    this.resource = resource
    this.limit = limit
    this.actual = actual
  }
}

// ---------------------------------------------------------------------------
// SandboxTimeoutError — execution time exceeded
// ---------------------------------------------------------------------------

export class SandboxTimeoutError extends Error {
  override readonly name = 'SandboxTimeoutError'
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Sandbox execution timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
  }
}

// ---------------------------------------------------------------------------
// SandboxAccessDeniedError — filesystem path isolation violation
// ---------------------------------------------------------------------------

export class SandboxAccessDeniedError extends Error {
  override readonly name = 'SandboxAccessDeniedError'
  readonly attemptedPath: string
  readonly allowedPaths: readonly string[]

  constructor(attemptedPath: string, allowedPaths: readonly string[]) {
    super(
      `Sandbox access denied: path '${attemptedPath}' is outside allowed paths [${allowedPaths.join(', ')}]`,
    )
    this.attemptedPath = attemptedPath
    this.allowedPaths = allowedPaths
  }
}
