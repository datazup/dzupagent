/**
 * Pure helpers for the MCP server lifecycle routes: response redaction,
 * payload size validation, transport/argument policy checks, and the
 * forbidden-command error envelope.
 *
 * ARCH-M-06: extracted from the former single-file `./mcp` god-module that
 * fused validation, redaction, error mapping, and route wiring. These are the
 * config-independent (or config-passed) pure functions; the Hono route
 * handlers live in `./mcp-handlers` and the composition root in `./mcp`.
 * Observable HTTP behaviour is unchanged.
 */
import type { Context } from "hono";
import type { AppEnv } from "../types.js";
import { validateMcpHttpEndpoint } from "../security/mcp-url-policy.js";
import type {
  McpServerInput,
  McpServerPatch,
  McpServerDefinition,
} from "@dzupagent/core/pipeline";
import { ForgeError } from "@dzupagent/core/events";
import { getSerializedJsonSizeBytes } from "../validation/route-validator.js";

// ---------------------------------------------------------------------------
// Response redaction (QF-SEC-06)
// ---------------------------------------------------------------------------

/**
 * Redacted view of an {@link McpServerDefinition} for HTTP responses.
 *
 * Inline secrets carried on `env` and sensitive `headers` (authorization,
 * x-api-key, bearer tokens) are replaced with a sentinel string so they
 * are never returned by the management API. Stored definitions retain
 * the original values for the MCP execution path.
 */
export type PublicMcpServerDefinition = Omit<
  McpServerDefinition,
  "env" | "headers"
> & {
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export const SENSITIVE_HEADER_PATTERN =
  /authorization|x-api-key|bearer|x-auth|cookie|token/i;
export const MCP_SERVER_FIELD_MAX_BYTES = 64 * 1024;
export const MCP_PROFILE_MAX_BYTES = 128 * 1024;

export function redactMcpDefinition(
  def: McpServerDefinition
): PublicMcpServerDefinition {
  const redacted: PublicMcpServerDefinition = { ...def };

  if (def.env) {
    redacted.env = Object.fromEntries(
      Object.keys(def.env).map((k) => [k, "[REDACTED]"])
    );
  }

  if (def.headers) {
    redacted.headers = Object.fromEntries(
      Object.entries(def.headers).map(([k, v]) => [
        k,
        SENSITIVE_HEADER_PATTERN.test(k) ? "[REDACTED]" : v,
      ])
    );
  }

  return redacted;
}

export function getOversizedMcpServerField(
  body: Partial<McpServerInput | McpServerPatch>
): "args" | "env" | "headers" | undefined {
  for (const field of ["args", "env", "headers"] as const) {
    if (
      body[field] !== undefined &&
      getSerializedJsonSizeBytes(body[field]) > MCP_SERVER_FIELD_MAX_BYTES
    ) {
      return field;
    }
  }
  return undefined;
}

/** Map a thrown forbidden-command ForgeError to the route error envelope. */
export function forbiddenCommandResponse(
  c: Context<AppEnv>,
  err: unknown
): Response {
  const message =
    err instanceof ForgeError
      ? err.message
      : "stdio MCP command rejected by argument policy.";
  return c.json({ error: { code: "FORBIDDEN", message } }, 403);
}

/**
 * Validate an HTTP/SSE MCP endpoint against the URL policy. Returns a 403
 * {@link Response} to short-circuit the request when the endpoint is rejected,
 * or `undefined` when the transport is not HTTP/SSE or the endpoint is allowed.
 */
export async function validateHttpServerInput(
  server: Pick<McpServerInput, "transport" | "endpoint">,
  allowedHosts: string[] | undefined
): Promise<Response | undefined> {
  if (server.transport !== "http" && server.transport !== "sse")
    return undefined;

  const result = await validateMcpHttpEndpoint(
    server.endpoint,
    server.transport,
    {
      allowedHosts,
    }
  );
  if (result.ok) return undefined;

  return Response.json(
    {
      error: {
        code: "FORBIDDEN",
        message: `MCP ${server.transport.toUpperCase()} endpoint rejected by URL policy: ${
          result.reason
        }`,
      },
    },
    { status: 403 }
  );
}
