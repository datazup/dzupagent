/**
 * SecureLogger — pipes all log output through {@link redactSecrets} before
 * printing (or capturing). Implements MC-SEC-02 from the DzupAgent
 * 2026-05-06 audit.
 *
 * Design choices:
 * - Wraps `console.error` / `console.warn` / `console.info` only. The logger
 *   does NOT take a transport because the framework's existing telemetry
 *   layer (`@dzupagent/otel`) lives downstream — adding it as a dependency
 *   here would create a circular dependency risk. Consumers that want
 *   structured sinks should subscribe to `DzupEventBus` instead.
 * - Supports two input shapes:
 *     - `string` — redacted in place and printed.
 *     - `Record<string, unknown>` — JSON-serialised first, then redacted.
 * - Test-capture mode (`createSecureLogger({ capture: true })`) collects
 *   entries into `logger.captured` rather than printing. This lets tests
 *   assert on the post-redaction message without spamming stdout.
 */
import { redactSecrets } from '../security/secrets-scanner.js'

export interface SecureLogEntry {
  level: 'error' | 'warn' | 'info'
  message: string
  timestamp: number
}

export interface SecureLogger {
  error(message: string | Record<string, unknown>): void
  warn(message: string | Record<string, unknown>): void
  info(message: string | Record<string, unknown>): void
  /** Captured entries when `capture: true`. Empty array otherwise. */
  captured: SecureLogEntry[]
  /** Reset the captured array (no-op when capture is disabled). */
  clearCaptured(): void
}

export interface SecureLoggerOptions {
  /** When true, store entries in `captured` instead of printing. */
  capture?: boolean
  /** Optional prefix prepended to every message (already-redacted). */
  prefix?: string
}

/**
 * Serialise a structured log payload to a stable JSON string. Uses a
 * replacer that turns Error instances into a `{ name, message, stack }`
 * shape so stacks are preserved (and themselves redacted) instead of
 * being lost to `JSON.stringify`'s default Error handling.
 */
function serialise(payload: Record<string, unknown>): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      }
    }
    return value
  }
  try {
    return JSON.stringify(payload, replacer)
  } catch {
    // Fallback for circular references — degrade to a flat string so we
    // never throw from a logger call.
    return String(payload)
  }
}

function toRedactedMessage(
  message: string | Record<string, unknown>,
  prefix: string | undefined,
): string {
  const raw = typeof message === 'string' ? message : serialise(message)
  const prefixed = prefix !== undefined ? `${prefix} ${raw}` : raw
  return redactSecrets(prefixed)
}

/**
 * Create a {@link SecureLogger}. The default singleton (`logger`) is
 * configured with `capture: false`.
 */
export function createSecureLogger(opts: SecureLoggerOptions = {}): SecureLogger {
  const captured: SecureLogEntry[] = []
  const capture = opts.capture === true
  const prefix = opts.prefix

  function emit(level: 'error' | 'warn' | 'info', message: string | Record<string, unknown>): void {
    const redacted = toRedactedMessage(message, prefix)
    if (capture) {
      captured.push({ level, message: redacted, timestamp: Date.now() })
      return
    }
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(redacted)
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(redacted)
    } else {
      // eslint-disable-next-line no-console
      console.info(redacted)
    }
  }

  return {
    error(message): void {
      emit('error', message)
    },
    warn(message): void {
      emit('warn', message)
    },
    info(message): void {
      emit('info', message)
    },
    captured,
    clearCaptured(): void {
      captured.length = 0
    },
  }
}

/**
 * Default singleton used by route handlers and other framework call sites.
 * Capture mode is disabled — output goes to console.* after redaction.
 */
export const logger: SecureLogger = createSecureLogger()
