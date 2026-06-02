import { describe, it, expect } from "vitest";
import { CheckpointStorePort } from "../checkpoint-store-port.js";
import { InMemoryCheckpointStore } from "../../session/workflow-checkpointer.js";

const fixedNow = () => new Date(0);

describe("CheckpointStorePort", () => {
  it("saves a snapshot and loads it back by ref", async () => {
    const port = new CheckpointStorePort(
      new InMemoryCheckpointStore(),
      fixedNow,
    );
    const ref = await port.save("task-1", { cursor: 42 });
    expect(ref).toBe("task-1:1");
    expect(await port.load(ref)).toEqual({ cursor: 42 });
  });

  it("versions successive saves for the same task", async () => {
    const port = new CheckpointStorePort(
      new InMemoryCheckpointStore(),
      fixedNow,
    );
    const r1 = await port.save("t", { n: 1 });
    const r2 = await port.save("t", { n: 2 });
    expect(r1).toBe("t:1");
    expect(r2).toBe("t:2");
    expect(await port.load(r1)).toEqual({ n: 1 });
    expect(await port.load(r2)).toEqual({ n: 2 });
  });

  it("returns null for an unknown ref", async () => {
    const port = new CheckpointStorePort(
      new InMemoryCheckpointStore(),
      fixedNow,
    );
    expect(await port.load("missing:1")).toBeNull();
  });

  it("returns null for a malformed ref", async () => {
    const port = new CheckpointStorePort(
      new InMemoryCheckpointStore(),
      fixedNow,
    );
    expect(await port.load("no-version")).toBeNull();
    expect(await port.load("bad:notanumber")).toBeNull();
  });
});
