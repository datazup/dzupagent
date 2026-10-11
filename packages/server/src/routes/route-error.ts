/**
 * Centralized route error sanitization.
 *
 * Prevents internal error details (stack traces, DB messages, system info)
 * from leaking to API clients. Only an explicit {@link ClientSafeError}
 * contract discloses an authored message; everything else returns a fixed
 * string.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const GENERIC = "Internal server error";

/**
 * DZUPAGENT-ERR-H-03: brand marking an error whose `publicMessage` was authored
 * for clients. `Symbol.for` keeps recognition working across duplicate module
 * copies of this package.
 */
export const CLIENT_SAFE_ERROR_BRAND: unique symbol = Symbol.for(
  "dzupagent.server.clientSafeError"
);

/**
 * An error carrying an authored, client-safe message.
 *
 * `publicMessage` is what clients see; `message` (the optional
 * `internalMessage`, else the public message) is what server logs and admin
 * diagnostics see. Status classification stays with {@link mapErrorToStatus}:
 * pass a typed `code` such as `AGENT_NOT_FOUND` to surface a 4xx.
 */
export class ClientSafeError extends Error {
  readonly [CLIENT_SAFE_ERROR_BRAND] = true as const;
  readonly publicMessage: string;
  readonly code?: string;

  constructor(
    publicMessage: string,
    options: { code?: string; internalMessage?: string; cause?: unknown } = {}
  ) {
    super(
      options.internalMessage ?? publicMessage,
      options.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.name = "ClientSafeError";
    this.publicMessage = publicMessage;
    if (options.code !== undefined) this.code = options.code;
  }
}

/** Returns `true` for a branded error whose public message is a string. */
export function isClientSafeError(
  err: unknown
): err is { publicMessage: string } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<PropertyKey, unknown>;
  return (
    candidate[CLIENT_SAFE_ERROR_BRAND] === true &&
    typeof candidate.publicMessage === "string"
  );
}

/**
 * DZUPAGENT-ERR-H-03: a class name or message prefix only classifies an error
 * (see {@link mapErrorToStatus}); it never makes the error's own text public.
 * Unbranded errors with these prefixes expose the fixed phrase instead.
 */
const PREFIX_PUBLIC_MESSAGES = [
  ["Validation", "Request validation failed"],
  ["NotFound", "Resource not found"],
  ["Conflict", "Resource conflict"],
  ["BadRequest", "Bad request"],
] as const;

/** Resolve the client-facing message for a thrown value. */
function publicMessageFor(err: unknown): string {
  if (isClientSafeError(err)) return err.publicMessage;
  if (!(err instanceof Error)) return GENERIC;
  const name = err.constructor.name;
  for (const [prefix, phrase] of PREFIX_PUBLIC_MESSAGES) {
    if (name.startsWith(prefix) || err.message.startsWith(prefix)) return phrase;
  }
  return GENERIC;
}

/**
 * Extract a client-safe message from an unknown thrown value.
 *
 * - {@link ClientSafeError} (branded) → its authored `publicMessage`
 * - Validation/NotFound/Conflict/BadRequest-prefixed → a fixed class phrase
 * - Everything else → generic "Internal server error"
 *
 * The raw message is always returned as `internal` so callers can still
 * log it server-side.
 */
export function sanitizeError(err: unknown): {
  safe: string;
  internal: string;
} {
  const internal = err instanceof Error ? err.message : String(err);
  return { safe: publicMessageFor(err), internal };
}

/**
 * DZUPAGENT-ERR-H-02: metadata key under which the full, admin-only run-failure
 * detail (stack trace / driver error text) is stashed on a failed run. Normal
 * (non-admin) REST reads MUST strip this key; only admin-scoped reads expose it.
 * SSE/WS channels never surface it because they carry only the safe message.
 */
export const RUN_ERROR_DETAIL_METADATA_KEY = "errorDetail";

/**
 * DZUPAGENT-ERR-H-02: run-failure message sanitization chokepoint.
 *
 * A run failure carries raw internal text (stack traces, DB driver messages)
 * that must never reach clients over REST/SSE/WS. This computes both the
 * client-safe message (stored on `run.error` and emitted on `agent:failed`)
 * and the full internal detail (stashed admin-only on `run.metadata`).
 *
 * Reuses {@link sanitizeError} so the safe/generic mapping stays consistent
 * with every other 500 catch site in the server.
 */
export function sanitizeFailureMessage(err: unknown): {
  safe: string;
  detail: string;
} {
  const { safe, internal } = sanitizeError(err);
  return { safe, detail: internal };
}

