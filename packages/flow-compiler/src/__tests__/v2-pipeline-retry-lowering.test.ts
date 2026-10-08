import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type PipelineRuntimeEvent,
} from "@dzupagent/agent/pipeline";
import { BUILT_IN_PRIMITIVE_REGISTRY_V2 } from "@dzupagent/flow-dsl";
import type { PrimitiveRetryBackoff } from "@dzupagent/flow-dsl/v2-retry-policy";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import {
  applyPipelineRetries,
  pipelineRetryRefusal,
} from "../compile-orchestrator/v2-pipeline-retry.js";
import { createFlowCompiler } from "../index.js";
import {
  backoffSeed,
  seededBackoff,
} from "../v2-inactive-local-target/evidence.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-R2: V2 `retry:` lowers onto
 * `PipelineRuntime` (`retries` + exact-code `retryPolicy`) under the opt-in
 * `target: "pipeline"`, and the runtime's attempts and scheduled backoffs
 * equal the local-host oracle's (`host-step.ts`) for the same contract.
 */

const toolResolver = { resolve: () => null, listAvailable: () => [] };

const adapter = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
if (adapter === undefined) throw new Error("missing adapter.run@1");
const adapterHash = adapter.compatibility.semanticHash;

function retrySource(retry: string): string {
  return `
dsl: dzupflow/v2
id: v2-pipeline-retry
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
${retry}
    save:
      result: state.draft
`;
}

const fixedRetry = `    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
      backoff:
        strategy: fixed
        initialMs: 5
        maxMs: 5
        jitter: none`;

const exponentialRetry = `    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 4
      backoff:
        strategy: exponential
        initialMs: 4
        maxMs: 10
        jitter: none`;

const noBackoffRetry = `    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 3`;

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

/** The oracle's per-attempt backoff for `root.steps[1]` (host-step.ts). */
function oracleBackoffs(
  backoff: PrimitiveRetryBackoff | undefined,
  retries: number,
): number[] {
  const seed = backoffSeed(adapterHash, "root.steps[1]");
  return Array.from({ length: retries }, (_, index) =>
    seededBackoff(seed, index + 1, backoff),
  );
}

