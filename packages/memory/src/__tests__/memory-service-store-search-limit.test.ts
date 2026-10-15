/**
 * DZUPAGENT-AGENT-H-40 — full reads must not inherit LangGraph's default
 * `search` limit of 10.
 */
import { describe, it, expect } from "vitest";
import type { BaseStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import { getKeyedMemoryRecords } from "../memory-service-store.js";
import type { NamespaceConfig } from "../memory-types.js";

/** Mirrors LangGraph BaseStore: `limit` defaults to 10, `offset` to 0. */
function makeDefaultLimitStore(count: number): BaseStore {
  const rows = Array.from({ length: count }, (_, i) => ({
    namespace: ["facts", "t1"],
    key: `k${i}`,
    value: { text: `fact ${i}` },
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  return {
    search: async (_ns: string[], opts?: { limit?: number; offset?: number }) => {
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 10;
      return rows.slice(offset, offset + limit);
    },
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as BaseStore;
}

const ns: NamespaceConfig[] = [{ name: "facts", scopeKeys: ["tenantId"] }];

describe("MemoryService full reads on a store with a default search limit", () => {
  it("get() returns all 25 records, not the store's default 10", async () => {
    const svc = new MemoryService(makeDefaultLimitStore(25), ns);
    const records = await svc.get("facts", { tenantId: "t1" });
    expect(records).toHaveLength(25);
  });

  it("getKeyedMemoryRecords paginates past one page", async () => {
    const records = await getKeyedMemoryRecords(ns[0]!, { tenantId: "t1" }, makeDefaultLimitStore(1_234));
    expect(records).toHaveLength(1_234);
    expect(new Set(records.map((r) => r.key)).size).toBe(1_234);
  });
});
