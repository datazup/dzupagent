import type { ForgeErrorCode } from './error-codes.js'

export interface ForgeErrorOptions {
  code: ForgeErrorCode
  message: string
  /** Can the operation be retried? */
  recoverable?: boolean
  /** Which pipeline phase failed (if applicable) */
  phase?: string
  /** Human-readable recovery suggestion */
  suggestion?: string
  /** Structured context for debugging */
  context?: Record<string, unknown>
  /** Original error that caused this */
  cause?: Error
}

/**
 * Structured error type for DzupAgent.
 *
 * Every error has a typed code, recoverable flag, and optional
 * suggestion for automated or manual recovery.
 *
 * @example
 * ```ts
 * throw new ForgeError({
 *   code: 'PROVIDER_UNAVAILABLE',
 *   message: 'Anthropic API returned 503',
 *   recoverable: true,
 *   suggestion: 'Retry with fallback provider',
 * })
 * ```
 */
export class ForgeError extends Error {
  readonly code: ForgeErrorCode
  readonly recoverable: boolean
  readonly phase?: string
  readonly suggestion?: string
  readonly context?: Record<string, unknown>

  constructor(opts: ForgeErrorOptions) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined)
    this.name = 'ForgeError'
    this.code = opts.code
    this.recoverable = opts.recoverable ?? false
    if (opts.phase !== undefined) this.phase = opts.phase
    if (opts.suggestion !== undefined) this.suggestion = opts.suggestion
    if (opts.context !== undefined) this.context = opts.context
  }

  /** Check if an unknown error is a ForgeError */
  static is(err: unknown): err is ForgeError {
    return err instanceof ForgeError
  }

  /** Wrap a generic error as a ForgeError */
  static wrap(err: unknown, defaults: Partial<ForgeErrorOptions> & { code: ForgeErrorCode }): ForgeError {
    if (err instanceof ForgeError) return err
    const message = err instanceof Error ? err.message : String(err)
    const causeOpts: Pick<ForgeErrorOptions, 'cause'> = err instanceof Error ? { cause: err } : {}
    return new ForgeError({ message, ...causeOpts, ...defaults })
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      phase: this.phase,
      suggestion: this.suggestion,
      context: this.context,
    }
  }
}
