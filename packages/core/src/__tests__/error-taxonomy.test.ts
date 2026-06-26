/**
 * Error taxonomy tests for @dzupagent/core
 *
 * Covers: error type hierarchy, error codes, retryable vs fatal classification,
 * error serialization, cause chains, instanceof checks, HTTP status mapping,
 * and unknown error wrapping.
 */
import { describe, it, expect } from "vitest";
import { ForgeError } from "../errors/forge-error.js";
import type { ForgeErrorCode } from "../errors/error-codes.js";
import { vectorHttpErrorToForgeError } from "../vectordb/http-error.js";

// ---------------------------------------------------------------------------
// 1. Base error class structure
// ---------------------------------------------------------------------------
describe("ForgeError – base class structure", () => {
  it("inherits from Error", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "base test",
    });
    expect(err).toBeInstanceOf(Error);
  });

  it("has name set to ForgeError", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "name check",
    });
    expect(err.name).toBe("ForgeError");
  });

  it("has message matching the provided message", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "hello world",
    });
    expect(err.message).toBe("hello world");
  });

  it("has code matching the provided code", () => {
    const err = new ForgeError({ code: "TOOL_NOT_FOUND", message: "missing" });
    expect(err.code).toBe("TOOL_NOT_FOUND");
  });

  it("has a stack trace", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "stack test",
    });
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe("string");
  });

  it("defaults recoverable to false when not provided", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "default" });
    expect(err.recoverable).toBe(false);
  });

  it("phase is undefined when not provided", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "no phase" });
    expect(err.phase).toBeUndefined();
  });

  it("suggestion is undefined when not provided", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "no suggestion",
    });
    expect(err.suggestion).toBeUndefined();
  });

  it("context is undefined when not provided", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "no context",
    });
    expect(err.context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Error code enum – all representative codes are valid strings
// ---------------------------------------------------------------------------
describe("ForgeErrorCode – valid string literals", () => {
  const providerCodes: ForgeErrorCode[] = [
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_AUTH_FAILED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_REJECTED_REQUEST",
    "ALL_PROVIDERS_EXHAUSTED",
    "NO_CAPABLE_FALLBACK",
    "RATE_LIMIT_EXCEEDED",
  ];

  const budgetCodes: ForgeErrorCode[] = [
    "BUDGET_EXCEEDED",
    "TOKEN_LIMIT_EXCEEDED",
    "COST_LIMIT_EXCEEDED",
    "ITERATION_LIMIT_EXCEEDED",
    "CONTEXT_LENGTH_EXCEEDED",
  ];

  const toolCodes: ForgeErrorCode[] = [
    "TOOL_NOT_FOUND",
    "TOOL_EXECUTION_FAILED",
    "TOOL_TIMEOUT",
    "TOOL_PERMISSION_DENIED",
    "DESTRUCTIVE_COMMAND_BLOCKED",
  ];

  const mcpCodes: ForgeErrorCode[] = [
    "MCP_CONNECTION_FAILED",
    "MCP_TOOL_NOT_FOUND",
    "MCP_INVOCATION_FAILED",
    "MCP_COMMAND_FORBIDDEN",
    "MCP_PATH_ESCAPE",
  ];

  const securityCodes: ForgeErrorCode[] = [
    "MEMORY_INJECTION_DETECTED",
    "SSRF_BLOCKED",
    "POLICY_DENIED",
    "CAPABILITY_DENIED",
  ];

  const allSamples = [
    ...providerCodes,
    ...budgetCodes,
    ...toolCodes,
    ...mcpCodes,
    ...securityCodes,
  ];

  it.each(allSamples)('code "%s" is a non-empty string', (code) => {
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(0);
  });

  it.each(allSamples)(
    'ForgeError can be constructed with code "%s"',
    (code) => {
      const err = new ForgeError({ code, message: `test for ${code}` });
      expect(err.code).toBe(code);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Retryable (recoverable: true) error scenarios
// ---------------------------------------------------------------------------
describe("Retryable errors – recoverable flag", () => {
  it("PROVIDER_UNAVAILABLE marked recoverable=true", () => {
    const err = new ForgeError({
      code: "PROVIDER_UNAVAILABLE",
      message: "Service down",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });

  it("PROVIDER_RATE_LIMITED marked recoverable=true", () => {
    const err = new ForgeError({
      code: "PROVIDER_RATE_LIMITED",
      message: "Rate limited",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });

  it("PROVIDER_TIMEOUT marked recoverable=true", () => {
    const err = new ForgeError({
      code: "PROVIDER_TIMEOUT",
      message: "Timed out",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });

  it("MCP_CONNECTION_FAILED marked recoverable=true", () => {
    const err = new ForgeError({
      code: "MCP_CONNECTION_FAILED",
      message: "MCP server unreachable",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });

  it("TOOL_TIMEOUT marked recoverable=true", () => {
    const err = new ForgeError({
      code: "TOOL_TIMEOUT",
      message: "Tool call timed out",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Fatal (recoverable: false) error scenarios
// ---------------------------------------------------------------------------
describe("Fatal errors – recoverable flag", () => {
  it("PROVIDER_AUTH_FAILED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "PROVIDER_AUTH_FAILED",
      message: "Invalid API key",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });

  it("CONTEXT_LENGTH_EXCEEDED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "CONTEXT_LENGTH_EXCEEDED",
      message: "Context window exceeded",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });

  it("TOOL_PERMISSION_DENIED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "TOOL_PERMISSION_DENIED",
      message: "Permission denied",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });

  it("DESTRUCTIVE_COMMAND_BLOCKED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "DESTRUCTIVE_COMMAND_BLOCKED",
      message: "rm -rf blocked",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });

  it("APPROVAL_REJECTED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "APPROVAL_REJECTED",
      message: "Human rejected the action",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });

  it("POLICY_DENIED marked recoverable=false", () => {
    const err = new ForgeError({
      code: "POLICY_DENIED",
      message: "Policy check failed",
      recoverable: false,
    });
    expect(err.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Error classification helper – ForgeError.is()
// ---------------------------------------------------------------------------
describe("ForgeError.is() – classification helper", () => {
  it("returns true for ForgeError instance", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "test" });
    expect(ForgeError.is(err)).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(ForgeError.is(new Error("plain"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(ForgeError.is(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(ForgeError.is(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(ForgeError.is("some error string")).toBe(false);
  });

  it("returns false for number", () => {
    expect(ForgeError.is(42)).toBe(false);
  });

  it("returns false for plain object", () => {
    expect(ForgeError.is({ code: "INTERNAL_ERROR", message: "fake" })).toBe(
      false
    );
  });

  it("recoverable field is accessible after is() guard", () => {
    const err: unknown = new ForgeError({
      code: "PROVIDER_RATE_LIMITED",
      message: "rate limited",
      recoverable: true,
    });
    if (ForgeError.is(err)) {
      expect(err.recoverable).toBe(true);
    } else {
      throw new Error("Expected ForgeError");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Rate limit error – retryable + retryAfter context
// ---------------------------------------------------------------------------
describe("Rate limit error pattern", () => {
  it("is classified as recoverable", () => {
    const err = new ForgeError({
      code: "PROVIDER_RATE_LIMITED",
      message: "Rate limited – retry after 60s",
      recoverable: true,
      context: { retryAfter: 60 },
    });
    expect(err.recoverable).toBe(true);
  });

  it("stores retryAfter in context", () => {
    const err = new ForgeError({
      code: "PROVIDER_RATE_LIMITED",
      message: "Rate limited",
      recoverable: true,
      context: { retryAfter: 30, provider: "anthropic" },
    });
    expect(err.context?.retryAfter).toBe(30);
    expect(err.context?.provider).toBe("anthropic");
  });

  it("RATE_LIMIT_EXCEEDED code also works", () => {
    const err = new ForgeError({
      code: "RATE_LIMIT_EXCEEDED",
      message: "Global rate limit hit",
      recoverable: true,
      context: { retryAfter: 120 },
    });
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Auth error – fatal, retrying won't help
// ---------------------------------------------------------------------------
describe("Auth error pattern – fatal classification", () => {
  it("PROVIDER_AUTH_FAILED is non-recoverable", () => {
    const err = new ForgeError({
      code: "PROVIDER_AUTH_FAILED",
      message: "Invalid or expired API key",
    });
    expect(err.recoverable).toBe(false);
    expect(err.code).toBe("PROVIDER_AUTH_FAILED");
  });

  it("includes suggestion to fix credentials", () => {
    const err = new ForgeError({
      code: "PROVIDER_AUTH_FAILED",
      message: "API key rejected",
      suggestion: "Check ANTHROPIC_API_KEY environment variable",
    });
    expect(err.suggestion).toBe("Check ANTHROPIC_API_KEY environment variable");
  });
});

// ---------------------------------------------------------------------------
// 8. Context length error – non-retryable, need to truncate
// ---------------------------------------------------------------------------
describe("Context length error pattern", () => {
  it("CONTEXT_LENGTH_EXCEEDED is non-recoverable by default", () => {
    const err = new ForgeError({
      code: "CONTEXT_LENGTH_EXCEEDED",
      message: "Input exceeds 200k token limit",
    });
    expect(err.recoverable).toBe(false);
  });

  it("TOKEN_LIMIT_EXCEEDED is also non-recoverable by default", () => {
    const err = new ForgeError({
      code: "TOKEN_LIMIT_EXCEEDED",
      message: "Max tokens reached",
    });
    expect(err.recoverable).toBe(false);
  });

  it("stores token count in context for debugging", () => {
    const err = new ForgeError({
      code: "CONTEXT_LENGTH_EXCEEDED",
      message: "Context overflow",
      context: { tokenCount: 205_000, limit: 200_000 },
    });
    expect(err.context?.tokenCount).toBe(205_000);
  });
});

// ---------------------------------------------------------------------------
// 9. Network error – retryable
// ---------------------------------------------------------------------------
describe("Network error pattern – retryable", () => {
  it("MCP_CONNECTION_FAILED with recoverable=true is a retryable network error", () => {
    const err = new ForgeError({
      code: "MCP_CONNECTION_FAILED",
      message: "ECONNREFUSED 127.0.0.1:3000",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
    expect(err.code).toBe("MCP_CONNECTION_FAILED");
  });

  it("PROTOCOL_CONNECTION_FAILED with recoverable=true", () => {
    const err = new ForgeError({
      code: "PROTOCOL_CONNECTION_FAILED",
      message: "WebSocket connection dropped",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });

  it("PROTOCOL_TIMEOUT with recoverable=true", () => {
    const err = new ForgeError({
      code: "PROTOCOL_TIMEOUT",
      message: "SSE stream timed out",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Error serialization – toJSON()
// ---------------------------------------------------------------------------
describe("ForgeError.toJSON() – serialization", () => {
  it("produces a plain object", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "serialize me",
    });
    const json = err.toJSON();
    expect(json).not.toBeInstanceOf(Error);
    expect(typeof json).toBe("object");
  });

  it("includes name, code, message, recoverable fields", () => {
    const err = new ForgeError({
      code: "TOOL_NOT_FOUND",
      message: "no such tool",
    });
    const json = err.toJSON();
    expect(json.name).toBe("ForgeError");
    expect(json.code).toBe("TOOL_NOT_FOUND");
    expect(json.message).toBe("no such tool");
    expect(json.recoverable).toBe(false);
  });

  it("includes phase when set", () => {
    const err = new ForgeError({
      code: "PIPELINE_PHASE_FAILED",
      message: "Phase aborted",
      phase: "gen_backend",
    });
    const json = err.toJSON();
    expect(json.phase).toBe("gen_backend");
  });

  it("includes suggestion when set", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "Oops",
      suggestion: "Reload and try again",
    });
    const json = err.toJSON();
    expect(json.suggestion).toBe("Reload and try again");
  });

  it("includes context when set", () => {
    const err = new ForgeError({
      code: "BUDGET_EXCEEDED",
      message: "Over budget",
      context: { spend: 0.5, limit: 0.25 },
    });
    const json = err.toJSON();
    expect(json.context).toEqual({ spend: 0.5, limit: 0.25 });
  });

  it("is JSON.stringify-safe (no circular references)", () => {
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "circular test",
      context: { nested: { value: 42 } },
    });
    expect(() => JSON.stringify(err.toJSON())).not.toThrow();
  });

  it("JSON.stringify round-trip preserves key fields", () => {
    const err = new ForgeError({
      code: "TOOL_EXECUTION_FAILED",
      message: "round-trip test",
      recoverable: true,
      phase: "test_phase",
    });
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.name).toBe("ForgeError");
    expect(parsed.code).toBe("TOOL_EXECUTION_FAILED");
    expect(parsed.message).toBe("round-trip test");
    expect(parsed.recoverable).toBe(true);
    expect(parsed.phase).toBe("test_phase");
  });
});

// ---------------------------------------------------------------------------
// 11. Error cause chain – cause field preserved through wrapping
// ---------------------------------------------------------------------------
describe("Error cause chain", () => {
  it("cause is set on constructor when provided", () => {
    const root = new Error("root cause");
    const err = new ForgeError({
      code: "MCP_INVOCATION_FAILED",
      message: "wrapped",
      cause: root,
    });
    expect(err.cause).toBe(root);
  });

  it("cause is accessible via err.cause", () => {
    const root = new TypeError("type mismatch");
    const err = new ForgeError({
      code: "TOOL_EXECUTION_FAILED",
      message: "tool failed",
      cause: root,
    });
    expect((err.cause as Error).message).toBe("type mismatch");
  });

  it("ForgeError.wrap() preserves original Error as cause", () => {
    const original = new Error("socket hang up");
    const wrapped = ForgeError.wrap(original, {
      code: "MCP_CONNECTION_FAILED",
    });
    expect(wrapped.cause).toBe(original);
  });

  it("three-level cause chain retains full chain", () => {
    const level1 = new Error("ECONNRESET");
    const level2 = new ForgeError({
      code: "PROTOCOL_CONNECTION_FAILED",
      message: "connection lost",
      cause: level1,
    });
    const level3 = new ForgeError({
      code: "PROVIDER_UNAVAILABLE",
      message: "provider down",
      cause: level2,
    });
    expect(level3.cause).toBe(level2);
    expect((level3.cause as ForgeError).cause).toBe(level1);
  });
});

// ---------------------------------------------------------------------------
// 12. instanceof checks
// ---------------------------------------------------------------------------
describe("instanceof checks", () => {
  it("ForgeError instance passes instanceof ForgeError", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "test" });
    expect(err instanceof ForgeError).toBe(true);
  });

  it("ForgeError instance passes instanceof Error", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "test" });
    expect(err instanceof Error).toBe(true);
  });

  it("plain Error does NOT pass instanceof ForgeError", () => {
    const err = new Error("plain");
    expect(err instanceof ForgeError).toBe(false);
  });

  it("null does not throw when used in instanceof check", () => {
    expect(null instanceof ForgeError).toBe(false);
  });

  it("wrapped error is instanceof ForgeError", () => {
    const wrapped = ForgeError.wrap(new Error("raw"), {
      code: "INTERNAL_ERROR",
    });
    expect(wrapped instanceof ForgeError).toBe(true);
    expect(wrapped instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. ForgeError.wrap() – unknown error wrapping
// ---------------------------------------------------------------------------
describe("ForgeError.wrap() – unknown error wrapping", () => {
  it("wraps a plain Error with provided code", () => {
    const original = new Error("connection refused");
    const err = ForgeError.wrap(original, { code: "MCP_CONNECTION_FAILED" });
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.code).toBe("MCP_CONNECTION_FAILED");
  });

  it("uses original Error message", () => {
    const original = new Error("timeout after 5s");
    const err = ForgeError.wrap(original, { code: "TOOL_TIMEOUT" });
    expect(err.message).toBe("timeout after 5s");
  });

  it("preserves original as cause", () => {
    const original = new RangeError("out of range");
    const err = ForgeError.wrap(original, { code: "INTERNAL_ERROR" });
    expect(err.cause).toBe(original);
  });

  it("returns existing ForgeError unchanged (identity)", () => {
    const original = new ForgeError({
      code: "TOOL_NOT_FOUND",
      message: "nope",
    });
    const result = ForgeError.wrap(original, { code: "INTERNAL_ERROR" });
    expect(result).toBe(original);
    expect(result.code).toBe("TOOL_NOT_FOUND");
  });

  it("wraps string errors without setting cause", () => {
    const err = ForgeError.wrap("string error message", {
      code: "INTERNAL_ERROR",
    });
    expect(err.message).toBe("string error message");
    expect(err.cause).toBeUndefined();
  });

  it('wraps null (converts to string "null")', () => {
    const err = ForgeError.wrap(null, { code: "INTERNAL_ERROR" });
    expect(err.message).toBe("null");
    expect(err.cause).toBeUndefined();
  });

  it("wraps number error values", () => {
    const err = ForgeError.wrap(404, { code: "TOOL_NOT_FOUND" });
    expect(err.message).toBe("404");
  });

  it("allows overriding recoverable via wrap defaults", () => {
    const err = ForgeError.wrap(new Error("timeout"), {
      code: "PROVIDER_TIMEOUT",
      recoverable: true,
    });
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. HTTP status mapping – vectorHttpErrorToForgeError
// ---------------------------------------------------------------------------
describe("HTTP status mapping – vectorHttpErrorToForgeError", () => {
  it("HTTP 429 → VECTOR_STORE_RATE_LIMITED (recoverable)", () => {
    const err = vectorHttpErrorToForgeError(
      429,
      "Too Many Requests",
      "pinecone"
    );
    expect(err.code).toBe("VECTOR_STORE_RATE_LIMITED");
    expect(err.recoverable).toBe(true);
  });

  it("HTTP 401 → VECTOR_STORE_AUTH_FAILED (non-recoverable)", () => {
    const err = vectorHttpErrorToForgeError(401, "Unauthorized", "qdrant");
    expect(err.code).toBe("VECTOR_STORE_AUTH_FAILED");
    expect(err.recoverable).toBe(false);
  });

  it("HTTP 403 → VECTOR_STORE_AUTH_FAILED (non-recoverable)", () => {
    const err = vectorHttpErrorToForgeError(403, "Forbidden", "weaviate");
    expect(err.code).toBe("VECTOR_STORE_AUTH_FAILED");
    expect(err.recoverable).toBe(false);
  });

  it("HTTP 500 → VECTOR_STORE_UNAVAILABLE (recoverable)", () => {
    const err = vectorHttpErrorToForgeError(
      500,
      "Internal Server Error",
      "pinecone"
    );
    expect(err.code).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(err.recoverable).toBe(true);
  });

  it("HTTP 502 → VECTOR_STORE_UNAVAILABLE (recoverable)", () => {
    const err = vectorHttpErrorToForgeError(502, "Bad Gateway", "pinecone");
    expect(err.code).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(err.recoverable).toBe(true);
  });

  it("HTTP 503 → VECTOR_STORE_UNAVAILABLE (recoverable)", () => {
    const err = vectorHttpErrorToForgeError(
      503,
      "Service Unavailable",
      "qdrant"
    );
    expect(err.code).toBe("VECTOR_STORE_UNAVAILABLE");
    expect(err.recoverable).toBe(true);
  });

  it("HTTP 400 → VECTOR_STORE_REJECTED_REQUEST (non-recoverable)", () => {
    const err = vectorHttpErrorToForgeError(400, "Bad Request", "weaviate");
    expect(err.code).toBe("VECTOR_STORE_REJECTED_REQUEST");
    expect(err.recoverable).toBe(false);
  });

  it("HTTP 422 → VECTOR_STORE_REJECTED_REQUEST (non-recoverable)", () => {
    const err = vectorHttpErrorToForgeError(
      422,
      "Unprocessable Entity",
      "pinecone"
    );
    expect(err.code).toBe("VECTOR_STORE_REJECTED_REQUEST");
    expect(err.recoverable).toBe(false);
  });

  it("result is instanceof ForgeError", () => {
    const err = vectorHttpErrorToForgeError(500, "error body", "pinecone");
    expect(err).toBeInstanceOf(ForgeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("stores providerId in context", () => {
    const err = vectorHttpErrorToForgeError(429, null, "my-vector-db");
    expect(err.context?.providerId).toBe("my-vector-db");
  });

  it("stores status in context", () => {
    const err = vectorHttpErrorToForgeError(503, null, "qdrant");
    expect(err.context?.status).toBe(503);
  });

  it("stores body in context", () => {
    const body = { error: "quota exceeded" };
    const err = vectorHttpErrorToForgeError(429, body, "pinecone");
    expect(err.context?.body).toEqual(body);
  });

  it("truncates very long string body in context", () => {
    const longBody = "x".repeat(3_000);
    const err = vectorHttpErrorToForgeError(500, longBody, "qdrant");
    const storedBody = err.context?.body as string;
    expect(storedBody.length).toBeLessThan(3_000);
    expect(storedBody).toContain("[truncated]");
  });

  it("message does NOT include raw body content", () => {
    const sensitiveBody = "SECRET_TOKEN_abc123";
    const err = vectorHttpErrorToForgeError(400, sensitiveBody, "pinecone");
    expect(err.message).not.toContain(sensitiveBody);
  });
});

// ---------------------------------------------------------------------------
// 15. Edge cases and miscellaneous
// ---------------------------------------------------------------------------
describe("ForgeError – edge cases", () => {
  it("empty string message is valid", () => {
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: "" });
    expect(err.message).toBe("");
  });

  it("very long message is preserved", () => {
    const longMsg = "A".repeat(10_000);
    const err = new ForgeError({ code: "INTERNAL_ERROR", message: longMsg });
    expect(err.message).toBe(longMsg);
  });

  it("context with nested objects is preserved", () => {
    const ctx = { outer: { inner: { deep: [1, 2, 3] } } };
    const err = new ForgeError({
      code: "INTERNAL_ERROR",
      message: "deep ctx",
      context: ctx,
    });
    expect(err.context).toEqual(ctx);
  });

  it("two ForgeErrors with same code are independent instances", () => {
    const a = new ForgeError({ code: "TOOL_NOT_FOUND", message: "tool A" });
    const b = new ForgeError({ code: "TOOL_NOT_FOUND", message: "tool B" });
    expect(a).not.toBe(b);
    expect(a.message).toBe("tool A");
    expect(b.message).toBe("tool B");
  });

  it("can be thrown and caught as Error", () => {
    const doThrow = () => {
      throw new ForgeError({ code: "INTERNAL_ERROR", message: "thrown" });
    };
    expect(doThrow).toThrow(Error);
    expect(doThrow).toThrow("thrown");
  });

  it("can be caught and re-identified with ForgeError.is()", () => {
    let caught: unknown;
    try {
      throw new ForgeError({ code: "AGENT_STUCK", message: "stuck agent" });
    } catch (e) {
      caught = e;
    }
    expect(ForgeError.is(caught)).toBe(true);
    if (ForgeError.is(caught)) {
      expect(caught.code).toBe("AGENT_STUCK");
    }
  });

  it("ForgeError.wrap() with non-Error object converts to string message", () => {
    const obj = { detail: "something failed" };
    const err = ForgeError.wrap(obj, { code: "INTERNAL_ERROR" });
    expect(typeof err.message).toBe("string");
    expect(err.message).toBe("[object Object]");
    expect(err.cause).toBeUndefined();
  });
});
