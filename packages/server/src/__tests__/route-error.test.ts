import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context } from "hono";
import {
  sanitizeError,
  parseIntBounded,
  logRouteError,
  mapErrorToStatus,
} from "../routes/route-error.js";

function fakeContext(
  method = "POST",
  path = "/api/registry/agents"
): Pick<Context, "req"> {
  return { req: { method, path } } as unknown as Pick<Context, "req">;
}

describe("sanitizeError", () => {
  it("returns generic message for plain Error", () => {
    const result = sanitizeError(new Error("secret DB connection string"));
    expect(result.safe).toBe("Internal server error");
    expect(result.internal).toBe("secret DB connection string");
  });

  it("returns original message for Validation-prefixed error class name", () => {
    class ValidationError extends Error {
      constructor(msg: string) {
        super(msg);
      }
    }
    const result = sanitizeError(new ValidationError("field X is required"));
    expect(result.safe).toBe("field X is required");
    expect(result.internal).toBe("field X is required");
  });

  it("returns original message for NotFound-prefixed error class name", () => {
    class NotFoundError extends Error {
      constructor(msg: string) {
        super(msg);
      }
    }
    const result = sanitizeError(new NotFoundError("Agent not found"));
    expect(result.safe).toBe("Agent not found");
  });

  it("returns original message when error message starts with safe prefix", () => {
    const err = new Error("BadRequest: missing required field");
    const result = sanitizeError(err);
    expect(result.safe).toBe("BadRequest: missing required field");
  });

  it("returns original message for Conflict-prefixed error message", () => {
    const err = new Error("Conflict: resource already exists");
    const result = sanitizeError(err);
    expect(result.safe).toBe("Conflict: resource already exists");
  });

  it("handles non-Error thrown values", () => {
    const result = sanitizeError("string error");
    expect(result.safe).toBe("Internal server error");
    expect(result.internal).toBe("string error");
  });

  it("handles null/undefined thrown values", () => {
    const result = sanitizeError(null);
    expect(result.safe).toBe("Internal server error");
    expect(result.internal).toBe("null");
  });
});

describe("parseIntBounded", () => {
  it("returns defaultValue when raw is undefined", () => {
    expect(parseIntBounded(undefined, { defaultValue: 50 })).toBe(50);
  });

  it("returns defaultValue when raw is null", () => {
    expect(parseIntBounded(null, { defaultValue: 10 })).toBe(10);
  });

  it("returns defaultValue when raw is empty string", () => {
    expect(parseIntBounded("", { defaultValue: 25 })).toBe(25);
  });

  it("returns undefined (no default) when raw is undefined and no defaultValue", () => {
    expect(parseIntBounded(undefined)).toBeUndefined();
  });

  it("parses valid integer within bounds", () => {
    expect(parseIntBounded("42", { min: 0, max: 100 })).toBe(42);
  });

  it("returns undefined for NaN input", () => {
    expect(parseIntBounded("abc", { min: 0, max: 100 })).toBeUndefined();
  });

  it("returns undefined when value is below min", () => {
    expect(parseIntBounded("-5", { min: 0, max: 100 })).toBeUndefined();
  });

  it("returns undefined when value is above max", () => {
    expect(parseIntBounded("200", { min: 0, max: 100 })).toBeUndefined();
  });

  it("uses default min=0 and max=10000", () => {
    expect(parseIntBounded("5000")).toBe(5000);
    expect(parseIntBounded("-1")).toBeUndefined();
    expect(parseIntBounded("10001")).toBeUndefined();
  });

  it("accepts boundary values (min and max are inclusive)", () => {
    expect(parseIntBounded("0", { min: 0, max: 100 })).toBe(0);
    expect(parseIntBounded("100", { min: 0, max: 100 })).toBe(100);
  });
});

