import { describe, it, expect } from "vitest";
import {
  validateRunListQuery,
  buildRunListFilter,
  buildRunListMeta,
  validateCreateRunMetadata,
  canCancelRun,
  canRetryRun,
} from "../routes/evals.js";

// CODE-M-05: unit tests for the pure validators/mappers extracted out of the
// inline route handlers in `createEvalRoutes`. These assert the exact behaviour
// the route wiring relies on, so a regression in one validator is caught in
// isolation without standing up a Hono app or store.

describe("validateRunListQuery", () => {
  it("defaults suiteId/status/limit when nothing is provided", () => {
    const result = validateRunListQuery({});
    expect(result).toEqual({
      ok: true,
      value: { suiteId: undefined, status: null, limit: 50 },
    });
  });

  it("parses a recognized status and passes through suiteId", () => {
    const result = validateRunListQuery({
      suiteId: "s1",
      status: "failed",
      limit: "10",
    });
    expect(result).toEqual({
      ok: true,
      value: { suiteId: "s1", status: "failed", limit: 10 },
    });
  });

  it.each(["queued", "running", "completed", "failed", "cancelled"] as const)(
    "accepts run status %s",
    (status) => {
      const result = validateRunListQuery({ status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe(status);
    }
  );

  it("treats empty-string suiteId/limit as undefined/default", () => {
    const result = validateRunListQuery({ suiteId: "", status: "", limit: "" });
    expect(result).toEqual({
      ok: true,
      value: { suiteId: undefined, status: null, limit: 50 },
    });
  });

  it("rejects a present-but-unrecognized status with a VALIDATION_ERROR", () => {
    const result = validateRunListQuery({ status: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toBe(
        "status must be one of queued, running, completed, failed, or cancelled"
      );
    }
  });

  it("caps limit at the maximum of 250", () => {
    const result = validateRunListQuery({ limit: "9999" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.limit).toBe(250);
  });

  it("falls back to the default limit for non-positive or non-numeric input", () => {
    for (const raw of ["0", "-5", "abc"]) {
      const result = validateRunListQuery({ limit: raw });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.limit).toBe(50);
    }
  });
});

describe("buildRunListFilter", () => {
  it("includes the tenantId filter when a requester tenant is present", () => {
    const filter = buildRunListFilter({
      suiteId: "s1",
      status: "running",
      limit: 25,
      requesterTenantId: "tenant-a",
    });
    expect(filter).toEqual({
      suiteId: "s1",
      status: "running",
      limit: 25,
      tenantId: "tenant-a",
    });
  });

  it("omits the tenantId key entirely when the requester is unauthenticated", () => {
    const filter = buildRunListFilter({
      suiteId: undefined,
      status: null,
      limit: 50,
      requesterTenantId: undefined,
    });
    expect(filter).toEqual({
      suiteId: undefined,
      status: undefined,
      limit: 50,
    });
    expect("tenantId" in filter).toBe(false);
  });

  it("maps a null status to undefined", () => {
    const filter = buildRunListFilter({
      suiteId: "s2",
      status: null,
      limit: 5,
      requesterTenantId: undefined,
    });
    expect(filter.status).toBeUndefined();
  });
});

describe("buildRunListMeta", () => {
  it("omits absent suiteId/status filters and always includes limit", () => {
    const meta = buildRunListMeta({
      service: "evals",
      mode: "read-only",
      writable: false,
      suiteId: undefined,
      status: null,
      limit: 50,
    });
    expect(meta).toEqual({
      service: "evals",
      mode: "read-only",
      writable: false,
      filters: { limit: 50 },
    });
  });

  it("includes suiteId and status filters when present", () => {
    const meta = buildRunListMeta({
      service: "svc",
      mode: "active",
      writable: true,
      suiteId: "s1",
      status: "completed",
      limit: 10,
    });
    expect(meta).toEqual({
      service: "svc",
      mode: "active",
      writable: true,
      filters: { suiteId: "s1", status: "completed", limit: 10 },
    });
  });
});

describe("validateCreateRunMetadata", () => {
  it("accepts an absent metadata field", () => {
    expect(validateCreateRunMetadata({})).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("accepts a plain-object metadata field", () => {
    const metadata = { foo: "bar" };
    expect(validateCreateRunMetadata({ metadata })).toEqual({
      ok: true,
      value: metadata,
    });
  });

  it("rejects an array metadata field", () => {
    const result = validateCreateRunMetadata({
      metadata: [] as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toBe(
        "metadata must be a plain object when provided"
      );
    }
  });

  it("rejects a primitive metadata field", () => {
    const result = validateCreateRunMetadata({
      metadata: "nope" as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a null metadata field", () => {
    const result = validateCreateRunMetadata({
      metadata: null as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
  });
});

describe("canCancelRun", () => {
  it.each(["queued", "running"] as const)("allows cancel from %s", (status) => {
    expect(canCancelRun(status)).toBe(true);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "forbids cancel from terminal state %s",
    (status) => {
      expect(canCancelRun(status)).toBe(false);
    }
  );
});

describe("canRetryRun", () => {
  it("allows retry only from failed", () => {
    expect(canRetryRun("failed")).toBe(true);
  });

  it.each(["queued", "running", "completed", "cancelled"] as const)(
    "forbids retry from %s",
    (status) => {
      expect(canRetryRun(status)).toBe(false);
    }
  );
});
