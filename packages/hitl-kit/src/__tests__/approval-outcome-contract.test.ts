import { describe, it, expectTypeOf } from "vitest";
import type { ApprovalOutcome } from "../approval-state-store.js";
import type { InterruptOutcome } from "@dzupagent/adapter-types";

describe("ApprovalOutcome / InterruptOutcome contract parity", () => {
  it("ApprovalOutcome is structurally assignable to InterruptOutcome", () => {
    expectTypeOf<ApprovalOutcome>().toMatchTypeOf<InterruptOutcome>();
  });

  it("InterruptOutcome is structurally assignable to ApprovalOutcome", () => {
    expectTypeOf<InterruptOutcome>().toMatchTypeOf<ApprovalOutcome>();
  });
});
