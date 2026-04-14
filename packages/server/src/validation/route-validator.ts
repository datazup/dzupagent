/**
 * Shared route validation helpers using Zod at the route boundary.
 *
 * These helpers parse incoming request bodies and query parameters against
 * a Zod schema and return either the parsed data or a structured 400 error
 * response. This keeps validation logic consistent across all route handlers.
 */
import type { Context } from 'hono'
import type { ZodType } from 'zod'

/** Structured error response shape returned on validation failure. */
export interface ValidationErrorResponse {
  error: 'VALIDATION_ERROR'
  issues: ReadonlyArray<{ code: string; path: ReadonlyArray<string | number>; message: string }>
}

/**
 * Validate the JSON request body against a Zod schema.
 *
 * Returns the parsed value on success, or sends a 400 JSON response and
 * returns a `Response` on failure. Callers should check:
 *
 * ```ts
 * const data = await validateBody(c, MySchema)
 * if (data instanceof Response) return data
 * // data is now typed as T
 * ```
 */
export async function validateBody<T>(c: Context, schema: ZodType<T>): Promise<T | Response> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json(
      {
        error: 'VALIDATION_ERROR' as const,
        issues: [{ code: 'invalid_json', path: [], message: 'Request body is not valid JSON' }],
      } satisfies ValidationErrorResponse,
      400,
    )
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    return c.json(
      {
        error: 'VALIDATION_ERROR' as const,
        issues: mapIssues(result.error.issues),
      } satisfies ValidationErrorResponse,
      400,
    )
  }

  return result.data
}

/**
 * Validate query parameters against a Zod schema.
 *
 * Extracts all query params from the request URL and validates them.
 * Returns the parsed value on success, or sends a 400 JSON response
 * and returns a `Response` on failure.
 *
 * ```ts
 * const params = validateQuery(c, MyQuerySchema)
 * if (params instanceof Response) return params
 * ```
 */
export function validateQuery<T>(c: Context, schema: ZodType<T>): T | Response {
  const raw = c.req.query()

  const result = schema.safeParse(raw)
  if (!result.success) {
    return c.json(
      {
        error: 'VALIDATION_ERROR' as const,
        issues: mapIssues(result.error.issues),
      } satisfies ValidationErrorResponse,
      400,
    )
  }

  return result.data
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Coerce Zod issue paths (PropertyKey[]) to JSON-safe (string | number)[]. */
function mapIssues(
  issues: ReadonlyArray<{ code: string; path: PropertyKey[]; message: string }>,
): ValidationErrorResponse['issues'] {
  return issues.map((issue) => ({
    code: String(issue.code),
    path: issue.path.map((seg) => (typeof seg === 'symbol' ? String(seg) : seg)),
    message: issue.message,
  }))
}
