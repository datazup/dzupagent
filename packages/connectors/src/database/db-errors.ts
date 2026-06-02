/**
 * Database connector — error containment (DZUPAGENT-ERR-M-06 / RF-4).
 *
 * Classifies raw driver errors into a fixed, non-sensitive category vocabulary
 * and returns a client/LLM-safe summary while logging full detail server-side.
 * The raw driver text NEVER reaches the tool/LLM output.
 */

/**
 * Typed wrapper for database tool failures. Carries the raw driver error for
 * server-side logging while keeping a client/LLM-safe summary separate.
 */
export class DbToolError extends Error {
  readonly operation: string;
  readonly category: string;
  readonly cause?: unknown;

  constructor(
    operation: string,
    category: string,
    summary: string,
    cause?: unknown
  ) {
    super(summary);
    this.name = "DbToolError";
    this.operation = operation;
    this.category = category;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Classify a driver error into a coarse, non-sensitive category. The raw
 * message is NEVER inspected for content that is echoed back — only matched to
 * a fixed category vocabulary so the LLM gets a useful hint without leaking
 * table/column/constraint/connection internals.
 */
function classifyDbError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    raw.includes("does not exist") ||
    raw.includes("not found") ||
    raw.includes("unknown")
  ) {
    return "object_not_found";
  }
  if (raw.includes("syntax") || raw.includes("parse")) return "syntax_error";
  if (
    raw.includes("permission") ||
    raw.includes("denied") ||
    raw.includes("not allowed")
  ) {
    return "permission_denied";
  }
  if (raw.includes("timeout") || raw.includes("timed out")) return "timeout";
  if (
    raw.includes("connect") ||
    raw.includes("econnrefused") ||
    raw.includes("connection")
  ) {
    return "connection_error";
  }
  if (
    raw.includes("constraint") ||
    raw.includes("duplicate") ||
    raw.includes("violat")
  ) {
    return "constraint_violation";
  }
  return "query_failed";
}

/** Client/LLM-safe summary per category — no raw driver text. */
const DB_CATEGORY_SUMMARY: Record<string, string> = {
  object_not_found:
    "the referenced table, column, or object was not found — verify names with db-list-tables / db-describe-table",
  syntax_error: "the SQL could not be parsed — check the statement syntax",
  permission_denied: "the operation was not permitted for this connection",
  timeout: "the operation timed out",
  connection_error: "the database connection failed",
  constraint_violation: "the operation violated a database constraint",
  query_failed: "the operation failed",
};

/**
 * Contain a database error: log full detail server-side (structured, stderr)
 * and return a sanitized, category-based message string for the LLM/tool output.
 * The raw driver text never reaches the tool result.
 *
 * @param operation  Stable operation id for logging/classification.
 * @param prefix     Client-facing message prefix (preserves the historical
 *                   tool-output shape, e.g. `"Query error"`).
 */
export function handleDbToolError(
  operation: string,
  prefix: string,
  err: unknown
): string {
  const category = classifyDbError(err);
  const summary =
    DB_CATEGORY_SUMMARY[category] ?? DB_CATEGORY_SUMMARY["query_failed"]!;
  // Wrap in the typed error so the cause + sanitized summary travel together.
  const wrapped = new DbToolError(operation, category, summary, err);
  // Full detail server-side only — never echoed to the LLM/tool output.
  console.error(
    JSON.stringify({
      level: "error",
      component: "db-connector",
      operation: wrapped.operation,
      category: wrapped.category,
      error: {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.constructor.name : typeof err,
        stack: err instanceof Error ? err.stack : undefined,
      },
      timestamp: new Date().toISOString(),
    })
  );
  return `${prefix}: ${wrapped.message}.`;
}
