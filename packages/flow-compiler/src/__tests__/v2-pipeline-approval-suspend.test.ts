import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  extendPrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import { createPipelineInteractionResumeV1 } from "@dzupagent/runtime-contracts";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import {
  simulateV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
} from "../v2-inactive-local-target.js";
import { multiPortAdapter } from "./fixtures/v2-pipeline/five-feature-source.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-PO (S5-P option C): on the opt-in
 * `target: "pipeline"`, a V2 `policy.requireApproval` suspends the run at an
 * approval gate in front of the step. A recorded `approved` decision runs the
 * step; `rejected` fails the run without running it. Before the decision the
 * run matches the local-host oracle: nothing executed, nothing saved.
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

const OUTPUTS = { result: { text: "hi" }, receipt: { digest: "d1" } };

function source(extraPolicy = ""): string {
  return `
dsl: dzupflow/v2
id: v2-pipeline-approval
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
    policy:
      requireApproval: true
${extraPolicy}    save:
      result: state.draft
      receipt: state.draftReceipt
  - id: probe
    use: adapter.run@2
    with:
      provider: codex
      instructions: Probe.
    save:
      result: state.probe
`;
}

async function compilePipeline(text: string) {
  const result = await createFlowCompiler({
    ...compilerOptions,
    target: "pipeline",
  }).compileDsl(text);
  if ("errors" in result) throw new Error(JSON.stringify(result.errors));
  const definition = result.artifact as PipelineDefinition;
  const parsed = PipelineDefinitionSchema.safeParse(definition);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  return { definition, suspensionSites: result.ports?.suspensionSites ?? [] };
}

function stepNode(definition: PipelineDefinition, stepId: string) {
  const node = definition.nodes.find(
    (candidate) => candidate.source?.nodeId === stepId,
  );
  if (node === undefined) throw new Error(`no node for step ${stepId}`);
  return node;
}

/** A runtime over `definition` that records which steps ran and what `probe` saw. */
function harness(definition: PipelineDefinition, draftCostCents = 0) {
  const draft = stepNode(definition, "draft");
  const probe = stepNode(definition, "probe");
  const store = new InMemoryPipelineCheckpointStore();
  const calls: string[] = [];
  const seen: { saved?: unknown } = {};
  const runtime = new PipelineRuntime({
    definition,
    checkpointStore: store,
    nodeAttemptCostCents: (nodeId) => (nodeId === draft.id ? draftCostCents : 0),
    nodeExecutor: async (nodeId, _node, context) => {
      calls.push(nodeId);
      if (nodeId === probe.id) seen.saved = structuredClone(context.state["draft"]);
      return {
        nodeId,
        output: nodeId === draft.id ? structuredClone(OUTPUTS) : undefined,
        durationMs: 1,
      };
    },
  });
  return { runtime, store, calls, seen, draft, probe };
}

async function suspendThenDecide(
  definition: PipelineDefinition,
  decision: "approved" | "rejected",
  draftCostCents = 0,
) {
  const h = harness(definition, draftCostCents);
  const first = await h.runtime.execute({});
  expect(first.state).toBe("suspended");
  expect(h.calls).not.toContain(h.draft.id);
  const checkpoint = await h.store.load(first.runId);
  const pending = checkpoint?.pendingInteraction;
  if (checkpoint === undefined || pending === undefined) {
    throw new Error("expected a pending interaction");
  }
  const receipt = createPipelineInteractionResumeV1({
    ...pending,
    receiptId: `po-${decision}`,
    submittedAt: new Date(Date.parse(pending.expiresAt) - 1).toISOString(),
    response: { kind: "approval", decision },
  });
  const resumed = await h.runtime.resumeInteraction(checkpoint, receipt);
  return { ...h, resumed };
}

