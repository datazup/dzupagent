import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  extendPrimitiveRegistryV2,
  type DslV2PolicyNarrowingBinding,
} from "@dzupagent/flow-dsl";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import {
  applyPipelinePolicies,
  pipelinePolicyRefusal,
} from "../compile-orchestrator/v2-pipeline-policy.js";
import { createFlowCompiler } from "../index.js";
import {
  simulateV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
} from "../v2-inactive-local-target.js";
import { multiPortAdapter } from "./fixtures/v2-pipeline/five-feature-source.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-PC: a V2 `policy:` lowers onto
 * `PipelineRuntime` (`executionPolicy`) under the opt-in `target: "pipeline"`,
 * and the run outcome matches the local-host simulator (the oracle) for the
 * same reported attempt duration and cost.
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };
const primitive = multiPortAdapter();

const compilerOptions = {
  toolResolver,
  referencePolicy: "strict" as const,
  primitiveRegistry: extendPrimitiveRegistryV2(BUILT_IN_PRIMITIVE_REGISTRY_V2, [
    primitive,
  ]),
  primitiveBindings: {
    "adapter.run": {
      ref: primitive.ref,
      semanticHash: primitive.compatibility.semanticHash,
    },
  },
};

type Policy = {
  readonly requireApproval?: true;
  readonly budgetCents?: number;
  readonly timeoutMs?: number;
};

function policyBlock(policy: Policy): string {
  return (
    "    policy:\n" +
    Object.entries(policy)
      .map(([field, value]) => `      ${field}: ${String(value)}\n`)
      .join("")
  );
}

const SAVE = `    save:
      result: state.draft
      receipt: state.draftReceipt
`;

function policySource(policy: Policy): string {
  return `
dsl: dzupflow/v2
id: v2-pipeline-policy
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        seeded: true
  - id: draft
    use: adapter.run@2
    with:
      provider: codex
      instructions: Draft.
${policyBlock(policy)}${SAVE}  - id: probe
    use: adapter.run@2
    with:
      provider: codex
      instructions: Probe.
    save:
      result: state.probe
`;
}

async function compile(source: string, target?: "pipeline") {
  return createFlowCompiler({
    ...compilerOptions,
    ...(target === undefined ? {} : { target }),
  }).compileDsl(source);
}

async function compilePipeline(source: string): Promise<PipelineDefinition> {
  const result = await compile(source, "pipeline");
  if ("errors" in result) throw new Error(JSON.stringify(result.errors));
  expect(result.target).toBe("pipeline");
  const definition = result.artifact as PipelineDefinition;
  expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);
  return definition;
}

function stepNode(definition: PipelineDefinition, stepId: string) {
  const node = definition.nodes.find(
    (candidate) => candidate.source?.nodeId === stepId,
  );
  if (node === undefined) throw new Error(`no node for step ${stepId}`);
  return node;
}

const OUTPUTS = { result: { text: "hi" }, receipt: { digest: "d1" } };

interface Attempt {
  readonly durationMs: number;
  readonly costCents: number;
}

/**
 * Run with `draft` reporting `attempt`; report the outcome. `core.set` nodes
 * do not reach `nodeExecutor`, so a third step (`probe`) reads the state:
 * `saved: undefined` means the probe never ran or saw no `draft` key.
 */
async function runPipeline(policy: Policy, attempt: Attempt) {
  const definition = await compilePipeline(policySource(policy));
  const draft = stepNode(definition, "draft");
  const probe = stepNode(definition, "probe");
  let draftCalls = 0;
  let saved: unknown;
  const run = await new PipelineRuntime({
    definition,
    checkpointStore: new InMemoryPipelineCheckpointStore(),
    nodeAttemptCostCents: (nodeId) =>
      nodeId === draft.id ? attempt.costCents : 0,
    nodeExecutor: async (nodeId, _node, context) => {
      if (nodeId === probe.id) saved = structuredClone(context.state["draft"]);
      if (nodeId !== draft.id) {
        return { nodeId, output: undefined, durationMs: 0 };
      }
      draftCalls += 1;
      return {
        nodeId,
        output: structuredClone(OUTPUTS),
        durationMs: attempt.durationMs,
      };
    },
  }).execute({});
  return {
    state: run.state,
    code: run.error?.split(":")[0],
    draftCalls,
    saved,
  };
}

/** The oracle's outcome for the same policy and attempt. */
async function oracleRun(policy: Policy, attempt: Attempt) {
  const source = `
dsl: dzupflow/v2
id: inactive-local-policy-oracle
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: run
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
${policyBlock(policy)}    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
${SAVE}`;
  const simulated = await simulateV2InactiveLocalTarget({
    source,
    compilerOptions,
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
    initialState: {},
    attempts: [{ status: "success" as const, outputs: OUTPUTS, ...attempt }],
  });
  if (!simulated.ok) throw new Error(JSON.stringify(simulated.errors));
  return {
    status: simulated.receipt.status,
    code: simulated.receipt.terminal?.code,
    attempts: simulated.receipt.attempts.length,
    effectivePolicy: simulated.receipt.effectivePolicy,
    saved: simulated.receipt.state["draft"],
  };
}

