import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context } from "hono";
import {
  ClientSafeError,
  sanitizeError,
  sanitizeFailureMessage,
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

  // DZUPAGENT-ERR-H-03: a matching class name or message prefix classifies the
  // error but never discloses its text; only a fixed per-class phrase is public.
  it("returns a fixed phrase for a Validation-prefixed error class name", () => {
    class ValidationError extends Error {
      constructor(msg: string) {
        super(msg);
      }
    }
    const result = sanitizeError(new ValidationError("field X is required"));
    expect(result.safe).toBe("Request validation failed");
    expect(result.internal).toBe("field X is required");
  });

  it("returns a fixed phrase for a NotFound-prefixed error class name", () => {
    class NotFoundError extends Error {
      constructor(msg: string) {
        super(msg);
      }
    }
    const result = sanitizeError(new NotFoundError("Agent not found"));
    expect(result.safe).toBe("Resource not found");
    expect(result.internal).toBe("Agent not found");
  });

  it("returns a fixed phrase when error message starts with a BadRequest prefix", () => {
    const err = new Error("BadRequest: missing required field");
    const result = sanitizeError(err);
    expect(result.safe).toBe("Bad request");
    expect(result.internal).toBe("BadRequest: missing required field");
  });

  it("returns a fixed phrase for a Conflict-prefixed error message", () => {
    const err = new Error("Conflict: resource already exists");
    const result = sanitizeError(err);
    expect(result.safe).toBe("Resource conflict");
    expect(result.internal).toBe("Conflict: resource already exists");
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

  it("returns only the class phrase for safe-prefixed errors while logging the full text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Validation: field X required");

    const result = logRouteError(
      fakeContext("GET", "/api/evals/runs"),
      "evals",
      err,
      400
    );

    expect(result.safe).toBe("Request validation failed");
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged.statusCode).toBe(400);
    expect(logged.operation).toBe("evals");
    expect(logged.error.message).toBe("Validation: field X required");
  });

  it("returns the authored public message of a ClientSafeError and logs its internal text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new ClientSafeError('Agent "a1" not found', {
      code: "AGENT_NOT_FOUND",
      internalMessage: "lookup failed on replica db-7",
    });

    const result = logRouteError(fakeContext(), "registry", err, 404);

    expect(result.safe).toBe('Agent "a1" not found');
    const logged = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(logged.error.message).toBe("lookup failed on replica db-7");
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

  it("ERR-M-07: retires the legacy substring fallback — plain not-found / already-exists no longer map to 4xx", () => {
    // The English-substring guess has been removed. An unclassified plain Error
    // (no ForgeError code, no safe prefix) now maps to the fallback (500), so the
    // server never guesses HTTP status from free-text message content.
    expect(mapErrorToStatus(new Error("not found"))).toBe(500);
    expect(mapErrorToStatus(new Error("Agent xyz not found"))).toBe(500);
    expect(mapErrorToStatus(new Error("resource already exists"))).toBe(500);
  });

  it("ERR-M-07: callers must opt in via a typed code or safe prefix to get a 4xx", () => {
    // Typed ForgeError code → 404 (preferred migration path).
    expect(mapErrorToStatus({ code: "EVAL_RUN_NOT_FOUND" })).toBe(404);
    // Safe message prefix → 404 (legacy convention still honored).
    expect(mapErrorToStatus(new Error("NotFound: Eval run not found"))).toBe(
      404
    );
    // Same plain message WITHOUT prefix/code → fallback, not 404.
    expect(mapErrorToStatus(new Error("Eval run not found"))).toBe(500);
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

describe("explicit client-safe error contract (DZUPAGENT-ERR-H-03)", () => {
  const MARKER = "postgres://svc:SECRET-MARKER-7f3a@db.internal:5432/runs";
  const PREFIXES = [
    ["Validation", "Request validation failed", 400],
    ["NotFound", "Resource not found", 404],
    ["Conflict", "Resource conflict", 409],
    ["BadRequest", "Bad request", 400],
  ] as const;

  for (const [prefix, phrase, status] of PREFIXES) {
    it(`does not disclose a sensitive suffix after a "${prefix}" message prefix`, () => {
      const err = new Error(`${prefix}: connect failed ${MARKER}`);
      const result = sanitizeError(err);
      expect(result.safe).toBe(phrase);
      expect(result.safe).not.toContain("SECRET-MARKER");
      expect(result.internal).toContain("SECRET-MARKER");
      // Status classification is unchanged and independent of disclosure.
      expect(mapErrorToStatus(err)).toBe(status);
    });

    it(`does not disclose an arbitrary message of a "${prefix}*" error subclass`, () => {
      const Named = { [`${prefix}DriverError`]: class extends Error {} }[
        `${prefix}DriverError`
      ]!;
      const err = new Named(`driver failure ${MARKER}`);
      expect(err.constructor.name).toBe(`${prefix}DriverError`);
      const result = sanitizeError(err);
      expect(result.safe).toBe(phrase);
      expect(result.safe).not.toContain("SECRET-MARKER");
      expect(result.internal).toContain("SECRET-MARKER");
      expect(mapErrorToStatus(err)).toBe(status);
    });
  }

  it("discloses only the authored publicMessage of a ClientSafeError", () => {
    const err = new ClientSafeError('Cluster "c1" not found', {
      code: "CLUSTER_NOT_FOUND",
      internalMessage: `cluster lookup failed ${MARKER}`,
    });
    const result = sanitizeError(err);
    expect(result.safe).toBe('Cluster "c1" not found');
    expect(result.internal).toContain("SECRET-MARKER");
    expect(err.message).toContain("SECRET-MARKER");
    expect(mapErrorToStatus(err)).toBe(404);
  });

  it("uses the public message as the internal message when none is given", () => {
    const err = new ClientSafeError("Invalid schedule expression");
    expect(sanitizeError(err)).toEqual({
      safe: "Invalid schedule expression",
      internal: "Invalid schedule expression",
    });
    // Without a typed code the status falls back to the caller default.
    expect(mapErrorToStatus(err)).toBe(500);
    expect(mapErrorToStatus(err, 400)).toBe(400);
  });

  it("recognizes the Symbol.for brand on errors from another module copy", () => {
    const foreign = Object.assign(new Error(`internal ${MARKER}`), {
      [Symbol.for("dzupagent.server.clientSafeError")]: true,
      publicMessage: "Shown to clients",
    });
    expect(sanitizeError(foreign).safe).toBe("Shown to clients");
  });

  it("ignores a brand whose publicMessage is not a string", () => {
    const forged = Object.assign(new Error(`internal ${MARKER}`), {
      [Symbol.for("dzupagent.server.clientSafeError")]: true,
      publicMessage: { text: MARKER },
    });
    expect(sanitizeError(forged).safe).toBe("Internal server error");
  });

  it("does not trust a publicMessage field without the brand", () => {
    const err = Object.assign(new Error(`internal ${MARKER}`), {
      publicMessage: `leak ${MARKER}`,
    });
    expect(sanitizeError(err).safe).toBe("Internal server error");
  });

  it("keeps ordinary Prisma-shaped and generic errors generic", () => {
    class PrismaClientKnownRequestError extends Error {
      code = "P2002";
    }
    expect(
      sanitizeError(new PrismaClientKnownRequestError(`Unique constraint ${MARKER}`)).safe
    ).toBe("Internal server error");
    expect(sanitizeError(new TypeError(`x is undefined ${MARKER}`)).safe).toBe(
      "Internal server error"
    );
  });

  it("sanitizeFailureMessage keeps prefix-spoofed detail out of the safe message", () => {
    const { safe, detail } = sanitizeFailureMessage(
      new Error(`Validation: run aborted ${MARKER}`)
    );
    expect(safe).toBe("Request validation failed");
    expect(safe).not.toContain("SECRET-MARKER");
    expect(detail).toContain("SECRET-MARKER");
  });
});