describe("V2 policy.requireApproval suspends on target pipeline (S5-PO)", () => {
  it("lowers to an approval gate in front of the step", async () => {
    const { definition, suspensionSites } = await compilePipeline(source());
    const draft = stepNode(definition, "draft");
    const gate = definition.nodes.find((node) => node.id === `${draft.id}__approval`);
    const rejected = definition.nodes.find(
      (node) => node.id === `${draft.id}__approval_rejected`,
    );
    expect(definition.schemaVersion).toBe("1.1.0");
    expect(gate).toMatchObject({ type: "gate", gateType: "approval" });
    expect(gate?.type === "gate" ? gate.interaction?.outcomeToSuccessor : undefined).toEqual({
      approved: draft.id,
      rejected: rejected?.id,
    });
    expect(rejected?.executionPolicy).toEqual({ requireApproval: true });
    // The step itself no longer fails closed; approval moved to the gate.
    expect(draft.executionPolicy).toBeUndefined();
    // Nothing reaches the step except through the gate.
    for (const edge of definition.edges) {
      if (edge.sourceNodeId === gate?.id) continue;
      const targets = edge.type === "conditional" ? Object.values(edge.branches) : [edge.targetNodeId];
      expect(targets).not.toContain(draft.id);
    }
    expect(suspensionSites).toContain(gate?.id);
  });

  it("suspends before the step and saves nothing, as the oracle", async () => {
    // The simulator runs one guarded step; same shape as the S5-PC oracle.
    const oracle = await simulateV2InactiveLocalTarget({
      source: `
dsl: dzupflow/v2
id: inactive-local-approval-oracle
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
    policy:
      requireApproval: true
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
    save:
      result: state.draft
      receipt: state.draftReceipt
`,
      compilerOptions,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: { inputs: { ready: true } },
      initialState: {},
      attempts: [{ status: "success" as const, outputs: OUTPUTS, durationMs: 1, costCents: 0 }],
    });
    if (!oracle.ok) throw new Error(JSON.stringify(oracle.errors));
    expect(oracle.receipt.status).toBe("approval-required");
    expect(oracle.receipt.attempts).toHaveLength(0);
    expect(oracle.receipt.state["draft"]).toBeUndefined();

    const { definition } = await compilePipeline(source());
    const h = harness(definition);
    const run = await h.runtime.execute({});
    expect(run.state).toBe("suspended");
    expect(run.pendingInteraction).toMatchObject({
      kind: "approval",
      nodeId: `${h.draft.id}__approval`,
    });
    expect(h.calls).toEqual([]);
    const checkpoint = await h.store.load(run.runId);
    expect(checkpoint?.state["draft"]).toBeUndefined();
  });

  it("runs the step and saves once the approval is recorded", async () => {
    const { definition } = await compilePipeline(source());
    const { resumed, calls, seen, draft, probe } = await suspendThenDecide(
      definition,
      "approved",
    );
    expect(resumed.state).toBe("completed");
    expect(calls).toEqual([draft.id, probe.id]);
    expect(seen.saved).toEqual(OUTPUTS.result);
  });

  it("still enforces the step budget after approval", async () => {
    const { definition } = await compilePipeline(source("      budgetCents: 20\n"));
    expect(stepNode(definition, "draft").executionPolicy).toEqual({ budgetCents: 20 });
    const { resumed, calls, probe } = await suspendThenDecide(definition, "approved", 30);
    expect(resumed.state).toBe("failed");
    expect(resumed.error?.split(":")[0]).toBe("PIPELINE_BUDGET_EXCEEDED");
    expect(calls).not.toContain(probe.id);
  });

  it("fails the run without running the step when rejected", async () => {
    const { definition } = await compilePipeline(source());
    const { resumed, calls, seen, draft } = await suspendThenDecide(
      definition,
      "rejected",
    );
    expect(resumed.state).toBe("failed");
    expect(resumed.error).toMatch(
      new RegExp(`^PIPELINE_APPROVAL_REQUIRED: node "${draft.id}__approval_rejected"`),
    );
    expect(calls).toEqual([]);
    expect(seen.saved).toBeUndefined();
  });
});
