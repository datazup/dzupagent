/**
 * Shared handler context + error/validation helpers for AdapterHttpHandler.
 *
 * Extracted from adapter-http-handler.ts as part of the god-module
 * decomposition (DZUPAGENT-ARCH-M-06). These are leaf helpers that operate on
 * a minimal HandlerContext rather than the class, keeping the composition root
 * thin. Behavior is unchanged.
 */

import { ForgeError } from "@dzupagent/core/events";
import type { DzupEventBus } from "@dzupagent/core/events";
import { defaultLogger } from "@dzupagent/core/utils";
import type { z } from "zod";

import type { OrchestratorFacade } from "../facade/orchestrator-facade.js";
import { errorResponse, jsonResponse } from "./http-helpers.js";
import type {
  AdapterApprovalGate,
  AdapterHttpConfig,
  HttpResponse,
} from "./http-types.js";

/**
 * Minimal dependency surface the extracted route/auth/error helpers require.
 * The AdapterHttpHandler class implements this and passes itself through.
 */
export interface HandlerContext {
  readonly orchestrator: OrchestratorFacade;
  readonly approvalGate: AdapterApprovalGate | undefined;
  readonly eventBus: DzupEventBus | undefined;
  readonly config: AdapterHttpConfig;
  readonly validateApiKey:
    | ((key: string) => boolean | Promise<boolean>)
    | undefined;
}

/**
 * Validate a request body against a Zod schema, returning either the parsed
 * body or a 400 error response with per-field details.
 */
export function validateBody<T>(
  body: unknown,
  schema: z.ZodType<T>
): { body: T } | { error: HttpResponse } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      error: jsonResponse(400, {
        error: "Validation failed",
        details: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      }),
    };
  }
  return { body: result.data };
}

/**
 * Translate a thrown error into a client-safe HTTP response.
 *
 * ERR-C-02: never forward raw err.message to the client or the event bus.
 * Log full detail (type + stack) server-side; return a stable code + a
 * client-safe message. A ForgeError exposes its curated code/suggestion only.
 */
export function handleError(
  ctx: HandlerContext,
  err: unknown,
  operation: string
): HttpResponse {
  const internalMessage = err instanceof Error ? err.message : String(err);
  defaultLogger.error("[AdapterHttpHandler] operation failed", {
    operation,
    error: internalMessage,
    name: err instanceof Error ? err.constructor.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  });

  const code = err instanceof ForgeError ? err.code : "INTERNAL_ERROR";
  const clientMessage =
    err instanceof ForgeError && err.suggestion
      ? err.suggestion
      : `Operation "${operation}" failed`;

  if (ctx.eventBus) {
    try {
      ctx.eventBus.emit({
        type: "agent:stream_delta",
        agentId: "http-handler",
        runId: operation,
        content: `[error] ${code}`,
      });
    } catch {
      // Event bus failure is non-fatal
    }
  }

  return errorResponse(500, clientMessage, code);
}
