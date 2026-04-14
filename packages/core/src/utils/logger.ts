/** Minimal logger interface for framework internals */
export interface FrameworkLogger {
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Default logger using console (for backward compatibility) */
export const defaultLogger: FrameworkLogger = {
  warn(message: string, ...args: unknown[]) { console.warn(message, ...args) },
  error(message: string, ...args: unknown[]) { console.error(message, ...args) },
}

/** No-op logger for suppressing output in tests */
export const noopLogger: FrameworkLogger = {
  warn: () => {},
  error: () => {},
}
