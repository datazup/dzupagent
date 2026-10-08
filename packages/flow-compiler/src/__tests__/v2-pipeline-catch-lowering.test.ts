import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type PipelineRuntimeEvent,
} from "@dzupagent/agent/pipeline";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import {
  applyPipelineCatches,
  pipelineCatchRefusal,
} from "../compile-orchestrator/v2-pipeline-catch.js";
import { createFlowCompiler } from "../index.js";
import {
  simulateV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
} from "../v2-inactive-local-target.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-C2: V2 `catch:` lowers onto
 * `PipelineRuntime` (`terminalCatch`) under the opt-in `target: "pipeline"`,
 * and each run outcome corresponds to the local-host oracle's step status
 * (`host-step.ts`) for the same clause.
 */

type CatchAction = "continue" | "complete" | "fail";

const toolResolver = { resolve: () => null, listAvailable: () => [] };

const adapter = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
if (adapter === undefined) throw new Error("missing adapter.run@1");

function catchClause(action: CatchAction): string {
  return `    catch:
      - match:
          - ADAPTER_CANCELLED
        action: ${action}
${action === "fail" ? "        code: LOCAL_ADAPTER_CANCELLED\n" : ""}`;
}

function catchSource(action: CatchAction): string {
  return `
dsl: dzupflow/v2
id: v2-pipeline-catch
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        seeded: true
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
${catchClause(action)}    save:
      result: state.draft
  - id: tail
    use: core.set@1
    with:
      assign:
        tailed: true
`;
}

