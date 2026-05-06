/**
 * Minimal logger interface for framework internals.
 *
 * Consumers (apps embedding the framework) inject their own implementation
 * via the `logger` field on services that accept it. The framework's own
 * call sites use `defaultLogger`, which routes to `console.*`.
 */
export interface FrameworkLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Default logger using console (for backward compatibility) */
export const defaultLogger: FrameworkLogger = {
  debug(message: string, ...args: unknown[]) { console.debug(message, ...args) },
  info(message: string, ...args: unknown[]) { console.info(message, ...args) },
  warn(message: string, ...args: unknown[]) { console.warn(message, ...args) },
  error(message: string, ...args: unknown[]) { console.error(message, ...args) },
}

/** No-op logger for suppressing output in tests */
export const noopLogger: FrameworkLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
