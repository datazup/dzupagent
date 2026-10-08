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
 * DZA-DSL-V2-EXECUTOR-S5-20261008 slice P1: characterisation of today's
 * `dzupflow/v2` boundary on `PipelineRuntime`. Later S5 slices flip exactly
 * one gate code each and must match the oracle receipt pinned below.
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };

const FIVE_GATE_CODES = [
  "TYPED_CONDITION_TARGET_UNSUPPORTED",
  "V2_POLICY_TARGET_UNSUPPORTED",
  "V2_RETRY_TARGET_UNSUPPORTED",
  "V2_CATCH_TARGET_UNSUPPORTED",
  "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
] as const;

const plainSource = `
dsl: dzupflow/v2
id: v2-pipeline-plain
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        again: false
  - id: rounds
    use: core.loop@1
    with:
      condition: state.again
      maxIterations: 3
      body:
        - id: tick
          use: core.set@1
          with:
            assign:
              ticked: true
  - id: done
    use: core.set@1
    with:
      assign:
        finished: true
`;

/** The five-feature steps nested in a `core.loop@1`, so routing selects `pipeline`. */
function loopWrappedFiveFeatureSource(): string {
  const [header, steps] = fiveFeatureSource().split("steps:\n");
  const body = steps!
    .split("\n")
    .map((line) => (line.length === 0 ? line : `      ${line}`))
    .join("\n");
  return `${header}steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        again: false
  - id: rounds
    use: core.loop@1
    with:
      condition: state.again
      maxIterations: 1
      body:
${body}`;
}

function fiveFeatureCompilerOptions() {
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
    },
  };
}

async function gateErrors(text: string) {
  const result = await createFlowCompiler(
    fiveFeatureCompilerOptions().options,
  ).compileDsl(text);
  expect("artifact" in result).toBe(false);
  if (!("errors" in result)) throw new Error("expected target gate errors");
  return result.errors;
}

describe("dzupflow/v2 on PipelineRuntime: S5-P1 baseline", () => {
  it("compiles a plain V2 document to pipeline and runs it to completion", async () => {
    const result = await createFlowCompiler({
      toolResolver,
      referencePolicy: "strict",
    }).compileDsl(plainSource);
    if ("errors" in result) throw new Error(JSON.stringify(result.errors));
    expect(result.target).toBe("pipeline");
    const definition = result.artifact as PipelineDefinition;
    expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);

    // Boundary: core.loop@1 lowers its body inline (no loop node) and the
    // authored condition is runtime-owned, flagged as partial support.
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "PARTIAL_NODE_SUPPORT",
    ]);
    expect(definition.nodes.map((node) => [node.type, node.source?.nodeId])).toEqual([
      ["tool", "seed"],
      ["tool", "tick"],
      ["tool", "done"],
    ]);
    // Boundary: the compiler sets no checkpoint strategy; the host chooses one.
    expect(definition.checkpointStrategy).toBeUndefined();

    const store = new InMemoryPipelineCheckpointStore();
    const executed: string[] = [];
    const run = await new PipelineRuntime({
      definition: { ...definition, checkpointStrategy: "after_each_node" },
      checkpointStore: store,
      nodeExecutor: async (nodeId) => {
        executed.push(nodeId);
        return { nodeId, output: null, durationMs: 0 };
      },
    }).execute({ ready: true });

    expect(run.state, run.error).toBe("completed");
    // dzup.runtime.set runs inside the runtime; the stub executor is never used.
    expect(executed).toEqual([]);
    expect((await store.load(run.runId))?.state).toEqual({
      ready: true,
      again: false,
      ticked: true,
      finished: true,
    });
  });

  it("refuses the five-feature fixture with exactly the five V2 gate codes", async () => {
    const errors = await gateErrors(fiveFeatureSource());
    expect(
      errors.map((error) => [error.code, error.nodePath]).sort(),
    ).toEqual(
      [
        ["TYPED_CONDITION_TARGET_UNSUPPORTED", "root.nodes[0].typedCondition"],
        ["TYPED_CONDITION_TARGET_UNSUPPORTED", "root.nodes[1].typedCondition"],
        ["V2_POLICY_TARGET_UNSUPPORTED", "root.steps[0].policy"],
        ["V2_POLICY_TARGET_UNSUPPORTED", "root.steps[1].policy"],
        ["V2_RETRY_TARGET_UNSUPPORTED", "root.steps[0].retry"],
        ["V2_RETRY_TARGET_UNSUPPORTED", "root.steps[1].retry"],
        ["V2_CATCH_TARGET_UNSUPPORTED", "root.steps[0].catch"],
        ["V2_CATCH_TARGET_UNSUPPORTED", "root.steps[1].catch"],
        ["V2_MULTI_SAVE_TARGET_UNSUPPORTED", "root.steps[0].save"],
        ["V2_MULTI_SAVE_TARGET_UNSUPPORTED", "root.steps[1].save"],
      ].sort(),
    );
    // Boundary: with only adapter.run leaves the router picks planning-dag, so
    // S5 must also decide how a loop-free V2 document reaches pipeline.
    expect(
      errors.filter((error) => error.message.includes('"planning-dag"')),
    ).toHaveLength(10);
  });

  it("refuses the same steps on the pipeline target with the same five codes", async () => {
    const errors = await gateErrors(loopWrappedFiveFeatureSource());
    expect(new Set(errors.map((error) => error.code))).toEqual(
      new Set(FIVE_GATE_CODES),
    );
    expect(errors).toHaveLength(10);
    expect(
      errors.filter((error) => error.message.includes('"pipeline"')),
    ).toHaveLength(10);
  });

  it("records the local-host oracle receipt for the five-feature fixture", async () => {
    const { primitive, options } = fiveFeatureCompilerOptions();
    const observed: string[] = [];
    const result = await runV2InactiveLocalHost({
      runId: "s5-p1-oracle",
      ownerId: "worker-1",
      source: fiveFeatureSource(),
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
          invoke: (invocation: V2InactiveLocalHandlerInvocation) => {
            observed.push(invocation.stepId);
            return {
              status: "success" as const,
              outputs: {
                result: { text: `${invocation.stepId}-done` },
                receipt: { digest: `${invocation.stepId}-digest` },
              },
              durationMs: 10,
              costCents: 1,
            };
          },
        },
      ],
      checkpointStore: createInMemoryV2InactiveLocalHostStore(),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    // Parity target for S5-R..S5-T on PipelineRuntime.
    expect(observed).toEqual(["draft", "review"]);
    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.state).toEqual({
      retained: "before",
      draft: { text: "draft-done" },
      draftReceipt: { digest: "draft-digest" },
      review: { text: "review-done" },
      reviewReceipt: { digest: "review-digest" },
    });
    expect(
      result.receipt.steps.map((step) => [step.id, step.status, step.attempts.length]),
    ).toEqual([
      ["draft", "completed", 1],
      ["review", "completed", 1],
    ]);
  });
});