describe("logRouteError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a sanitized (generic) safe message for a Prisma-shaped error and logs it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Simulate a Prisma-shaped error: a known error name carrying DB internals.
    class PrismaClientKnownRequestError extends Error {
      code = "P2002";
      constructor(msg: string) {
        super(msg);
        this.name = "PrismaClientKnownRequestError";
      }
    }
    const err = new PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`email`) at table `User`"
    );

    const result = logRouteError(
      fakeContext("POST", "/api/registry/agents"),
      "registry",
      err,
      500
    );

    // Body is sanitized — raw DB text never reaches the client.
    expect(result.safe).toBe("Internal server error");
    expect(result.internal).toContain("Unique constraint failed");

    // Structured log emitted exactly once.
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged.level).toBe("error");
    expect(logged.operation).toBe("registry");
    expect(logged.method).toBe("POST");
    expect(logged.path).toBe("/api/registry/agents");
    expect(logged.statusCode).toBe(500);
    expect(logged.error.message).toContain("Unique constraint failed");
    expect(logged.error.name).toBe("PrismaClientKnownRequestError");
    expect(typeof logged.timestamp).toBe("string");
  });

  it("preserves a client-safe message for safe-prefixed errors while still logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Validation: field X required");

    const result = logRouteError(
      fakeContext("GET", "/api/evals/runs"),
      "evals",
      err,
      400
    );

    expect(result.safe).toBe("Validation: field X required");
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged.statusCode).toBe(400);
    expect(logged.operation).toBe("evals");
  });

  it("defaults status to 500 and handles non-Error thrown values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = logRouteError(fakeContext(), "registry", "boom");

    expect(result.safe).toBe("Internal server error");
    expect(result.internal).toBe("boom");
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged.statusCode).toBe(500);
    expect(logged.error.name).toBe("string");
    expect(logged.error.stack).toBeUndefined();
  });
});

describe("mapErrorToStatus (ERR-M-04)", () => {
  it("maps ForgeError-shaped codes by suffix", () => {
    expect(mapErrorToStatus({ code: "REGISTRY_AGENT_NOT_FOUND" })).toBe(404);
    expect(mapErrorToStatus({ code: "CAPABILITY_ALREADY_EXISTS" })).toBe(409);
    expect(mapErrorToStatus({ code: "INPUT_VALIDATION" })).toBe(400);
    expect(mapErrorToStatus({ code: "PROVIDER_UNAVAILABLE" })).toBe(503);
  });

  it("maps bare code keywords (NOT_FOUND / CONFLICT / BAD_REQUEST)", () => {
    expect(mapErrorToStatus({ code: "NOT_FOUND" })).toBe(404);
    expect(mapErrorToStatus({ code: "CONFLICT" })).toBe(409);
    expect(mapErrorToStatus({ code: "BAD_REQUEST" })).toBe(400);
  });

  it("maps safe-prefixed error class names / messages", () => {
    class NotFoundError extends Error {}
    expect(mapErrorToStatus(new NotFoundError("x"))).toBe(404);
    expect(mapErrorToStatus(new Error("Conflict: dup"))).toBe(409);
    expect(mapErrorToStatus(new Error("Validation: bad"))).toBe(400);
    expect(mapErrorToStatus(new Error("BadRequest: nope"))).toBe(400);
  });

  it("falls back to legacy substring for plain not-found / already-exists errors", () => {
    expect(mapErrorToStatus(new Error("Agent xyz not found"))).toBe(404);
    expect(mapErrorToStatus(new Error("resource already exists"))).toBe(409);
  });

  it("returns the supplied fallback for unclassified errors", () => {
    expect(mapErrorToStatus(new Error("boom"))).toBe(500);
    expect(mapErrorToStatus(new Error("boom"), 400)).toBe(400);
    expect(mapErrorToStatus("not even an error", 502)).toBe(502);
  });

  it("prefers a typed code over an ambiguous message", () => {
    // Code says conflict even though the message mentions "not found".
    expect(
      mapErrorToStatus({ code: "X_CONFLICT", message: "thing not found" })
    ).toBe(409);
  });
});
