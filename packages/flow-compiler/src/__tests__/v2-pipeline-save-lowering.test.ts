import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type DslV2MultiPortSaveBinding,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import {
  applyPipelineSaves,
  pipelineSaveRefusal,
} from "../compile-orchestrator/v2-pipeline-save.js";
import { createFlowCompiler } from "../index.js";
import {
  simulateV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
} from "../v2-inactive-local-target.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-S2: a V2 multi-port `save:` lowers onto
 * `PipelineRuntime` (`stateWrites`) under the opt-in `target: "pipeline"`, and
 * the saved state keys match the local-host oracle (`host-step.ts`) for the
 * same handler outputs.
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };

/** `adapter.run@2` with `result`, `receipt` (one) and `notes` (optional). */
function saveAdapter(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://adapter.run@2",
    version: "2",
    owner: "test.external",
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: {
          type: "object",
          properties: { digest: { type: "string", minLength: 1 } },
          required: ["digest"],
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
      notes: {
        schema: { type: "string" },
        cardinality: "optional",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
}

const primitive = saveAdapter();

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

const SAVE = `    save:
      result: state.draft
      receipt: state.draftReceipt
      notes: state.draftNotes
`;

const CATCH = `    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
`;

function saveSource(withCatch = false): string {
  return `
dsl: dzupflow/v2
id: v2-pipeline-save
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
${withCatch ? CATCH : ""}${SAVE}  - id: probe
    use: adapter.run@2
    with:
      provider: codex
      instructions: Probe.
    save:
      result: state.probe
`;
}

const SAVED_KEYS = ["draft", "draftReceipt", "draftNotes"] as const;

function savedKeys(state: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    SAVED_KEYS.filter((key) => key in state).map((key) => [key, state[key]]),
  );
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

type DraftResult =
  | { readonly outputs: Record<string, unknown> }
  | { readonly code: string };

/** Run with `draft` returning `result`; report the state `probe` sees. */
async function runPipeline(definition: PipelineDefinition, result: DraftResult) {
  const draft = stepNode(definition, "draft");
  const probe = stepNode(definition, "probe");
  let seenByProbe: Record<string, unknown> | undefined;
  const run = await new PipelineRuntime({
    definition,
    checkpointStore: new InMemoryPipelineCheckpointStore(),
    nodeExecutor: async (nodeId, _node, context) => {
      if (nodeId === probe.id) seenByProbe = structuredClone(context.state);
      if (nodeId !== draft.id) {
        return { nodeId, output: undefined, durationMs: 0 };
      }
      return "code" in result
        ? {
            nodeId,
            output: undefined,
            durationMs: 0,
            error: `adapter failed: ${result.code}`,
            errorMetadata: { code: result.code },
          }
        : { nodeId, output: structuredClone(result.outputs), durationMs: 0 };
    },
  }).execute({});
  return {
    state: run.state,
    error: run.error,
    saved: seenByProbe === undefined ? undefined : savedKeys(seenByProbe),
  };
}

/**
 * The oracle's final saved keys for the same outputs. The local host admits
 * only its five-feature shape, so the save runs there on one guarded step.
 */
async function oracleRun(result: DraftResult) {
  const source = `
dsl: dzupflow/v2
id: inactive-local-save-oracle
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
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
${CATCH}${SAVE}`;
  const simulated = await simulateV2InactiveLocalTarget({
    source,
    compilerOptions,
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
    initialState: {},
    attempts: [
      "code" in result
        ? { status: "error" as const, code: result.code, durationMs: 1, costCents: 0 }
        : { status: "success" as const, outputs: result.outputs, durationMs: 1, costCents: 0 },
    ],
  });
  return simulated.ok
    ? {
        ok: true as const,
        status: simulated.receipt.status,
        saved: savedKeys(simulated.receipt.state),
      }
    : { ok: false as const, codes: simulated.errors.map((error) => error.code) };
}

function binding(
  authoredPath: string,
  classification: "internal" | "secret" = "internal",
): DslV2MultiPortSaveBinding {
  const port = (name: string, key: string) => ({
    port: name,
    target: `state.${key}` as const,
    source: {
      schema: {},
      cardinality: "one" as const,
      classification,
      persistence: "state" as const,
    },
    destination: { kind: "state" as const, key, requiredSchema: {} },
    availability: {
      producedOn: "primitive-success" as const,
      guarded: false,
      unavailableOnTerminalCatchContinue: false,
    },
  });
  return {
    authoredPath,
    primitiveRef: primitive.ref,
    primitiveSemanticHash: primitive.compatibility.semanticHash,
    save: { bindings: [port("result", "a"), port("receipt", "b")] },
  };
}

describe("V2 multi-port save on target pipeline (S5-S2)", () => {
  it("lowers every binding onto stateWrites", async () => {
    const definition = await compilePipeline(saveSource());
    // flow-dsl orders bindings by port name.
    expect(stepNode(definition, "draft").stateWrites).toEqual({
      bindings: [
        { port: "notes", key: "draftNotes", cardinality: "optional" },
        { port: "receipt", key: "draftReceipt", cardinality: "one" },
        { port: "result", key: "draft", cardinality: "one" },
      ],
    });
    // Steps without a multi-port save are untouched.
    expect(stepNode(definition, "seed").stateWrites).toBeUndefined();
    expect(stepNode(definition, "probe").stateWrites).toBeUndefined();
  });

  it("keeps multi-port save refused on other targets", async () => {
    const routed = await compile(saveSource());
    if (!("errors" in routed)) throw new Error("expected default save gate");
    expect(routed.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ["V2_MULTI_SAVE_TARGET_UNSUPPORTED", "root.steps[1].save"],
    ]);
  });

  it("fails closed for nested steps, secret ports and steps with no single primitive node", () => {
    expect(pipelineSaveRefusal(binding("root.steps[0]"))).toBeUndefined();
    expect(
      pipelineSaveRefusal(binding("root.steps[0].with.then[0]")),
    ).toContain("top-level");
    expect(
      pipelineSaveRefusal(binding("root.steps[0]", "secret")),
    ).toContain("secret");
    const guarded = {
      nodes: [{ id: "g", source: { path: "root.nodes[0]", nodeType: "if" } }],
    };
    expect(applyPipelineSaves(guarded, [binding("root.steps[0]")])).toEqual([
      "root.steps[0]",
    ]);
    expect(guarded.nodes[0]).not.toHaveProperty("stateWrites");
  });

  it("writes every present port, as the oracle", async () => {
    const outputs = {
      result: { text: "hi" },
      receipt: { digest: "d1" },
      notes: "n",
    };
    const oracle = await oracleRun({ outputs });
    expect(oracle).toEqual({
      ok: true,
      status: "completed",
      saved: { draft: { text: "hi" }, draftReceipt: { digest: "d1" }, draftNotes: "n" },
    });
    const run = await runPipeline(await compilePipeline(saveSource()), { outputs });
    expect(run).toEqual({ state: "completed", error: undefined, saved: oracle.ok ? oracle.saved : undefined });
  });

  it("skips an absent optional port, as the oracle", async () => {
    const outputs = { result: "r", receipt: { digest: "d1" } };
    const oracle = await oracleRun({ outputs });
    expect(oracle).toEqual({
      ok: true,
      status: "completed",
      saved: { draft: "r", draftReceipt: { digest: "d1" } },
    });
    const run = await runPipeline(await compilePipeline(saveSource()), { outputs });
    expect(run.state).toBe("completed");
    expect(run.saved).toEqual(oracle.ok ? oracle.saved : undefined);
  });

  it("refuses a missing required port and writes nothing, as the oracle", async () => {
    const outputs = { result: "r", notes: "n" };
    const oracle = await oracleRun({ outputs });
    expect(oracle.ok).toBe(false);
    expect(oracle.ok ? [] : oracle.codes).toContain("V2_SIMULATOR_OUTPUT_INVALID");
    const run = await runPipeline(await compilePipeline(saveSource()), { outputs });
    expect(run.state).toBe("failed");
    expect(run.error).toMatch(/^PIPELINE_STATE_WRITE_INVALID: .*outputs\.receipt/);
    expect(run.saved).toBeUndefined();
  });

  it("a caught-continue step writes nothing, as the oracle", async () => {
    const oracle = await oracleRun({ code: "ADAPTER_CANCELLED" });
    expect(oracle).toEqual({ ok: true, status: "caught-continue", saved: {} });
    const run = await runPipeline(await compilePipeline(saveSource(true)), {
      code: "ADAPTER_CANCELLED",
    });
    expect(run).toEqual({ state: "completed", error: undefined, saved: {} });
  });
});
