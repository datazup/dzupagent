import { describe, expect, it } from "vitest";

import { waitForCondition } from "../wait-for-condition.js";

describe("waitForCondition", () => {
  it("resolves as soon as the predicate returns true", async () => {
    let calls = 0;
    await waitForCondition(() => {
      calls += 1;
      return calls >= 1;
    });
    expect(calls).toBe(1);
  });

  it("polls repeatedly until the predicate becomes truthy", async () => {
    let calls = 0;
    await waitForCondition(
      () => {
        calls += 1;
        return calls >= 3;
      },
      { intervalMs: 1 }
    );
    expect(calls).toBe(3);
  });

  it("supports an async predicate", async () => {
    let calls = 0;
    await waitForCondition(
      async () => {
        calls += 1;
        await Promise.resolve();
        return calls >= 2;
      },
      { intervalMs: 1 }
    );
    expect(calls).toBe(2);
  });

  it("throws the default message when the predicate never becomes true before the timeout", async () => {
    await expect(
      waitForCondition(() => false, { timeoutMs: 10, intervalMs: 5 })
    ).rejects.toThrow("Condition not met before timeout");
  });

  it("throws the custom description when provided, instead of the default message", async () => {
    await expect(
      waitForCondition(() => false, {
        timeoutMs: 10,
        intervalMs: 5,
        description: "custom timeout reason",
      })
    ).rejects.toThrow("custom timeout reason");
  });

  it("never invokes the predicate a second time once it returned true", async () => {
    let calls = 0;
    await waitForCondition(
      () => {
        calls += 1;
        return true;
      },
      { intervalMs: 1 }
    );
    // If the loop kept spinning after a true result this would eventually
    // exceed 1 — proves the early `return` on success is actually taken.
    expect(calls).toBe(1);
  });
});
