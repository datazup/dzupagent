/**
 * DZUPAGENT-AGENT-H-40 — full reads must not inherit LangGraph's default
 * `search` limit of 10.
 */
import { describe, it, expect } from "vitest";
import type { BaseStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import { getKeyedMemoryRecords } from "../memory-service-store.js";
import type { NamespaceConfig } from "../memory-types.js";
import { createStoreDouble } from "./helpers/store-double.js";

/**
 * The shared InMemoryStore double (DZUPAGENT-TEST-H-09): a real LangGraph
 * store, so `limit` defaults to 10, `offset` to 0 and `search` is scoped to
 * the namespace prefix. `count` records go under the read namespace and a
 * sibling tenant carries records that must never be returned.
 */
async function makeDefaultLimitStore(count: number): Promise<BaseStore> {
  const double = createStoreDouble();
  for (let i = 0; i < count; i++) {
    await double.seed(["facts", "t1"], `k${i}`, { text: `fact ${i}` });
  }
  for (let i = 0; i < 3; i++) {
    await double.seed(["facts", "t2"], `other-${i}`, { text: `other tenant ${i}` });
  }
  return double.store;
}

const ns: NamespaceConfig[] = [{ name: "facts", scopeKeys: ["tenantId"] }];

describe("MemoryService full reads on a store with a default search limit", () => {
  it("get() returns all 25 records, not the store's default 10", async () => {
    const svc = new MemoryService(await makeDefaultLimitStore(25), ns);
    const records = await svc.get("facts", { tenantId: "t1" });
    expect(records).toHaveLength(25);
  });

  it("getKeyedMemoryRecords paginates past one page", async () => {
    const records = await getKeyedMemoryRecords(ns[0]!, { tenantId: "t1" }, await makeDefaultLimitStore(1_234));
    expect(records).toHaveLength(1_234);
    expect(new Set(records.map((r) => r.key)).size).toBe(1_234);
    expect(records.some((r) => r.key.startsWith("other-"))).toBe(false);
  });
});
