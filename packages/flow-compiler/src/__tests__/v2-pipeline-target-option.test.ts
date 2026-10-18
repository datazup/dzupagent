import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRuntimeToolNodeExecutor,
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type NodeExecutionContext,
  type NodeExecutor,
  type RuntimeToolHandlers,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  extendPrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it, vi } from "vitest";

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
    // DSL-WP08: with a bare executor the runtime writes the adapter leaf's
    // output to its `output` state key, matching the oracle's `save`.
    expect((await store.load(run.runId))?.state).toEqual({
      retained: "before",
      seeded: true,
      draft: { text: "draft-done" },
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

/**
 * DSL-WP08: on the bare-executor path (no `runtimeToolHandlers`)
 * `PipelineRuntime` writes a successful runtime-leaf output to the leaf's
 * state key, as the handler path does, before node `stateWrites` apply.
 */

interface ToolSpec {
  id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  stateWrites?: Record<string, unknown>;
}

function toolChain(nodes: readonly ToolSpec[]): PipelineDefinition {
  return {
    id: "runtime-leaf-output-state",
    name: "Runtime leaf output state",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: nodes[0]!.id,
    checkpointStrategy: "after_each_node",
    nodes: nodes.map((node) => ({ type: "tool", ...node })),
    edges: nodes.slice(1).map((node, index) => ({
      type: "sequential",
      sourceNodeId: nodes[index]!.id,
      targetNodeId: node.id,
    })),
  } as unknown as PipelineDefinition;
}

async function runChain(
  nodes: readonly ToolSpec[],
  options: {
    nodeExecutor?: NodeExecutor;
    runtimeToolHandlers?: RuntimeToolHandlers;
  } = {},
) {
  const store = new InMemoryPipelineCheckpointStore();
  const executed: string[] = [];
  const nodeExecutor: NodeExecutor =
    options.nodeExecutor ??
    (async (nodeId) => {
      executed.push(nodeId);
      return { nodeId, output: { from: nodeId }, durationMs: 0 };
    });
  const run = await new PipelineRuntime({
    definition: toolChain(nodes),
    checkpointStore: store,
    nodeExecutor,
    ...(options.runtimeToolHandlers === undefined
      ? {}
      : { runtimeToolHandlers: options.runtimeToolHandlers }),
  }).execute({ retained: "before" });
  const state = (await store.load(run.runId))?.state;
  return { run, state, executed };
}

function executionContext(): NodeExecutionContext {
  return { state: {}, previousResults: new Map() };
}

type ExecutorNode = Parameters<NodeExecutor>[1];

describe("PipelineRuntime runtime-leaf output state (DSL-WP08)", () => {
  it("writes each runtime leaf's output to its output or outputKey", async () => {
    const outputKeyed = [
      ["run", "dzup.runtime.adapter.run"],
      ["race", "dzup.runtime.adapter.race"],
      ["parallel", "dzup.runtime.adapter.parallel"],
      ["supervisor", "dzup.runtime.adapter.supervisor"],
      ["shell", "dzup.runtime.shell.run"],
      ["schema", "dzup.runtime.validate.schema"],
      ["evidence", "dzup.runtime.evidence.write"],
    ] as const;
    const nodes: ToolSpec[] = [
      ...outputKeyed.map(([id, toolName]) => ({
        id,
        toolName,
        arguments: { output: `${id}Out` },
      })),
      {
        id: "worker",
        toolName: "dzup.runtime.worker.dispatch",
        arguments: { outputKey: "workerOut" },
      },
      {
        id: "prompt",
        toolName: "dzup.runtime.prompt",
        arguments: { outputKey: "promptOut" },
      },
      { id: "promptDefault", toolName: "dzup.runtime.prompt", arguments: {} },
    ];

    const { run, state, executed } = await runChain(nodes);

    expect(run.state, run.error).toBe("completed");
    expect(executed).toEqual(nodes.map((node) => node.id));
    expect(state).toEqual({
      retained: "before",
      runOut: { from: "run" },
      raceOut: { from: "race" },
      parallelOut: { from: "parallel" },
      supervisorOut: { from: "supervisor" },
      shellOut: { from: "shell" },
      schemaOut: { from: "schema" },
      evidenceOut: { from: "evidence" },
      workerOut: { from: "worker" },
      promptOut: { from: "prompt" },
      promptDefault: { from: "promptDefault" },
    });
  });

  it("adds no state key for an invalid key, validate or a non-runtime tool", async () => {
    const nodes: ToolSpec[] = [
      { id: "runMissing", toolName: "dzup.runtime.adapter.run", arguments: {} },
      {
        id: "runEmpty",
        toolName: "dzup.runtime.adapter.run",
        arguments: { output: "" },
      },
      {
        id: "runNumber",
        toolName: "dzup.runtime.adapter.run",
        arguments: { output: 7 },
      },
      { id: "shellMissing", toolName: "dzup.runtime.shell.run" },
      {
        id: "shellEmpty",
        toolName: "dzup.runtime.shell.run",
        arguments: { output: "" },
      },
      {
        id: "schemaObject",
        toolName: "dzup.runtime.validate.schema",
        arguments: { output: { key: "draft" } },
      },
      {
        id: "evidenceNull",
        toolName: "dzup.runtime.evidence.write",
        arguments: { output: null },
      },
      {
        id: "evidenceEmpty",
        toolName: "dzup.runtime.evidence.write",
        arguments: { output: "" },
      },
      {
        id: "workerMissing",
        toolName: "dzup.runtime.worker.dispatch",
        arguments: { output: "draft" },
      },
      {
        id: "workerEmpty",
        toolName: "dzup.runtime.worker.dispatch",
        arguments: { outputKey: "" },
      },
      {
        id: "workerArray",
        toolName: "dzup.runtime.worker.dispatch",
        arguments: { outputKey: ["draft"] },
      },
      {
        id: "validate",
        toolName: "dzup.runtime.validate",
        arguments: { output: "draft" },
      },
      { id: "plain", toolName: "search", arguments: { output: "draft" } },
    ];

    const { run, state, executed } = await runChain(nodes);

    expect(run.state, run.error).toBe("completed");
    expect(executed).toEqual(nodes.map((node) => node.id));
    expect(state).toEqual({ retained: "before" });
    expect(state).not.toHaveProperty("draft");
  });

  it("does not write a failed fallback result", async () => {
    const failed = {
      nodeId: "draft",
      output: { partial: true },
      durationMs: 0,
      error: "adapter failed",
    };
    const fallback = vi.fn<NodeExecutor>(async () => failed);
    const executor = createRuntimeToolNodeExecutor(fallback, undefined);
    const context = executionContext();

    const result = await executor(
      "draft",
      {
        id: "draft",
        type: "tool",
        toolName: "dzup.runtime.adapter.run",
        arguments: { output: "draft" },
      } as ExecutorNode,
      context,
    );

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(context.state).not.toHaveProperty("draft");
    expect(result).toEqual(failed);
  });

  it("keeps dzup.runtime.set in the runtime, off the fallback executor", async () => {
    const setNode: ToolSpec = {
      id: "seed",
      toolName: "dzup.runtime.set",
      arguments: { assign: { flag: true } },
    };

    const fallback = vi.fn<NodeExecutor>();
    const context = executionContext();
    await createRuntimeToolNodeExecutor(fallback, undefined)(
      "seed",
      { type: "tool", ...setNode } as ExecutorNode,
      context,
    );
    expect(context.state["flag"]).toBe(true);
    expect(fallback).not.toHaveBeenCalled();

    const bare = vi.fn<NodeExecutor>();
    const { run, state } = await runChain([setNode], { nodeExecutor: bare });
    expect(run.state, run.error).toBe("completed");
    expect(state?.["flag"]).toBe(true);
    expect(bare).not.toHaveBeenCalled();
  });

  it("lets stateWrites win over the runtime-leaf write on the same key", async () => {
    const { run, state } = await runChain(
      [
        {
          id: "draft",
          toolName: "dzup.runtime.adapter.run",
          arguments: { output: "draft" },
          stateWrites: {
            bindings: [{ port: "draft", key: "draft", cardinality: "one" }],
          },
        },
      ],
      {
        nodeExecutor: async (nodeId) => ({
          nodeId,
          output: { draft: "from-port" },
          durationMs: 0,
        }),
      },
    );

    expect(run.state, run.error).toBe("completed");
    expect(state?.["draft"]).toBe("from-port");
  });

  it("leaves the runtimeToolHandlers path unchanged", async () => {
    const nodeExecutor = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      output: "from-executor",
      durationMs: 0,
    }));
    const runtimeToolHandlers: RuntimeToolHandlers = {
      "dzup.runtime.adapter.run": async ({ context }) => {
        context.state["draft"] = "from-handler";
        return { text: "handler-output" };
      },
    };

    const { run, state } = await runChain(
      [
        {
          id: "draft",
          toolName: "dzup.runtime.adapter.run",
          arguments: { output: "draft" },
        },
      ],
      { nodeExecutor, runtimeToolHandlers },
    );

    expect(run.state, run.error).toBe("completed");
    expect(state?.["draft"]).toBe("from-handler");
    expect(nodeExecutor).not.toHaveBeenCalled();
  });

  it("removes the README boundary note about adapter.run state", () => {
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../README.md"),
      "utf8",
    );
    expect(readme).not.toContain(
      "does not yet write an `adapter.run` output into state",
    );
  });
});
