import { describe, it, expect } from "vitest";
import { runWithRunTimeout } from "../team-runtime-execute.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("runWithRunTimeout", () => {
  it("returns the run result when it finishes under the limit", async () => {
    const run = sleep(5).then(() => "done");
    await expect(runWithRunTimeout(run, 1000, "team-a")).resolves.toBe("done");
  });

  it("passes through untouched when timeoutMs is undefined", async () => {
    await expect(
      runWithRunTimeout(Promise.resolve(42), undefined, "team-a")
    ).resolves.toBe(42);
  });

  it("rejects with a descriptive error when the run exceeds timeoutMs", async () => {
    const run = sleep(200).then(() => "too late");
    await expect(runWithRunTimeout(run, 10, "team-x")).rejects.toThrow(
      /TeamRuntime\[team-x\]: run exceeded execution\.timeoutMs \(10ms\)/
    );
  });

  it("propagates run rejection that happens under the limit", async () => {
    const run = sleep(5).then(() => {
      throw new Error("pattern exploded");
    });
    await expect(runWithRunTimeout(run, 1000, "team-a")).rejects.toThrow(
      "pattern exploded"
    );
  });
});
