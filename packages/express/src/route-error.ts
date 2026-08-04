/**
 * Package-local error sanitisation chokepoint for `@dzupagent/express`.
 *
 * DZUPAGENT-ERR-C-04 / DZUPAGENT-SEC-M-14: no HTTP or SSE surface in this
 * package may place a raw `Error.message` into a client-visible payload.
 * Internal failure detail (driver text, stack traces, file paths, connection
 * strings) is logged server-side through the configured `FrameworkLogger` and
 * replaced on the wire with a generic, non-attributable string.
 *
 * Design notes (deliberately divergent from `@dzupagent/server`'s
 * `routes/route-error.ts`, whose defects are logged as SEC-M-10 / SEC-M-11):
 *
 * - Client safety is **explicit and typed**, never inferred from the shape of
 *   a message string. An error is only forwarded verbatim when it is a
 *   {@link ClientSafeError} — i.e. the thrower opted in. A raw
 *   `new Error('Validation of the postgres DSN failed: postgres://u:p@host')`
 *   is NOT client-safe here, whereas a `startsWith` prefix check would leak it.
 * - Logging goes through the injected `FrameworkLogger`, never `console.*`,
 *   so hosts keep a single structured sink.
 */

import type { FrameworkLogger } from "@dzupagent/core/utils";

/** Generic message returned to clients for any non-client-safe error. */
export const GENERIC_ERROR_MESSAGE = "Internal error";

/** Machine-readable code paired with {@link GENERIC_ERROR_MESSAGE}. */
export const GENERIC_ERROR_CODE = "INTERNAL_ERROR";

/**
 * Marker for errors whose `message` the thrower has explicitly declared safe
 * to return to an untrusted client.
 *
 * Opting in is a deliberate act: construct this class (or set the brand on a
 * subclass) only when the message is authored for end users and contains no
 * internal detail.
 */
export class ClientSafeError extends Error {
  /** Brand checked by {@link isClientSafeError} across realm boundaries. */
  readonly clientSafe = true as const;

  /** Optional machine-readable code returned alongside the message. */
  readonly code: string;

  constructor(message: string, code = "CLIENT_ERROR") {
    super(message);
    this.name = "ClientSafeError";
    this.code = code;
  }
}

/**
 * Type guard for {@link ClientSafeError}.
 *
 * Uses the `clientSafe` brand rather than `instanceof` so errors crossing a
 * module-duplication or realm boundary are still recognised.
 */
export function isClientSafeError(err: unknown): err is ClientSafeError {
  return (
    err instanceof Error &&
    (err as Partial<ClientSafeError>).clientSafe === true &&
    typeof err.message === "string"
  );
}

/** Coerce an unknown thrown value into an `Error`. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Result of sanitising a thrown value for client presentation. */
export interface SanitizedError {
  /** Message safe to place in an HTTP body or SSE frame. */
  safeMessage: string;
  /** Machine-readable code safe to place in a client payload. */
  code: string;
  /** The coerced underlying error — for server-side logging ONLY. */
  error: Error;
}

/**
 * Split a thrown value into a client-safe projection and the internal error.
 *
 * Only {@link ClientSafeError} instances keep their message; everything else
 * collapses to {@link GENERIC_ERROR_MESSAGE}.
 */
export function sanitizeError(err: unknown): SanitizedError {
  const error = toError(err);
  if (isClientSafeError(err)) {
    return { safeMessage: err.message, code: err.code, error };
  }
  return {
    safeMessage: GENERIC_ERROR_MESSAGE,
    code: GENERIC_ERROR_CODE,
    error,
  };
}

/** Optional request-shaped context recorded alongside a route error. */
export interface RouteErrorContext {
  /** Extra structured fields merged into the log entry. */
  [key: string]: unknown;
}

/**
 * The single chokepoint: log the real error server-side, return only the
 * client-safe projection.
 *
 * Always emits exactly one structured log entry via `logger.error`, including
 * when no `hooks.onError` is configured — the previous behaviour optional-chained
 * the hook and therefore dropped the failure entirely when it was unset.
 *
 * @param logger  Configured structured logger (never `console`).
 * @param scope   Stable log-message scope, e.g. `'[express/mcp-router]'`.
 * @param err     The thrown value.
 * @param context Additional structured fields to record.
 * @returns The sanitised projection to place on the wire.
 */
export function routeError(
  logger: FrameworkLogger,
  scope: string,
  err: unknown,
  context: RouteErrorContext = {}
): SanitizedError {
  const sanitized = sanitizeError(err);
  logger.error(`${scope} route error`, {
    message: sanitized.error.message,
    stack: sanitized.error.stack,
    ...context,
  });
  return sanitized;
}
