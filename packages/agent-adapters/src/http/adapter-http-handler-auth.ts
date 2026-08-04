/**
 * Auth check for AdapterHttpHandler.
 *
 * Extracted from adapter-http-handler.ts as part of the god-module
 * decomposition (DZUPAGENT-ARCH-M-06). Behavior is unchanged.
 */

import { errorResponse } from "./http-helpers.js";
import type { HttpRequest, HttpResponse } from "./http-types.js";
import type { HandlerContext } from "./adapter-http-handler-context.js";

/**
 * Enforce auth on an incoming request. Returns an error HttpResponse when the
 * request should be rejected, or undefined when it may proceed.
 *
 * Order of precedence:
 *   1. public endpoints pass through
 *   2. no auth configured -> fail CLOSED (500) unless `allowUnauthenticated`
 *   3. custom tokenValidator (takes precedence over legacy key check)
 *   4. legacy simple API key check
 *
 * SEC-C-01: this used to fail OPEN — a handler constructed without any
 * validator served every endpoint (including `POST /run`, which spawns a CLI
 * agent in a caller-supplied working directory) to anonymous callers. Auth is
 * now mandatory; opting out requires the explicit `allowUnauthenticated` flag.
 */
export async function checkAuth(
  ctx: HandlerContext,
  request: HttpRequest
): Promise<HttpResponse | undefined> {
  // Check if this is a public endpoint
  if (ctx.config.publicEndpoints?.includes(request.path)) {
    return undefined;
  }

  // SEC-C-01: fail closed when no authentication mechanism is configured.
  // The dev/loopback path must be opted into explicitly. The response body
  // carries only a stable code — never any configuration detail.
  if (!ctx.validateApiKey && !ctx.config.tokenValidator) {
    if (ctx.config.allowUnauthenticated === true) {
      return undefined;
    }
    return errorResponse(
      500,
      "Adapter HTTP handler has no authentication configured",
      "AUTH_NOT_CONFIGURED"
    );
  }

  const authHeader =
    request.headers["authorization"] ?? request.headers["Authorization"];
  if (!authHeader) {
    return errorResponse(401, "Missing Authorization header", "AUTH_REQUIRED");
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match?.[1]) {
    return errorResponse(
      401,
      "Invalid Authorization format. Expected: Bearer <token>",
      "AUTH_INVALID_FORMAT"
    );
  }

  const token = match[1];

  // Custom token validator takes precedence
  if (ctx.config.tokenValidator) {
    try {
      const result = await ctx.config.tokenValidator(token);
      if (!result.valid) {
        return errorResponse(
          401,
          "Token validation failed",
          "AUTH_TOKEN_INVALID"
        );
      }
      return undefined;
    } catch {
      return errorResponse(
        500,
        "Token validation error",
        "AUTH_VALIDATION_ERROR"
      );
    }
  }

  // Legacy simple API key check
  if (ctx.validateApiKey) {
    const isValid = await ctx.validateApiKey(token);
    if (!isValid) {
      return errorResponse(401, "Invalid API key", "AUTH_INVALID_KEY");
    }
  }

  return undefined;
}