function binding(authoredPath: string): DslV2PolicyNarrowingBinding {
  return {
    authoredPath,
    primitiveRef: primitive.ref,
    primitiveSemanticHash: primitive.compatibility.semanticHash,
    narrowing: { timeoutMs: 10 },
  };
}

describe("V2 policy on target pipeline (S5-PC)", () => {
  it("lowers the authored policy onto executionPolicy, as the oracle's effective policy", async () => {
    const policy = { requireApproval: true, budgetCents: 40, timeoutMs: 500 } as const;
    const definition = await compilePipeline(policySource(policy));
    const oracle = await oracleRun(policy, { durationMs: 1, costCents: 1 });
    expect(oracle.effectivePolicy).toEqual(policy);
    // Approval moves to a gate in front of the step (S5-PO); the step keeps
    // the rest of the oracle's effective policy.
    const draft = stepNode(definition, "draft");
    expect(draft.executionPolicy).toEqual({ budgetCents: 40, timeoutMs: 500 });
    expect(
      definition.nodes.find((node) => node.id === `${draft.id}__approval`),
    ).toMatchObject({ type: "gate", gateType: "approval" });
    // Steps without a policy are untouched.
    expect(stepNode(definition, "seed").executionPolicy).toBeUndefined();
    expect(stepNode(definition, "probe").executionPolicy).toBeUndefined();
  });

  it("keeps policy refused on other targets", async () => {
    const routed = await compile(policySource({ timeoutMs: 500 }));
    if (!("errors" in routed)) throw new Error("expected default policy gate");
    expect(routed.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ["V2_POLICY_TARGET_UNSUPPORTED", "root.steps[1].policy"],
      ["V2_MULTI_SAVE_TARGET_UNSUPPORTED", "root.steps[1].save"],
    ]);
  });

  it("fails closed for nested steps and steps with no single primitive node", () => {
    expect(pipelinePolicyRefusal(binding("root.steps[0]"))).toBeUndefined();
    expect(
      pipelinePolicyRefusal(binding("root.steps[0].with.then[0]")),
    ).toContain("top-level");
    const guarded = {
      nodes: [{ id: "g", source: { path: "root.nodes[0]", nodeType: "if" } }],
    };
    expect(applyPipelinePolicies(guarded, [binding("root.steps[0]")])).toEqual([
      "root.steps[0]",
    ]);
    expect(guarded.nodes[0]).not.toHaveProperty("executionPolicy");
  });

  it("does not execute an approval-required step, as the oracle", async () => {
    const policy = { requireApproval: true } as const;
    const attempt = { durationMs: 1, costCents: 1 };
    const oracle = await oracleRun(policy, attempt);
    expect(oracle).toMatchObject({
      status: "approval-required",
      attempts: 0,
      saved: undefined,
    });
    // Suspended for a decision (S5-PO, v2-pipeline-approval-suspend.test.ts).
    expect(await runPipeline(policy, attempt)).toEqual({
      state: "suspended",
      code: undefined,
      draftCalls: 0,
      saved: undefined,
    });
  });

  it("fails an over-budget step and saves nothing, as the oracle", async () => {
    const policy = { budgetCents: 20 };
    const attempt = { durationMs: 1, costCents: 30 };
    const oracle = await oracleRun(policy, attempt);
    expect(oracle).toMatchObject({
      status: "failed",
      code: "V2_SIMULATION_BUDGET_EXCEEDED",
      saved: undefined,
    });
    expect(await runPipeline(policy, attempt)).toEqual({
      state: "failed",
      code: "PIPELINE_BUDGET_EXCEEDED",
      draftCalls: 1,
      saved: undefined,
    });
  });

  it("fails an over-time step and saves nothing, as the oracle", async () => {
    const policy = { timeoutMs: 50 };
    const attempt = { durationMs: 80, costCents: 0 };
    const oracle = await oracleRun(policy, attempt);
    expect(oracle).toMatchObject({
      status: "failed",
      code: "V2_SIMULATION_TIMEOUT_EXCEEDED",
      saved: undefined,
    });
    expect(await runPipeline(policy, attempt)).toEqual({
      state: "failed",
      code: "PIPELINE_TIMEOUT_EXCEEDED",
      draftCalls: 1,
      saved: undefined,
    });
  });

  it("completes a step within both limits and saves, as the oracle", async () => {
    const policy = { budgetCents: 20, timeoutMs: 50 };
    const attempt = { durationMs: 40, costCents: 20 };
    const oracle = await oracleRun(policy, attempt);
    expect(oracle).toMatchObject({
      status: "completed",
      saved: OUTPUTS.result,
    });
    expect(await runPipeline(policy, attempt)).toEqual({
      state: "completed",
      code: undefined,
      draftCalls: 1,
      saved: OUTPUTS.result,
    });
  });
});
