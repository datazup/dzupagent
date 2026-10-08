import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type PipelineRuntimeEvent,
} from "@dzupagent/agent/pipeline";
import {
  PipelineDefinitionSchema,
  type LoopNode,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  createFlowCompiler,
  createTypedLoopPredicates,
} from "../index.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-L2: a V2 `core.loop@1` with a typed
 * condition (S5-L1) compiles under `target: "pipeline"` to a real `LoopNode`
 * and runs on `PipelineRuntime` with real iteration semantics. The predicate
 * binds runtime state under `state`, the root V2 conditions reference and the
 * local-host oracle binds (`host-kernel.ts` `runtimeBindings`).
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };
const CAPABILITIES = [FLOW_TYPED_CONDITION_CAPABILITY];

/** `withLines` are the loop's `with:` entries besides `body`, six-space indented. */
function source(withLines: string, after = ""): string {
  return `
dsl: dzupflow/v2
id: typed-loop
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        again: true
  - id: rounds
    use: core.loop@1
    with:
${withLines}
      body:
        - id: tick
          use: core.set@1
          with:
            assign:
              again: false
${after}`;
}

const afterStep = `  - id: after
    use: core.set@1
    with:
      assign:
        finished: true
`;

/** A body that never releases the condition. */
function stuckSource(withLines: string, after = ""): string {
  return source(withLines, after).replace("again: false", "again: true");
}

const untilFalse = `      condition:
        eq:
          - ref: state.again
          - true`;

async function compile(
  text: string,
  options: { target?: "pipeline"; capabilities?: string[] } = {},
) {
  return createFlowCompiler({
    toolResolver,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.capabilities === undefined
      ? {}
      : { targetCapabilities: options.capabilities }),
  }).compileDsl(text);
}

async function compilePipeline(text: string): Promise<PipelineDefinition> {
  const result = await compile(text, {
    target: "pipeline",
    capabilities: CAPABILITIES,
  });
  if ("errors" in result) throw new Error(JSON.stringify(result.errors));
  expect(result.target).toBe("pipeline");
  const definition = result.artifact as PipelineDefinition;
  expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);
  return definition;
}

/** Compile the fixture whose loop carries `withLines`. */
async function compileLoop(withLines: string): Promise<PipelineDefinition> {
  return compilePipeline(source(withLines));
}

function loopNode(definition: PipelineDefinition): LoopNode {
  const node = definition.nodes.find((candidate) => candidate.type === "loop");
  if (node === undefined) throw new Error("expected a lowered LoopNode");
  return node as LoopNode;
}

async function run(
  definition: PipelineDefinition,
  hostCapabilities: readonly string[] = CAPABILITIES,
) {
  const iterations: number[] = [];
  const started: string[] = [];
  const result = await new PipelineRuntime({
    definition,
    checkpointStore: new InMemoryPipelineCheckpointStore(),
    predicates: createTypedLoopPredicates(definition.nodes, {
      hostCapabilities,
      stateRoot: "state",
    }),
    onEvent: (event: PipelineRuntimeEvent) => {
      if (event.type === "pipeline:loop_iteration") {
        iterations.push(event.iteration);
      }
      if (event.type === "pipeline:node_started") started.push(event.nodeId);
    },
    nodeExecutor: async (nodeId) => ({ nodeId, output: undefined, durationMs: 0 }),
  }).execute({});
  return { result, iterations, started };
}

function nodeIdFor(definition: PipelineDefinition, stepId: string): string {
  const node = definition.nodes.find(
    (candidate) => candidate.source?.nodeId === stepId,
  );
  if (node === undefined) throw new Error(`no node for step ${stepId}`);
  return node.id;
}

describe("V2 typed core.loop@1 on target pipeline (S5-L2)", () => {
  it("lowers to a real LoopNode carrying the typed condition", async () => {
    const definition = await compileLoop(`${untilFalse}
      maxIterations: 3`);
    const loop = loopNode(definition);
    expect(loop.continuePredicateName).toBe("loopTyped__rounds__predicate");
    expect(loop.maxIterations).toBe(3);
    expect(loop.typedWhile).toMatchObject({
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: {
        op: "eq",
        left: { op: "ref", path: "state.again" },
        right: { op: "literal", value: true },
      },
      onExhausted: "fail",
    });
  });

  it("stops once the body's state write releases the condition", async () => {
    const { result, iterations } = await run(
      await compileLoop(`${untilFalse}
      maxIterations: 3`),
    );
    expect(result.state, result.error).toBe("completed");
    expect(iterations).toEqual([1]);
  });

  it("defaults the bound to 100 iterations", async () => {
    expect(loopNode(await compileLoop(untilFalse)).maxIterations).toBe(100);
  });

  it("fails the run on exhaustion by default", async () => {
    const definition = await compilePipeline(
      stuckSource(`${untilFalse}
      maxIterations: 2`, afterStep),
    );
    const { result, iterations, started } = await run(definition);
    expect(result.state).toBe("failed");
    expect(iterations).toEqual([1, 2]);
    expect(result.error).toContain(
      `Loop "${loopNode(definition).id}" reached maxIterations (2)`,
    );
    expect(started).not.toContain(nodeIdFor(definition, "after"));
  });

  it("continues past exhaustion with onExhausted: continue", async () => {
    const definition = await compilePipeline(
      stuckSource(`${untilFalse}
      maxIterations: 2
      onExhausted: continue`, afterStep),
    );
    const { result, iterations, started } = await run(definition);
    expect(result.state, result.error).toBe("completed");
    expect(iterations).toEqual([1, 2]);
    expect(started).toContain(nodeIdFor(definition, "after"));
  });

  it("fails closed at run time when the host withholds the evaluator", async () => {
    const { result, iterations } = await run(
      await compileLoop(`${untilFalse}
      maxIterations: 3`),
      [],
    );
    expect(result.state).toBe("failed");
    expect(iterations).toEqual([1]);
    expect(result.error).toContain("TYPED_CONDITION_CAPABILITY_REQUIRED");
  });

  it("refuses an undeclared state reference at compile time", async () => {
    const result = await compile(
      source(`      condition:
        eq:
          - ref: state.missing
          - true`),
      { target: "pipeline", capabilities: CAPABILITIES },
    );
    if (!("errors" in result)) throw new Error("expected a refusal");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        stage: 3,
        code: "INVALID_CONDITION",
        nodePath: "root.nodes[1].typedCondition.expression.left.path",
      }),
    );
  });

  it("refuses the typed loop when the host does not advertise the evaluator", async () => {
    for (const options of [{ target: "pipeline" as const }, {}]) {
      const result = await compile(source(untilFalse), options);
      if (!("errors" in result)) throw new Error("expected a refusal");
      expect(result.errors.map((error) => error.code)).toContain(
        "TYPED_CONDITION_TARGET_UNSUPPORTED",
      );
    }
  });
});
