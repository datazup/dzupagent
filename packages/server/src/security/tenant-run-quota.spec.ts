import { describe, it, expect } from "vitest";
import { InMemoryTenantRunQuota } from "./tenant-run-quota.js";

describe("InMemoryTenantRunQuota", () => {
  it("allows a new run when active < limit", () => {
    const quota = new InMemoryTenantRunQuota();
    quota.increment("tenant-a"); // active = 1
    const result = quota.check("tenant-a", 5);
    expect(result.allowed).toBe(true);
    expect(result.active).toBe(1);
    expect(result.limit).toBe(5);
  });

  it("rejects when active >= limit and reports active/limit", () => {
    const quota = new InMemoryTenantRunQuota();
    quota.increment("tenant-a");
    quota.increment("tenant-a"); // active = 2
    const result = quota.check("tenant-a", 2);
    expect(result.allowed).toBe(false);
    expect(result.active).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.reason).toBeTruthy();
  });

  it("round-trips increment + decrement back to 0", () => {
    const quota = new InMemoryTenantRunQuota();
    quota.increment("tenant-a");
    quota.increment("tenant-a");
    quota.decrement("tenant-a");
    quota.decrement("tenant-a");
    expect(quota.snapshot()["tenant-a"] ?? 0).toBe(0);
  });

  it("never decrements below 0", () => {
    const quota = new InMemoryTenantRunQuota();
    quota.decrement("tenant-a");
    quota.decrement("tenant-a");
    expect(quota.snapshot()["tenant-a"] ?? 0).toBe(0);
    const result = quota.check("tenant-a", 1);
    expect(result.allowed).toBe(true);
    expect(result.active).toBe(0);
  });

  it("snapshot returns current active counts per tenant", () => {
    const quota = new InMemoryTenantRunQuota();
    quota.increment("tenant-a");
    quota.increment("tenant-a");
    quota.increment("tenant-b");
    expect(quota.snapshot()).toEqual({ "tenant-a": 2, "tenant-b": 1 });
  });
});