async function compile(source: string, target?: "pipeline") {
  return createFlowCompiler({
    toolResolver,
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

/** Run with `draft` failing on `code`; report run state and visited steps. */
async function runFailing(definition: PipelineDefinition, code: string) {
  const draft = stepNode(definition, "draft");
  const tail = stepNode(definition, "tail");
  // `core.set` nodes do not reach `nodeExecutor`, so observe node starts.
  const visited: string[] = [];
  const run = await new PipelineRuntime({
    definition,
    checkpointStore: new InMemoryPipelineCheckpointStore(),
    onEvent: (event: PipelineRuntimeEvent) => {
      if (event.type === "pipeline:node_started") visited.push(event.nodeId);
    },
    nodeExecutor: async (nodeId) => {
      if (nodeId !== draft.id) {
        return { nodeId, output: undefined, durationMs: 0 };
      }
      return {
        nodeId,
        output: undefined,
        durationMs: 0,
        error: `adapter failed: ${code}`,
        errorMetadata: { code },
      };
    },
  }).execute({});
  return {
    state: run.state,
    error: run.error,
    draftRan: visited.includes(draft.id),
    tailRan: visited.includes(tail.id),
  };
}

/**
 * The oracle's step status and terminal code for one catch action. The local
 * host admits only its five-feature fixture, so the catch clause is run there
 * with the same primitive error (as in `v2-inactive-local-simulator.test.ts`).
 */
async function oracleOutcome(action: CatchAction, codes: readonly string[]) {
  const base = adapter!;
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  const primitive = definePrimitiveV2({
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
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
  const source = `
dsl: dzupflow/v2
id: inactive-local-catch-oracle
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
${catchClause(action)}    save:
      result: state.result
      receipt: state.receipt
`;
  const result = await simulateV2InactiveLocalTarget({
    source,
    compilerOptions: {
      toolResolver,
      referencePolicy: "strict",
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
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
    initialState: {},
    attempts: codes.map((code) => ({
      status: "error" as const,
      code,
      durationMs: 1,
      costCents: 0,
    })),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return {
    status: result.receipt.status,
    code: result.receipt.terminal?.code,
  };
}

describe("V2 catch on target pipeline (S5-C2)", () => {
  it("lowers each clause onto terminalCatch in order", async () => {
    const draft = stepNode(
      await compilePipeline(catchSource("fail")),
      "draft",
    );
    expect(draft.terminalCatch).toEqual({
      clauses: [
        {
          errorCodes: ["ADAPTER_CANCELLED"],
          action: "fail",
          failureCode: "LOCAL_ADAPTER_CANCELLED",
        },
      ],
    });
    const continued = await compilePipeline(catchSource("continue"));
    expect(stepNode(continued, "draft").terminalCatch).toEqual({
      clauses: [{ errorCodes: ["ADAPTER_CANCELLED"], action: "continue" }],
    });
    // Steps without `catch:` are untouched.
    expect(stepNode(continued, "seed").terminalCatch).toBeUndefined();
    expect(stepNode(continued, "tail").terminalCatch).toBeUndefined();
  });

  it("keeps catch refused on other targets", async () => {
    const routed = await compile(catchSource("continue"));
    if (!("errors" in routed)) throw new Error("expected default catch gate");
    expect(routed.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ["V2_CATCH_TARGET_UNSUPPORTED", "root.steps[1].catch"],
    ]);
  });

  it("fails closed for nested steps and steps with no single primitive node", () => {
    const binding = {
      authoredPath: "root.steps[0]",
      primitiveRef: adapter.ref,
      primitiveSemanticHash: adapter.compatibility.semanticHash,
      catch: {
        clauses: [
          {
            matches: [],
            outcome: { action: "continue" as const },
          },
        ],
      },
    };
    const guarded = {
      nodes: [{ id: "g", source: { path: "root.nodes[0]", nodeType: "if" } }],
    };
    expect(applyPipelineCatches(guarded, [binding])).toEqual(["root.steps[0]"]);
    expect(guarded.nodes[0]).not.toHaveProperty("terminalCatch");
    expect(
      pipelineCatchRefusal({ ...binding, authoredPath: "root.steps[0].with.then[0]" }),
    ).toContain("top-level");
    expect(pipelineCatchRefusal(binding)).toBeUndefined();
  });

  it("continue: the run goes on past the caught step, as the oracle's caught-continue", async () => {
    const oracle = await oracleOutcome("continue", ["ADAPTER_CANCELLED"]);
    expect(oracle).toEqual({ status: "caught-continue", code: "ADAPTER_CANCELLED" });
    const run = await runFailing(
      await compilePipeline(catchSource("continue")),
      "ADAPTER_CANCELLED",
    );
    expect(run).toEqual({
      state: "completed",
      error: undefined,
      draftRan: true,
      tailRan: true,
    });
  });

  it("complete: the run completes without the next step, as the oracle's caught-complete", async () => {
    const oracle = await oracleOutcome("complete", ["ADAPTER_CANCELLED"]);
    expect(oracle).toEqual({ status: "caught-complete", code: "ADAPTER_CANCELLED" });
    const run = await runFailing(
      await compilePipeline(catchSource("complete")),
      "ADAPTER_CANCELLED",
    );
    expect(run).toMatchObject({ state: "completed", draftRan: true, tailRan: false });
  });

  it("fail: the run fails with the clause code, as the oracle's failed step", async () => {
    const oracle = await oracleOutcome("fail", ["ADAPTER_CANCELLED"]);
    expect(oracle).toEqual({ status: "failed", code: "LOCAL_ADAPTER_CANCELLED" });
    const run = await runFailing(
      await compilePipeline(catchSource("fail")),
      "ADAPTER_CANCELLED",
    );
    expect(run).toMatchObject({
      state: "failed",
      error: oracle.code,
      tailRan: false,
    });
  });

  it("an uncaught code fails the run on both", async () => {
    const oracle = await oracleOutcome("continue", ["ADAPTER_FAILED", "ADAPTER_FAILED"]);
    expect(oracle).toEqual({ status: "failed", code: "ADAPTER_FAILED" });
    const run = await runFailing(
      await compilePipeline(catchSource("continue")),
      "ADAPTER_FAILED",
    );
    expect(run).toMatchObject({ state: "failed", tailRan: false });
  });
});
