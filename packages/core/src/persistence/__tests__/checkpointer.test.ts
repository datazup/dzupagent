import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

const mocks = vi.hoisted(() => {
  const setup = vi.fn(async () => undefined);
  const saver = { setup, getTuple: vi.fn() };
  return { setup, saver, fromConnString: vi.fn(() => saver) };
});

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: { fromConnString: mocks.fromConnString },
}));

import { createCheckpointer } from "../checkpointer.js";

describe("createCheckpointer", () => {
  beforeEach(() => {
    mocks.fromConnString.mockClear();
    mocks.setup.mockClear();
  });

  it('returns a MemorySaver for type "memory"', async () => {
    const saver = await createCheckpointer({ type: "memory" });
    expect(saver).toBeInstanceOf(MemorySaver);
    expect(mocks.fromConnString).not.toHaveBeenCalled();
  });

  it('rejects for type "postgres" without a connectionString', async () => {
    await expect(createCheckpointer({ type: "postgres" })).rejects.toThrow(
      "connectionString required for postgres checkpointer"
    );
  });

  it("builds a PostgresSaver from the connection string and runs setup()", async () => {
    const connectionString = "postgresql://user:pass@localhost:5432/agents";
    const saver = await createCheckpointer({
      type: "postgres",
      connectionString,
    });
    expect(mocks.fromConnString).toHaveBeenCalledWith(connectionString);
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(saver).toBe(mocks.saver);
  });
});
