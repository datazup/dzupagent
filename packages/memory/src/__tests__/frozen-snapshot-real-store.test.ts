import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import { FrozenMemorySnapshot } from "../frozen-snapshot.js";

describe("frozen snapshot keyed reads", () => {
  it("keyed get returns the record while frozen", async () => {
    const svc = new MemoryService(new InMemoryStore(), [
      { name: "decisions", scopeKeys: ["tenantId"], searchable: false },
    ]);
    const scope = { tenantId: "t1" };
    await svc.put("decisions", scope, "d1", { text: "Use Postgres" });
    await svc.put("decisions", scope, "d2", { text: "Use Redis" });

    const snap = new FrozenMemorySnapshot(svc);
    const before = await snap.get("decisions", scope, "d1");
    await snap.freeze(["decisions"], scope);
    const during = await snap.get("decisions", scope, "d1");

    console.log("UNFROZEN", JSON.stringify(before));
    console.log("FROZEN  ", JSON.stringify(during));
    expect(during).toEqual(before);
    expect(during).toHaveLength(1);
  });
});
