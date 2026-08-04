/**
 * Minimal structured error logging for `@dzupagent/memory`.
 *
 * ERR-C-22: this package previously had no logging mechanism at all, so the
 * only place a backend failure surfaced was the MCP tool result — i.e. the
 * LLM's context. Full error detail now goes here (server-side logs) and only
 * an opaque `errorId` crosses the trust boundary.
 *
 * The `FrameworkLogger` shape is structurally identical to the interface of
 * the same name in `@dzupagent/core` so a core logger can be passed straight
 * in. It is redeclared rather than imported because `@dzupagent/memory` does
 * not depend on `@dzupagent/core` (see `memory-types.ts` for the same
 * deliberate structural-decoupling convention).
 */

import { randomUUID } from 'node:crypto'

/** Structural mirror of `FrameworkLogger` from `@dzupagent/core`. */
export interface FrameworkLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Console-backed logger used when the caller injects nothing. */
export const defaultLogger: FrameworkLogger = {
  debug(message: string, ...args: unknown[]) { console.debug(message, ...args) },
  info(message: string, ...args: unknown[]) { console.info(message, ...args) },
  warn(message: string, ...args: unknown[]) { console.warn(message, ...args) },
  error(message: string, ...args: unknown[]) { console.error(message, ...args) },
}

/** No-op logger for suppressing output in tests. */
export const noopLogger: FrameworkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface LogErrorInput {
  /** Module emitting the line, e.g. `mcp-memory-server`. */
  component: string
  /** Logical operation, e.g. `handleToolCall:memory_store`. */
  operation: string
  /** The thrown value. */
  error: unknown
  /** Correlation id returned to the caller. Generated when omitted. */
  errorId?: string | undefined
  /** Logger sink. Defaults to {@link defaultLogger}. */
  logger?: FrameworkLogger | undefined
}

/**
 * Emit exactly one structured JSON line describing `error` and return the
 * correlation id that callers should surface instead of the raw message.
 */
export function logError(input: LogErrorInput): string {
  const errorId = input.errorId ?? randomUUID()
  const err = input.error
  const line = {
    level: 'error',
    timestamp: new Date().toISOString(),
    component: input.component,
    operation: input.operation,
    errorId,
    error:
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { name: 'NonError', message: String(err), stack: undefined },
  }
  const logger = input.logger ?? defaultLogger
  try {
    logger.error(JSON.stringify(line))
  } catch {
    // Logging must never take down the caller.
  }
  return errorId
}
