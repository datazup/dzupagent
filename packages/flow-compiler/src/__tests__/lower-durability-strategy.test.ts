import { describe, expect, it } from "vitest";

import { checkpointStrategyForRuntime } from "../lower/lower-durability-strategy.js";

describe("checkpointStrategyForRuntime — W1 Slice 2 vocab reconciliation (Option A)", () => {
  it("maps after_each_node 1:1 (real runtime behavior today)", () => {
    expect(checkpointStrategyForRuntime("after_each_node")).toEqual({
      strategy: "after_each_node",
      coarsened: false,
    });
  });

  it("maps explicit → manual (author-triggered; runtime honors manual as skip-auto)", () => {
    expect(checkpointStrategyForRuntime("explicit")).toEqual({
      strategy: "manual",
      coarsened: false,
    });
  });

  it("coarsens after_each_effect → after_each_node and flags it (finer granularity unimplemented)", () => {
    expect(checkpointStrategyForRuntime("after_each_effect")).toEqual({
      strategy: "after_each_node",
      coarsened: true,
    });
  });

  it("coarsens after_each_branch → after_each_node and flags it", () => {
    expect(checkpointStrategyForRuntime("after_each_branch")).toEqual({
      strategy: "after_each_node",
      coarsened: true,
    });
  });

  it("returns undefined strategy when the AST strategy is absent (byte-identical no-op)", () => {
    expect(checkpointStrategyForRuntime(undefined)).toEqual({
      strategy: undefined,
      coarsened: false,
    });
  });
});