async function runWithCodes(
  definition: PipelineDefinition,
  codes: readonly (string | undefined)[],
) {
  const draft = stepNode(definition, "draft");
  const attempts: string[] = [];
  const retryBackoffs: number[] = [];
  let call = 0;
  const run = await new PipelineRuntime({
    definition,
    checkpointStore: new InMemoryPipelineCheckpointStore(),
    onEvent: (event: PipelineRuntimeEvent) => {
      if (event.type === "pipeline:node_retry" && event.nodeId === draft.id) {
        retryBackoffs.push(event.backoffMs);
      }
    },
    nodeExecutor: async (nodeId) => {
      if (nodeId !== draft.id) {
        return { nodeId, output: undefined, durationMs: 0 };
      }
      const code = codes[call];
      call += 1;
      attempts.push(code ?? "success");
      if (code === undefined) {
        return { nodeId, output: { text: "ok" }, durationMs: 0 };
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
  return { run, attempts, retryBackoffs };
}

describe("V2 retry on target pipeline (S5-R2)", () => {
  it("lowers fixed backoff to retries and an exact-code retry policy", async () => {
    const definition = await compilePipeline(retrySource(fixedRetry));
    const draft = stepNode(definition, "draft");
    expect(draft.retries).toBe(1);
    expect(draft.retryPolicy).toEqual({
      retryableErrorCodes: ["ADAPTER_FAILED"],
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      multiplier: 1,
      jitter: false,
    });
    // Steps without `retry:` are untouched.
    const seed = stepNode(definition, "seed");
    expect(seed.retries).toBeUndefined();
    expect(seed.retryPolicy).toBeUndefined();
  });

  it("lowers exponential backoff with multiplier 2 and no backoff as zero delay", async () => {
    const exponential = stepNode(
      await compilePipeline(retrySource(exponentialRetry)),
      "draft",
    );
    expect(exponential.retries).toBe(3);
    expect(exponential.retryPolicy).toEqual({
      retryableErrorCodes: ["ADAPTER_FAILED"],
      initialBackoffMs: 4,
      maxBackoffMs: 10,
      multiplier: 2,
      jitter: false,
    });
    const none = stepNode(
      await compilePipeline(retrySource(noBackoffRetry)),
      "draft",
    );
    expect(none.retries).toBe(2);
    expect(none.retryPolicy).toEqual({
      retryableErrorCodes: ["ADAPTER_FAILED"],
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      multiplier: 1,
      jitter: false,
    });
  });

  it("keeps full jitter refused on pipeline and retry refused on other targets", async () => {
    const jitter = await compile(
      retrySource(exponentialRetry.replace("jitter: none", "jitter: full")),
      "pipeline",
    );
    if (!("errors" in jitter)) throw new Error("expected jitter refusal");
    expect(jitter.errors.map((error) => [error.code, error.nodePath])).toEqual([
      ["V2_RETRY_TARGET_UNSUPPORTED", "root.steps[1].retry"],
    ]);
    expect(jitter.errors[0]?.message).toContain("jitter");

    const routed = await compile(retrySource(fixedRetry));
    if (!("errors" in routed)) throw new Error("expected default retry gate");
    expect(routed.errors.map((error) => error.code)).toEqual([
      "V2_RETRY_TARGET_UNSUPPORTED",
    ]);
  });

  it("fails closed when no single primitive node carries the step", () => {
    const binding = {
      authoredPath: "root.steps[0]",
      primitiveRef: adapter.ref,
      primitiveSemanticHash: adapterHash,
      retry: {
        match: ["ADAPTER_FAILED"],
        maxAttempts: 2,
        attemptIdentity: "same-invocation" as const,
      },
    };
    // A guarded step lowers to a branch at root.nodes[0], not the primitive.
    const guarded = {
      nodes: [{ id: "g", source: { path: "root.nodes[0]", nodeType: "if" } }],
    };
    expect(applyPipelineRetries(guarded, [binding])).toEqual(["root.steps[0]"]);
    expect(guarded.nodes[0]).not.toHaveProperty("retries");
    expect(
      pipelineRetryRefusal({ ...binding, authoredPath: "root.steps[0].with.then[0]" }),
    ).toContain("top-level");
  });

  it("retries a matching code with the oracle's backoff, then succeeds", async () => {
    const definition = await compilePipeline(retrySource(fixedRetry));
    const { run, attempts, retryBackoffs } = await runWithCodes(definition, [
      "ADAPTER_FAILED",
      undefined,
    ]);
    expect(run.state, run.error).toBe("completed");
    expect(attempts).toEqual(["ADAPTER_FAILED", "success"]);
    expect(retryBackoffs).toEqual(
      oracleBackoffs(
        { strategy: "fixed", initialMs: 5, maxMs: 5, jitter: "none" },
        1,
      ),
    );
  });

  it("exhausts maxAttempts with the oracle's exponential backoffs", async () => {
    const definition = await compilePipeline(retrySource(exponentialRetry));
    const { run, attempts, retryBackoffs } = await runWithCodes(definition, [
      "ADAPTER_FAILED",
      "ADAPTER_FAILED",
      "ADAPTER_FAILED",
      "ADAPTER_FAILED",
      undefined,
    ]);
    expect(run.state).toBe("failed");
    expect(attempts).toHaveLength(4);
    expect(retryBackoffs).toEqual(
      oracleBackoffs(
        { strategy: "exponential", initialMs: 4, maxMs: 10, jitter: "none" },
        3,
      ),
    );
    expect(retryBackoffs).toEqual([4, 8, 10]);
  });

  it("does not retry a code outside match; no backoff waits zero", async () => {
    const definition = await compilePipeline(retrySource(noBackoffRetry));
    const cancelled = await runWithCodes(definition, [
      "ADAPTER_CANCELLED",
      undefined,
    ]);
    expect(cancelled.run.state).toBe("failed");
    expect(cancelled.attempts).toEqual(["ADAPTER_CANCELLED"]);
    expect(cancelled.retryBackoffs).toEqual([]);

    const noBackoff = await runWithCodes(definition, [
      "ADAPTER_FAILED",
      undefined,
    ]);
    expect(noBackoff.run.state, noBackoff.run.error).toBe("completed");
    expect(noBackoff.retryBackoffs).toEqual(oracleBackoffs(undefined, 1));
    expect(noBackoff.retryBackoffs).toEqual([0]);
  });
});
