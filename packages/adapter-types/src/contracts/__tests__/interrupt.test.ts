import { describe, it, expect } from "vitest";
import type { InterruptOutcome } from "../interrupt.js";

describe("InterruptOutcome", () => {
  it("accepts a granted outcome with a response payload", () => {
    const outcome: InterruptOutcome<{ selectedOption: string }> = {
      decision: "granted",
      response: { selectedOption: "yes" },
    };
    expect(outcome.decision).toBe("granted");
  });

  it("accepts a rejected outcome with a reason", () => {
    const outcome: InterruptOutcome = {
      decision: "rejected",
      reason: "timeout",
    };
    expect(outcome.decision).toBe("rejected");
  });
});