/**
 * Log a route error with structured context and return its sanitized form.
 *
 * Emits a single structured JSON line to `console.error` (stderr) so failures
 * are observable server-side, then returns `sanitizeError(err)` so the caller
 * can build its own response envelope using the client-safe `.safe` message
 * (never the raw `.internal` message). This is the single chokepoint every
 * HTTP 500 catch site should route through to stop `err.message` leaks.
 *
 * @param c       Hono request context (used for method + path).
 * @param operation  Short stable identifier for the failing operation, e.g.
 *                   `'registry.register'`. Used for log filtering/alerting.
 * @param err     The thrown value.
 * @param status  HTTP status that will be returned to the client (default 500).
 */
export function logRouteError(
  c: Pick<Context, "req">,
  operation: string,
  err: unknown,
  status = 500
): { safe: string; internal: string } {
  const sanitized = sanitizeError(err);
  const entry = {
    level: "error",
    operation,
    method: c.req.method,
    path: c.req.path,
    statusCode: status,
    error: {
      message: sanitized.internal,
      name: err instanceof Error ? err.constructor.name : typeof err,
      stack: err instanceof Error ? err.stack : undefined,
    },
    timestamp: new Date().toISOString(),
  };
  // Structured single-line JSON; stderr so it is captured by log shippers.
  console.error(JSON.stringify(entry));
  return sanitized;
}

// ── HTTP status mapping (ERR-M-04) ────────────────────────────────

/**
 * Map a thrown value to an HTTP status code WITHOUT relying on brittle English
 * substring matching at each call site.
 *
 * Preference order:
 *   1. A `ForgeError`-shaped error (has a string `code`): map by code suffix
 *      (`*_NOT_FOUND` → 404, `*_CONFLICT`/`*_ALREADY_EXISTS` → 409,
 *      `*_INVALID`/`*_VALIDATION` / `*_BAD_REQUEST` → 400, `*_UNAVAILABLE` → 503).
 *   2. Error class-name / message safe prefixes (NotFound → 404, Conflict → 409,
 *      Validation / BadRequest → 400). Throw sites that need a non-500 status
 *      MUST opt in: either throw a `ForgeError` (or {@link ClientSafeError})
 *      with a typed `code`, or prefix the message with one of the safe tokens
 *      above. A prefix only classifies; it never discloses the message
 *      (DZUPAGENT-ERR-H-03).
 *   3. Otherwise the caller-supplied `fallback` (default 500).
 *
 * ERR-M-07/L-03: the legacy `message.includes('not found' / 'already exists')`
 * substring fallback has been RETIRED. The server no longer guesses HTTP status
 * from free-text English, so an unclassified `new Error('… not found')` maps to
 * the fallback (500) — callers must use typed `ForgeError` codes or safe
 * prefixes to surface a 4xx.
 */
export function mapErrorToStatus(
  err: unknown,
  fallback: ContentfulStatusCode = 500
): ContentfulStatusCode {
  // 1. ForgeError-shaped: { code: string }
  const code =
    err &&
    typeof err === "object" &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code.toUpperCase()
      : undefined;
  if (code) {
    if (code.endsWith("_NOT_FOUND") || code === "NOT_FOUND") return 404;
    if (
      code.endsWith("_CONFLICT") ||
      code.endsWith("_ALREADY_EXISTS") ||
      code === "CONFLICT"
    )
      return 409;
    if (
      code.endsWith("_INVALID") ||
      code.endsWith("_VALIDATION") ||
      code.endsWith("_BAD_REQUEST") ||
      code === "VALIDATION" ||
      code === "BAD_REQUEST"
    )
      return 400;
    if (code.endsWith("_UNAVAILABLE") || code === "UNAVAILABLE") return 503;
  }

  if (err instanceof Error) {
    const name = err.constructor.name;
    const startsWith = (p: string) =>
      name.startsWith(p) || err.message.startsWith(p);
    if (startsWith("NotFound")) return 404;
    if (startsWith("Conflict")) return 409;
    if (startsWith("Validation") || startsWith("BadRequest")) return 400;
  }

  // ERR-M-07/L-03: no English substring fallback — unclassified errors take the
  // caller-supplied fallback so the server never guesses status from message text.
  return fallback;
}

// ── Numeric query-param parsing ──────────────────────────────────

/**
 * Parse a string query parameter to a bounded integer.
 *
 * Returns `defaultValue` when `raw` is undefined/null.
 * Returns `undefined` when `raw` is present but invalid (NaN, out of bounds).
 * Callers should check for `undefined` and return a 400.
 */
export function parseIntBounded(
  raw: string | undefined | null,
  opts: {
    min?: number | undefined;
    max?: number | undefined;
    defaultValue?: number | undefined;
  } = {}
): number | undefined {
  const { min = 0, max = 10_000, defaultValue } = opts;
  if (raw == null || raw === "") return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < min || n > max) return undefined;
  return n;
}
