import { describe, it, expect, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

// Simulates the optional Postgres saver package being absent: any attempt to
// load it throws. Module evaluation of checkpointer.ts must not trigger it.
const state = vi.hoisted(() => ({ loads: 0 }));

vi.mock("@langchain/langgraph-checkpoint-postgres", () => {
  state.loads += 1;
  throw new Error("Cannot find package '@langchain/langgraph-checkpoint-postgres'");
});

import { createCheckpointer } from "../checkpointer.js";

describe("createCheckpointer without the optional Postgres saver", () => {
  it("does not load the Postgres saver when the module is imported", () => {
    expect(state.loads).toBe(0);
  });

  it('returns a MemorySaver for type "memory" with the module absent', async () => {
    const saver = await createCheckpointer({ type: "memory" });
    expect(saver).toBeInstanceOf(MemorySaver);
    expect(state.loads).toBe(0);
  });

  it('rejects type "postgres" with an actionable error naming the package', async () => {
    await expect(
      createCheckpointer({
        type: "postgres",
        connectionString: "postgresql://localhost:5432/agents",
      })
    ).rejects.toThrow(/@langchain\/langgraph-checkpoint-postgres/);
  });
});
