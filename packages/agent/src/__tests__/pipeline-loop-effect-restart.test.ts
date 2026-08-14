/**
 * F-R4 + F-R6 provider-free join.
 *
 * Proves the crash window between an externally committed loop-body effect and
 * the next pipeline checkpoint. The body node is re-entered after restart, but
 * a durable committed receipt suppresses the external dispatch; an otherwise
 * identical empty journal performs exactly one dispatch.
 */
import { describe, expect, it } from "vitest";
import fixture from "@dzupagent/runtime-contracts/fixtures/ai-execution-conformance-v2.json";
import {
  canonicalInputDigest,
  type AiExecutionBinding,
} from "@dzupagent/runtime-contracts";
import {
  executeEffectOnce,
  materializeEffectIntent,
  validateEffectIntent,
  type EffectClaimResult,
  type EffectIntent,
  type EffectJournalRecord,
  type EffectJournalStore,
  type EffectReceipt,
} from "@dzupagent/runtime-contracts/effect-receipt";
import type { PipelineDefinition } from "@dzupagent/core";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const executionBinding = (
  fixture as {
    cases: Array<{ receipt?: { schema?: string; binding?: AiExecutionBinding } }>;
  }
).cases.find(
  ({ receipt }) => receipt?.schema === "dzupagent.aiExecutionReceipt/v2"
)?.receipt?.binding;

if (executionBinding === undefined) {
  throw new Error("V2 conformance fixture is missing its execution binding");
}

class SharedEffectJournal implements EffectJournalStore<string> {
  readonly records = new Map<string, EffectJournalRecord<string>>();

  async claim(
    intent: EffectIntent,
    claimedAt: string
  ): Promise<EffectClaimResult<string>> {
    const existing = this.records.get(intent.idempotencyKey);
    if (existing !== undefined) return { status: "existing", record: existing };
    this.records.set(intent.idempotencyKey, {
      status: "pending",
      intent,
      claimedAt,
    });
    return { status: "claimed" };
  }

  async commit(
    intent: EffectIntent,
    receipt: EffectReceipt<string>
  ): Promise<void> {
    const existing = this.records.get(intent.idempotencyKey);
    if (
      existing?.status !== "pending" ||
      existing.intent.intentDigest !== intent.intentDigest
    ) {
      throw new Error("effect commit compare-and-set failed");
    }
    this.records.set(intent.idempotencyKey, {
      status: "committed",
      intent,
      receipt,
    });
  }

  async markOutcomeUnknown(
    intent: EffectIntent,
    observedAt: string
  ): Promise<void> {
    const existing = this.records.get(intent.idempotencyKey);
    if (
      existing?.status !== "pending" ||
      existing.intent.intentDigest !== intent.intentDigest
    ) {
      throw new Error("effect unknown compare-and-set failed");
    }
    this.records.set(intent.idempotencyKey, {
      status: "outcome-unknown",
      intent,
      observedAt,
    });
  }
}

const definition: PipelineDefinition = {
  id: "loop-effect-restart",
  name: "LoopEffectRestart",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  entryNodeId: "seed",
  checkpointStrategy: "after_each_node",
  resume: { onProcessRestart: "resume_from_checkpoint" },
  nodes: [
    { id: "seed", type: "agent", agentId: "seed", timeoutMs: 5000 },
    {
      id: "L",
      type: "loop",
      bodyNodeIds: ["effect", "finish"],
      maxIterations: 2,
      continuePredicateName: "notDone",
    },
    { id: "effect", type: "agent", agentId: "effect", timeoutMs: 5000 },
    { id: "finish", type: "agent", agentId: "finish", timeoutMs: 5000 },
  ],
  edges: [{ type: "sequential", sourceNodeId: "seed", targetNodeId: "L" }],
};

function effectIntent(
  runId: string,
  idempotencyKey = `${runId}:effect`
): EffectIntent {
  return materializeEffectIntent({
    idempotencyKey,
    sourceHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    runId,
    nodeId: "effect",
    effectClass: "db_write",
    attemptPolicy: "exactly-once-required",
    operationDigest: `sha256:${canonicalInputDigest({
      operation: "insert",
      record: { id: "record-1" },
    })}`,
    executionBinding,
  });
}

function executor(input: {
  journal: SharedEffectJournal;
  runId: string;
  externalDispatches: string[];
  crashAfterFirstCommit: boolean;
}): NodeExecutor {
  return async (nodeId, _node, context) => {
    if (nodeId === "seed") {
      return { nodeId, output: "checkpoint-boundary", durationMs: 1 };
    }
    if (nodeId === "finish") {
      context.state["done"] = true;
      return { nodeId, output: "finished", durationMs: 1 };
    }

    const outcome = await executeEffectOnce({
      store: input.journal,
      intent: effectIntent(
        input.runId,
        context.idempotencyKey ?? `${input.runId}:effect`
      ),
      execute: async () => {
        input.externalDispatches.push(input.runId);
        return "record-1";
      },
      now: () => "2026-08-14T10:00:00.000Z",
    });
    if (outcome.status === "blocked") {
      throw new Error(`effect blocked: ${outcome.reason}`);
    }
    if (input.crashAfterFirstCommit && outcome.status === "executed") {
      throw new Error("simulated process loss after effect commit");
    }
    return {
      nodeId,
      output: {
        effectStatus: outcome.status,
        receiptDigest: outcome.receipt.receiptDigest,
      },
      durationMs: 1,
    };
  };
}

