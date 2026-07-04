import { describe, it, expect } from "vitest";
import { InMemoryRunJournal } from "../in-memory-run-journal.js";

describe("InMemoryRunJournal flushPolicy", () => {
  it("accepts append() without an options argument (default behavior unchanged)", async () => {
    const journal = new InMemoryRunJournal();

    const seq = await journal.append("run-1", {
      type: "run_started",
      data: { input: "x" },
    });

    expect(seq).toBe(1);
  });

  it("accepts flushPolicy: 'async' as a no-op option", async () => {
    const journal = new InMemoryRunJournal();

    const seq = await journal.append(
      "run-1",
      { type: "run_started", data: { input: "x" } },
      { flushPolicy: "async" }
    );

    expect(seq).toBe(1);
    const all = await journal.getAll("run-1");
    expect(all).toHaveLength(1);
  });

  it("accepts flushPolicy: 'sync' as a no-op option (no hook mechanism exists yet)", async () => {
    const journal = new InMemoryRunJournal();

    const seq = await journal.append(
      "run-1",
      { type: "run_started", data: { input: "x" } },
      { flushPolicy: "sync" }
    );

    expect(seq).toBe(1);
    const all = await journal.getAll("run-1");
    expect(all).toHaveLength(1);
  });
});
