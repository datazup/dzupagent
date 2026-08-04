/**
 * Typed errors and structured logging for the Arrow IPC boundary.
 *
 * ERR-C-23: Arrow (de)serialization failure used to be swallowed into an empty
 * table / empty byte array, so a truncated or corrupt payload was reported to
 * the caller as a successful "no records found" result. A corrupt payload must
 * be distinguishable from an empty one, so the boundary now throws.
 *
 * `@dzupagent/memory-ipc` is a leaf package with no `@dzupagent/*` dependencies
 * (it must stay importable from `@dzupagent/core`'s dependents without a
 * cycle), so `ForgeError`/`FrameworkLogger` are mirrored structurally here
 * rather than imported from `@dzupagent/core`.
 */

/** Error codes emitted by the Arrow IPC boundary. */
export type MemoryFrameErrorCode =
  | 'MEMORY_FRAME_DESERIALIZE_FAILED'
  | 'MEMORY_FRAME_SERIALIZE_FAILED'

/** Explicit failure at the Arrow IPC boundary. */
export class MemoryFrameError extends Error {
  readonly code: MemoryFrameErrorCode
  readonly recoverable = false
  readonly context: Record<string, unknown>

  constructor(options: {
    code: MemoryFrameErrorCode
    message: string
    context?: Record<string, unknown>
    cause?: unknown
  }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'MemoryFrameError'
    this.code = options.code
    this.context = options.context ?? {}
  }
}

/** True when `err` is a {@link MemoryFrameError} (optionally of a given code). */
export function isMemoryFrameError(
  err: unknown,
  code?: MemoryFrameErrorCode,
): err is MemoryFrameError {
  if (!(err instanceof MemoryFrameError)) return false
  return code === undefined || err.code === code
}

/** Structural mirror of `FrameworkLogger` from `@dzupagent/core`. */
export interface FrameworkLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Console-backed logger. */
export const defaultLogger: FrameworkLogger = {
  debug(message: string, ...args: unknown[]) { console.debug(message, ...args) },
  info(message: string, ...args: unknown[]) { console.info(message, ...args) },
  warn(message: string, ...args: unknown[]) { console.warn(message, ...args) },
  error(message: string, ...args: unknown[]) { console.error(message, ...args) },
}

/** Emit exactly one structured JSON error line. Never throws. */
export function logFrameError(input: {
  component: string
  operation: string
  error: unknown
  context?: Record<string, unknown>
  logger?: FrameworkLogger
}): void {
  const err = input.error
  const line = {
    level: 'error',
    timestamp: new Date().toISOString(),
    component: input.component,
    operation: input.operation,
    context: input.context ?? {},
    error:
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { name: 'NonError', message: String(err), stack: undefined },
  }
  try {
    ;(input.logger ?? defaultLogger).error(JSON.stringify(line))
  } catch {
    // Logging must never take down the caller.
  }
}
