import {
  denyAllSpawnPolicy,
  allowAllSpawnPolicy,
} from "../../governance/spawn-gate.js";
import type { SpawnPolicy } from "../../governance/spawn-gate.js";
import type { FanoutEvalCase } from "../types.js";
import type { SpawnDecisionCase } from "../spawn-decision-scorer.js";

/** A policy that requires approval for any batch, then allows once approved. */
const approvalRequiredPolicy: SpawnPolicy = {
  check: () => ({ allow: true, requiresApproval: true }),
  checkWithContext: (_spec, ctx) =>
    ctx.batch?.approved === true
      ? { allow: true, requiresApproval: false }
      : { allow: true, requiresApproval: true },
};

/** A policy that denies any agentId other than "trusted-agent". */
const agentAllowlistPolicy: SpawnPolicy = {
  check: (spec) =>
    spec.agentId === "trusted-agent"
      ? { allow: true, requiresApproval: false }
      : { allow: false, reason: "agent_not_allowlisted" },
};

/**
 * Spawn-decision-quality scenarios (fanout eval area 1). Mix of known-good
 * (correct admission + scope-narrowing) and known-bad (a deliberately WRONG
 * expectation, so the meta-tests can assert the scorer actually catches it)
 * cases — see `__tests__/spawn-decision-scorer.test.ts`.
 */
export const SPAWN_DECISION_SCENARIOS: Array<
  FanoutEvalCase<SpawnDecisionCase>
> = [
  {
    id: "sd-001-allow-all-admits-batch",
    description:
      "allow-all policy admits a batch and all narrowly-scoped items.",
    tags: ["known-good", "admission"],
    input: {
      policy: allowAllSpawnPolicy,
      request: {
        batchId: "b1",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
        itemKeys: ["a", "b"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: { agentId: "x", input: "alpha", outboundScope: ["repo"] },
          expectedOutcome: "allowed",
        },
        {
          key: "b",
          spec: { agentId: "x", input: "beta" },
          expectedOutcome: "allowed",
        },
      ],
    },
  },
  {
    id: "sd-002-deny-all-denies-batch",
    description: "deny-all policy denies the batch before any per-item check.",
    tags: ["known-good", "denial"],
    input: {
      policy: denyAllSpawnPolicy,
      request: {
        batchId: "b2",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch" },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "denied",
    },
  },
  {
    id: "sd-003-approval-required-then-batch-approved-items-allowed",
    description:
      "a batch-aware policy requiring approval, once approved, allows per-item spawns without re-checking.",
    tags: ["known-good", "approval"],
    input: {
      policy: approvalRequiredPolicy,
      request: {
        batchId: "b3",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch" },
        itemKeys: ["a", "b", "c"],
      },
      expectedBatchOutcome: "needs_approval",
    },
  },
  {
    id: "sd-004-scope-widening-item-denied",
    description:
      "an item that widens outboundScope beyond the approved template is denied.",
    tags: ["known-good", "scope-narrowing"],
    input: {
      policy: allowAllSpawnPolicy,
      request: {
        batchId: "b4",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: {
            agentId: "x",
            input: "alpha",
            outboundScope: ["repo", "network"],
          },
          expectedOutcome: "denied",
          expectedDenialReason: "batch_scope_widened: outboundScope",
        },
      ],
    },
  },
  {
    id: "sd-005-agent-id-mismatch-item-denied",
    description:
      "an item declaring a different agentId than the approved template is denied.",
    tags: ["known-good", "scope-narrowing"],
    input: {
      policy: allowAllSpawnPolicy,
      request: {
        batchId: "b5",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch" },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: { agentId: "y", input: "alpha" },
          expectedOutcome: "denied",
          expectedDenialReason: "batch_scope_widened: agentId",
        },
      ],
    },
  },
  {
    id: "sd-006-memory-scope-widening-denied",
    description:
      "an item that widens memoryScope (workspace -> global) beyond the approved template is denied.",
    tags: ["known-good", "scope-narrowing"],
    input: {
      policy: allowAllSpawnPolicy,
      request: {
        batchId: "b6",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch", memoryScope: "workspace" },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "allowed",
      items: [
        {
          key: "a",
          spec: { agentId: "x", input: "alpha", memoryScope: "global" },
          expectedOutcome: "denied",
          expectedDenialReason: "batch_scope_widened: memoryScope",
        },
      ],
    },
  },
  {
    id: "sd-007-agent-allowlist-denies-untrusted-batch",
    description:
      "an agent-allowlisting policy denies a batch templated for a non-allowlisted agent.",
    tags: ["known-good", "denial"],
    input: {
      policy: agentAllowlistPolicy,
      request: {
        batchId: "b7",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "untrusted-agent", input: "batch" },
        itemKeys: ["a", "b"],
      },
      expectedBatchOutcome: "denied",
    },
  },
];

/**
 * A deliberately WRONG expectation over an otherwise-valid case, used only
 * by the scorer meta-tests to assert `createSpawnDecisionScorer` actually
 * fails on a bad expectation rather than trivially passing everything.
 */
export const SPAWN_DECISION_KNOWN_BAD_CASE: FanoutEvalCase<SpawnDecisionCase> =
  {
    id: "sd-bad-001-wrong-expected-outcome",
    description:
      "deny-all policy, but the case WRONGLY expects the batch to be allowed.",
    tags: ["known-bad"],
    input: {
      policy: denyAllSpawnPolicy,
      request: {
        batchId: "bad1",
        parentRunId: "run-1",
        mode: "template",
        template: { agentId: "x", input: "batch" },
        itemKeys: ["a"],
      },
      expectedBatchOutcome: "allowed",
    },
  };
