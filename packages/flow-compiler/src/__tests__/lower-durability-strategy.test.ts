import { describe, expect, it } from "vitest";

import type { FlowDurabilityPolicy } from "@dzupagent/flow-ast";

import {
  checkpointPolicyFromPolicy,
  checkpointStrategyForRuntime,
  checkpointStrategyFromPolicy,
  executionLogPolicyFromPolicy,
  resumePolicyFromPolicy,
} from "../lower/lower-durability-strategy.js";

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

describe("checkpointStrategyFromPolicy — Gap 2 mode-derive (§5.2)", () => {
  it("returns no strategy for an undefined policy (byte-identical no-op)", () => {
    expect(checkpointStrategyFromPolicy(undefined)).toEqual({ warnings: [] });
  });

  it("prefers an explicit checkpoint.strategy over mode", () => {
    const policy: FlowDurabilityPolicy = {
      mode: "volatile",
      checkpoint: { strategy: "after_each_node" },
    };
    const out = checkpointStrategyFromPolicy(policy);
    expect(out.checkpointStrategy).toBe("after_each_node");
    expect(out.warnings).toHaveLength(0);
  });

  it("carries the coarsening warning when the explicit strategy is coarsened", () => {
    const policy: FlowDurabilityPolicy = {
      checkpoint: { strategy: "after_each_effect" },
    };
    const out = checkpointStrategyFromPolicy(policy);
    expect(out.checkpointStrategy).toBe("after_each_node");
    expect(out.warnings.map((w) => w.code)).toContain(
      "CHECKPOINT_STRATEGY_COARSENED"
    );
  });

  it("derives after_each_node from mode 'checkpointed' when no explicit strategy", () => {
    expect(checkpointStrategyFromPolicy({ mode: "checkpointed" })).toEqual({
      checkpointStrategy: "after_each_node",
      warnings: [],
    });
  });

  it("derives after_each_node from mode 'durable'", () => {
    expect(checkpointStrategyFromPolicy({ mode: "durable" })).toEqual({
      checkpointStrategy: "after_each_node",
      warnings: [],
    });
  });

  it("derives 'none' from mode 'volatile'", () => {
    expect(checkpointStrategyFromPolicy({ mode: "volatile" })).toEqual({
      checkpointStrategy: "none",
      warnings: [],
    });
  });

  it("no-ops when both strategy and mode are absent", () => {
    expect(checkpointStrategyFromPolicy({})).toEqual({ warnings: [] });
  });
});

describe("resumePolicyFromPolicy — Gap 3 additive resume lowering", () => {
  it("returns undefined when no resume block is declared", () => {
    expect(resumePolicyFromPolicy(undefined)).toBeUndefined();
    expect(resumePolicyFromPolicy({})).toBeUndefined();
    expect(resumePolicyFromPolicy({ mode: "durable" })).toBeUndefined();
  });

  it("passes through the declared resume fields", () => {
    const policy: FlowDurabilityPolicy = {
      resume: {
        onProcessRestart: "resume_from_checkpoint",
        requireResumePoint: true,
        maxReplayNodes: 5,
      },
    };
    expect(resumePolicyFromPolicy(policy)).toEqual({
      onProcessRestart: "resume_from_checkpoint",
      requireResumePoint: true,
      maxReplayNodes: 5,
    });
  });

  it("returns undefined when the resume block is present but empty", () => {
    expect(resumePolicyFromPolicy({ resume: {} })).toBeUndefined();
  });
});

describe("checkpointPolicyFromPolicy — W1 runtime checkpoint policy lowering", () => {
  it("passes through storeRef, includeEvents, provider refs, and retention", () => {
    const policy: FlowDurabilityPolicy = {
      checkpoint: {
        storeRef: "primary-checkpoints",
        includeEvents: true,
        includeProviderSessionRefs: true,
        retention: { ttlMs: 60_000, maxVersions: 3 },
      },
    };

    expect(checkpointPolicyFromPolicy(policy)).toEqual({
      storeRef: "primary-checkpoints",
      includeEvents: true,
      includeProviderSessionRefs: true,
      retention: { ttlMs: 60_000, maxVersions: 3 },
    });
  });

  it("returns undefined when no checkpoint runtime policy is declared", () => {
    expect(checkpointPolicyFromPolicy(undefined)).toBeUndefined();
    expect(checkpointPolicyFromPolicy({ checkpoint: {} })).toBeUndefined();
  });
});

describe("executionLogPolicyFromPolicy — W1 execution log policy lowering", () => {
  it("passes through executionLog storeRef and eventHistory", () => {
    expect(
      executionLogPolicyFromPolicy({
        executionLog: { storeRef: "audit-log", eventHistory: "compact" },
      }),
    ).toEqual({ storeRef: "audit-log", eventHistory: "compact" });
  });

  it("returns undefined when no executionLog policy is declared", () => {
    expect(executionLogPolicyFromPolicy(undefined)).toBeUndefined();
    expect(executionLogPolicyFromPolicy({ executionLog: {} })).toBeUndefined();
  });
});
