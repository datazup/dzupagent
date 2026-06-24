/**
 * Minimal structured logger seam for the subagents runtime.
 *
 * Kept deliberately tiny (no transport, no levels config) so a host can bridge
 * it to any logging backend (pino, winston, an event bus, …) without this
 * package importing one. The default implementation writes a single JSON line
 * per call to stderr — the same observable, dependency-free style used by
 * `@dzupagent/core`'s circuit breaker — so runtime failures, poisoned handlers,
 * orphan reconciliation, TTL expiry, and approval rejections are visible in
 * production even when no host logger is wired.
 */

/** Structured log fields. `taskId`/`code`/`reason` are conventional but free-form. */
export type SubagentLogFields = Record<string, unknown>;

/**
 * The logger seam. Each method takes a structured field bag rather than a
 * format string so logs are machine-parseable. All methods are synchronous and
 * must never throw (the default swallows transport errors).
 */
export interface SubagentLogger {
  error(fields: SubagentLogFields): void;
  warn(fields: SubagentLogFields): void;
  info(fields: SubagentLogFields): void;
  debug(fields: SubagentLogFields): void;
}

type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_SINK: Record<LogLevel, (line: string) => void> = {
  // Route everything to stderr so logs never pollute stdout (which a host may
  // reserve for protocol output). `console.error`/`warn` both target stderr.
  error: (line) => console.error(line),
  warn: (line) => console.warn(line),
  info: (line) => console.error(line),
  debug: (line) => console.error(line),
};

function emit(level: LogLevel, fields: SubagentLogFields): void {
  try {
    LEVEL_SINK[level](
      JSON.stringify({
        level,
        component: "subagents",
        ...fields,
        timestamp: new Date().toISOString(),
      })
    );
  } catch {
    // A logger must never throw into the runtime's control flow.
  }
}

/**
 * Default JSON-to-stderr logger. Emits one structured line per call. Used when
 * a host does not inject its own {@link SubagentLogger}.
 */
export const defaultSubagentLogger: SubagentLogger = {
  error: (fields) => emit("error", fields),
  warn: (fields) => emit("warn", fields),
  info: (fields) => emit("info", fields),
  debug: (fields) => emit("debug", fields),
};

/** A logger that discards everything — useful in tests that assert on a spy instead. */
export const noopSubagentLogger: SubagentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};
