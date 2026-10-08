import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  extendPrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import {
  createInMemoryV2InactiveLocalHostStore,
  runV2InactiveLocalHost,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  type V2InactiveLocalHandlerInvocation,
} from "../v2-inactive-local-target.js";
import {
  fiveFeatureSource,
  multiPortAdapter,
} from "./fixtures/v2-pipeline/five-feature-source.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-RT: the opt-in `target: "pipeline"`
 * compiler option. Without it routing is unchanged; with it a loop-free
 * `dzupflow/v2` document lowers to `pipeline` and runs on `PipelineRuntime`,
 * and the five-feature oracle fixture meets the five V2 gates on `pipeline`.
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };

/** The five-feature steps with none of the five V2-only features. */
const loopFreeSource = `
dsl: dzupflow/v2
id: v2-pipeline-loop-free
version: 2.0.0
inputs:
  ready: boolean
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
    save:
      result: state.draft
  - id: done
    use: core.set@1
    with:
      assign:
        finished: true
`;

function compilerOptions(extra: { target?: "pipeline" } = {}) {
  const primitive = multiPortAdapter();
  return {
    primitive,
    options: {
      toolResolver,
      referencePolicy: "strict" as const,
      primitiveRegistry: extendPrimitiveRegistryV2(
        BUILT_IN_PRIMITIVE_REGISTRY_V2,
        [primitive],
      ),
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
      ...extra,
    },
  };
}

async function compile(text: string, extra: { target?: "pipeline" } = {}) {
  return createFlowCompiler(compilerOptions(extra).options).compileDsl(text);
}

describe("compiler option target: \"pipeline\" (S5-RT)", () => {
  it("leaves default routing unchanged", async () => {
    const result = await compile(loopFreeSource);
    if ("errors" in result) throw new Error(JSON.stringify(result.errors));
    expect(result.target).toBe("planning-dag");
    expect(result.requirements.target).toBe("planning-dag");
  });

  it("moves the remaining V2 gates of the five-feature fixture onto pipeline", async () => {
    const result = await compile(fiveFeatureSource(), { target: "pipeline" });
    expect("artifact" in result).toBe(false);
    if (!("errors" in result)) throw new Error("expected target gate errors");
    expect(
      result.errors.map((error) => [error.code, error.nodePath]).sort(),
    ).toEqual(
      [
        ["TYPED_CONDITION_TARGET_UNSUPPORTED", "root.nodes[0].typedCondition"],
        ["TYPED_CONDITION_TARGET_UNSUPPORTED", "root.nodes[1].typedCondition"],
        // S5-R2 lowers top-level `retry:` on pipeline, so no retry gate.
        // S5-C2 lowers top-level `catch:` on pipeline, so no catch gate.
        // S5-S2 lowers top-level multi-port `save:` on pipeline, so no save gate.
        // S5-PC lowers top-level `policy:` on pipeline, so no policy gate.
      ].sort(),
    );
    expect(
      result.errors.filter((error) => error.message.includes('"pipeline"')),
    ).toHaveLength(2);
  });

  it("runs a loop-free V2 document to completion on PipelineRuntime", async () => {
    const result = await compile(loopFreeSource, { target: "pipeline" });
    if ("errors" in result) throw new Error(JSON.stringify(result.errors));
    expect(result.target).toBe("pipeline");
    expect(result.requirements.target).toBe("pipeline");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "TARGET_OPTION",
    ]);
    const definition = result.artifact as PipelineDefinition;
    expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);
    // No authored step is dropped by the forced lowering.
    expect(definition.nodes.map((node) => node.source?.nodeId)).toEqual([
      "seed",
      "draft",
      "done",
    ]);

    const store = new InMemoryPipelineCheckpointStore();
    const executed: string[] = [];
    const run = await new PipelineRuntime({
      definition: { ...definition, checkpointStrategy: "after_each_node" },
      checkpointStore: store,
      nodeExecutor: async (nodeId) => {
        const node = definition.nodes.find(
          (candidate) => candidate.id === nodeId,
        );
        const stepId = node?.source?.nodeId ?? nodeId;
        executed.push(stepId);
        return { nodeId, output: { text: `${stepId}-done` }, durationMs: 0 };
      },
    }).execute({ retained: "before" });

    expect(run.state, run.error).toBe("completed");
    // Only the adapter step reaches the host executor; set runs in the runtime.
    expect(executed).toEqual(["draft"]);
    // Boundary for S5-S: the adapter output does not reach state on
    // PipelineRuntime, unlike the oracle's `save` semantics.
    expect((await store.load(run.runId))?.state).toEqual({
      retained: "before",
      seeded: true,
      finished: true,
    });
  });

  it("cannot be compared with the oracle until the five gates lift", async () => {
    // The local-host oracle only qualifies documents that use all five V2
    // features, so parity is measured on the five-feature fixture as S5-R..T
    // remove each gate above.
    const { primitive, options } = compilerOptions();
    const oracle = await runV2InactiveLocalHost({
      runId: "s5-rt-oracle",
      ownerId: "worker-1",
      source: loopFreeSource,
      compilerOptions: options,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: { inputs: { ready: true } },
      initialState: { retained: "before" },
      handlers: [
        {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
          handlerId: "test.adapter-run-local.v1",
          handlerSha256: `sha256:${"a".repeat(64)}`,
          mode: "provider-free-local",
          declaredEffects: "none",
          replay: "safe",
          invoke: (_invocation: V2InactiveLocalHandlerInvocation) => ({
            status: "success" as const,
            outputs: { result: { text: "unused" } },
            durationMs: 0,
            costCents: 0,
          }),
        },
      ],
      checkpointStore: createInMemoryV2InactiveLocalHostStore(),
    });
    expect(oracle.ok).toBe(false);
    if (oracle.ok) return;
    expect(JSON.stringify(oracle.errors)).toContain(
      "V2_LOCAL_TARGET_COVERAGE_INCOMPLETE",
    );
  });
});
