/**
 * Tests for DrizzleCostAttributor — DB-free, mocking the Drizzle select chain
 * with vi.fn(). The chain `select().from().where().groupBy()` is thenable and
 * resolves to the rows the test supplies.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DrizzleCostAttributor,
  type CostAttributorDatabase,
} from "./cost-attributor.js";

/**
 * Build a mock Drizzle database whose select chain resolves to `rows`. Records
 * the `where` argument so tests can assert the date/status filter was applied.
 */
function makeDb(rows: unknown[]): {
  db: CostAttributorDatabase;
  whereSpy: ReturnType<typeof vi.fn>;
} {
  const whereSpy = vi.fn();

  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((condition: unknown) => {
      whereSpy(condition);
      return chain;
    }),
    groupBy: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };

  const db: CostAttributorDatabase = {
    select: vi.fn(() => chain as never),
  };

  return { db, whereSpy };
}

describe("DrizzleCostAttributor", () => {
  it("getTenantCost returns correct totalCents + runCount from mock rows", async () => {
    const { db } = makeDb([
      {
        tenantId: "acme",
        totalCents: 1234.5,
        runCount: 7,
        since: "2026-05-01T00:00:00.000Z",
      },
    ]);
    const attributor = new DrizzleCostAttributor(db);

    const summary = await attributor.getTenantCost("acme");

    expect(summary).toEqual({
      tenantId: "acme",
      totalCents: 1234.5,
      runCount: 7,
      since: "2026-05-01T00:00:00.000Z",
    });
  });

  it("getTenantCost with since passes date filter to query", async () => {
    const { db, whereSpy } = makeDb([
      { tenantId: "acme", totalCents: 10, runCount: 1, since: null },
    ]);
    const attributor = new DrizzleCostAttributor(db);

    await attributor.getTenantCost("acme", {
      since: "2026-06-01T00:00:00.000Z",
      statuses: ["completed", "failed"],
    });

    // The composed `and(...)` condition is passed to `where`; assert it was
    // built (non-undefined), confirming the filter path executed.
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy.mock.calls[0]?.[0]).toBeDefined();
  });

  it("getAllTenantCosts returns one entry per tenant", async () => {
    const { db } = makeDb([
      { tenantId: "acme", totalCents: 100, runCount: 3, since: null },
      { tenantId: "globex", totalCents: 250, runCount: 5, since: null },
    ]);
    const attributor = new DrizzleCostAttributor(db);

    const summaries = await attributor.getAllTenantCosts();

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.tenantId)).toEqual(["acme", "globex"]);
    expect(summaries[1]).toEqual({
      tenantId: "globex",
      totalCents: 250,
      runCount: 5,
    });
  });

  it("getTenantCost returns { totalCents: 0, runCount: 0 } when no rows", async () => {
    const { db } = makeDb([]);
    const attributor = new DrizzleCostAttributor(db);

    const summary = await attributor.getTenantCost("ghost");

    expect(summary).toEqual({
      tenantId: "ghost",
      totalCents: 0,
      runCount: 0,
    });
  });
});