describe("pipeline loop + effect receipt restart join", () => {
  it("replays a committed bound effect and dispatches an empty-journal control", async () => {
    const checkpointStore = new InMemoryPipelineCheckpointStore();
    const committedJournal = new SharedEffectJournal();
    const committedDispatches: string[] = [];
    const runId = "effect-restart-positive";
    const first = new PipelineRuntime({
      definition,
      checkpointStore,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: executor({
        journal: committedJournal,
        runId,
        externalDispatches: committedDispatches,
        crashAfterFirstCommit: true,
      }),
    });

    expect(validateEffectIntent(effectIntent(runId))).toEqual({
      valid: true,
      diagnostics: [],
    });
    const failed = await first.execute(undefined, { runId });
    expect(failed.state).toBe("failed");
    expect(committedDispatches).toEqual([runId]);
    const checkpoint = await checkpointStore.load(runId);
    expect(checkpoint?.completedNodeIds).toEqual(["seed"]);
    expect(checkpoint?.loopState).toBeUndefined();

    const committedRecord = committedJournal.records.get(`${runId}:effect`);
    expect(committedRecord?.status).toBe("committed");
    if (committedRecord?.status !== "committed") {
      throw new Error("test setup did not commit its effect");
    }
    expect(committedRecord.receipt.executionBinding).toEqual(executionBinding);

    const resumedBodyRuns: string[] = [];
    const second = new PipelineRuntime({
      definition,
      checkpointStore,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, node, context) => {
        if (nodeId !== "seed") resumedBodyRuns.push(nodeId);
        return executor({
          journal: committedJournal,
          runId,
          externalDispatches: committedDispatches,
          crashAfterFirstCommit: false,
        })(nodeId, node, context);
      },
    });
    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");
    expect(resumedBodyRuns).toEqual(["effect", "finish"]);
    expect(committedDispatches).toEqual([runId]);
    expect(resumed.nodeResults.get("L")?.output).toMatchObject({
      loopOutput: "finished",
    });

    const emptyJournal = new SharedEffectJournal();
    const emptyDispatches: string[] = [];
    const negativeRunId = "effect-restart-empty-control";
    const negativeCheckpoint = {
      ...structuredClone(checkpoint!),
      pipelineRunId: negativeRunId,
    };
    const negative = new PipelineRuntime({
      definition,
      checkpointStore: new InMemoryPipelineCheckpointStore(),
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: executor({
        journal: emptyJournal,
        runId: negativeRunId,
        externalDispatches: emptyDispatches,
        crashAfterFirstCommit: false,
      }),
    });
    const negativeResult = await negative.resume(negativeCheckpoint);
    expect(negativeResult.state).toBe("completed");
    expect(emptyDispatches).toEqual([negativeRunId]);
  });

  it("replays a committed effect at an exact conditional-body graph cursor", async () => {
    const runId = "structured-effect-restart";
    const checkpointStore = new InMemoryPipelineCheckpointStore();
    const journal = new SharedEffectJournal();
    const externalDispatches: string[] = [];
    const firstCalls: string[] = [];
    const structuredDefinition: PipelineDefinition = {
      id: "structured-loop-effect-restart",
      name: "StructuredLoopEffectRestart",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "seed",
      checkpointStrategy: "after_each_node",
      resume: { onProcessRestart: "resume_from_checkpoint" },
      nodes: [
        { id: "seed", type: "agent", agentId: "seed" },
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["choose", "effect", "finish"],
          bodyGraph: {
            entryNodeId: "choose",
            normalExitNodeIds: ["finish"],
            suspendedExitNodeIds: [],
            terminalExitNodeIds: [],
            errorExitNodeIds: [],
          },
          maxIterations: 2,
          continuePredicateName: "notDone",
        },
        { id: "choose", type: "gate", gateType: "quality" },
        { id: "effect", type: "agent", agentId: "effect" },
        { id: "finish", type: "agent", agentId: "finish" },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "seed", targetNodeId: "L" },
        {
          type: "conditional",
          sourceNodeId: "choose",
          predicateName: "take-effect",
          branches: { true: "effect", false: "finish" },
        },
        {
          type: "sequential",
          sourceNodeId: "effect",
          targetNodeId: "finish",
        },
      ],
    };

    const first = await new PipelineRuntime({
      definition: structuredDefinition,
      checkpointStore,
      predicates: {
        "take-effect": () => true,
        notDone: (state) => state["done"] !== true,
      },
      nodeExecutor: async (nodeId, node, context) => {
        firstCalls.push(nodeId);
        if (nodeId === "choose") {
          return { nodeId, output: true, durationMs: 1 };
        }
        return executor({
          journal,
          runId,
          externalDispatches,
          crashAfterFirstCommit: true,
        })(nodeId, node, context);
      },
    }).execute(undefined, { runId });

    expect(first.state).toBe("failed");
    expect(firstCalls).toEqual(["seed", "choose", "effect"]);
    expect(externalDispatches).toEqual([runId]);
    const checkpoint = await checkpointStore.load(runId);
    expect(checkpoint?.loopState?.["L"]?.bodyGraphState).toMatchObject({
      completed: false,
      nextNodeId: "effect",
      completedNodeIds: ["choose"],
    });

    const resumedCalls: string[] = [];
    const resumed = await new PipelineRuntime({
      definition: structuredDefinition,
      checkpointStore,
      predicates: {
        "take-effect": () => true,
        notDone: (state) => state["done"] !== true,
      },
      nodeExecutor: async (nodeId, node, context) => {
        resumedCalls.push(nodeId);
        if (nodeId === "choose") {
          throw new Error("completed branch gate must not be re-dispatched");
        }
        return executor({
          journal,
          runId,
          externalDispatches,
          crashAfterFirstCommit: false,
        })(nodeId, node, context);
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual(["effect", "finish"]);
    expect(externalDispatches).toEqual([runId]);
    expect(journal.records).toHaveLength(1);
  });
});
