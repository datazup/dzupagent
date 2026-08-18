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
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
// `AiExecutionBinding` is published on the `/ai-execution` subpath. The package
// root re-exports an explicitly enumerated surface (see runtime-contracts
// src/index.ts) which does not include it.
import type { AiExecutionBinding } from "@dzupagent/runtime-contracts/ai-execution";
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
import type { PipelineCheckpoint, PipelineDefinition } from "@dzupagent/core";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { LoopBudgetStrictHost } from "../pipeline/loop-executor.js";
import { deriveIterationReservationId } from "../pipeline/loop-executor/predicate-loop-economics.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const fixtureExecutionBinding = (
  fixture as {
    cases: Array<{ receipt?: { schema?: string; binding?: AiExecutionBinding } }>;
  }
).cases.find(
  ({ receipt }) => receipt?.schema === "dzupagent.aiExecutionReceipt/v2"
)?.receipt?.binding;

if (fixtureExecutionBinding === undefined) {
  throw new Error("V2 conformance fixture is missing its execution binding");
}

// Re-bind the narrowed value: control-flow narrowing of a module-level const
// does not reach into the body of the `effectIntent` function declaration
// below, so it would otherwise still see `AiExecutionBinding | undefined` and
// violate the exact-optional `EffectIntentInput.executionBinding`.
const executionBinding: AiExecutionBinding = fixtureExecutionBinding;

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
  onFirstCommit?: () => void;
  pauseAfterFirstCommit?: boolean;
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
    if (outcome.status === "executed") input.onFirstCommit?.();
    if (input.pauseAfterFirstCommit && outcome.status === "executed") {
      await new Promise<never>(() => undefined);
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
  it("reconciles the retained iteration hold without repeating a committed effect or charge", async () => {
    class FailBeforeEffectCursorStore extends InMemoryPipelineCheckpointStore {
      private failed = false;

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        if (
          !this.failed &&
          checkpoint.loopState?.["L"]?.nextBodyNodeIndex === 1
        ) {
          this.failed = true;
          throw new Error("simulated process loss before loop cursor write");
        }
        await super.save(checkpoint);
      }
    }

    const budgetedDefinition: PipelineDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id !== "L"
          ? node
          : {
              ...node,
              typedWhile: {
                conditionSchema: "dzupagent.flowTypedCondition/v1",
                condition: { op: "literal", value: true },
                onExhausted: "continue",
                iterationBudgetCents: 10,
              },
            }
      ),
    };
    const makeBudgetHost = (calls: {
      reserves: unknown[];
      settles: unknown[];
      releases: unknown[];
      reconciles: unknown[];
    }): LoopBudgetStrictHost => ({
      mode: "strict",
      reserve: (input) => {
        calls.reserves.push(input);
        return { status: "reserved", reservedCostCents: 8 };
      },
      settle: (input) => {
        calls.settles.push(input);
      },
      release: (input) => {
        calls.releases.push(input);
      },
      reconcile: (input) => {
        calls.reconciles.push(input);
        return { status: "reserved", reservedCostCents: 8 };
      },
      measureItemCost: () => ({ status: "known", costCents: 3 }),
    });

    const runId = "strict-effect-restart";
    const checkpointStore = new FailBeforeEffectCursorStore();
    const journal = new SharedEffectJournal();
    const externalDispatches: string[] = [];
    const calls = {
      reserves: [] as unknown[],
      settles: [] as unknown[],
      releases: [] as unknown[],
      reconciles: [] as unknown[],
    };
    const first = await new PipelineRuntime({
      definition: budgetedDefinition,
      checkpointStore,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: executor({
        journal,
        runId,
        externalDispatches,
        crashAfterFirstCommit: false,
      }),
      loopIterationBudgetReservation: makeBudgetHost(calls),
    }).execute(undefined, { runId });

    expect(first.state).toBe("failed");
    expect(externalDispatches).toEqual([runId]);
    expect(calls.reserves).toHaveLength(1);
    expect(calls.settles).toEqual([]);
    expect(calls.releases).toEqual([]);
    const checkpoint = await checkpointStore.load(runId);
    expect(checkpoint?.loopState?.["L"]).toMatchObject({
      iteration: 0,
      iterationOutcome: "reserved",
      iterationEconomics: {
        reservationId: `resv:v1:${runId}:iteration:L:1`,
        reservedCostCents: 8,
      },
    });
    expect(checkpoint?.loopState?.["L"]?.nextBodyNodeIndex).toBeUndefined();

    const resumed = await new PipelineRuntime({
      definition: budgetedDefinition,
      checkpointStore,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: executor({
        journal,
        runId,
        externalDispatches,
        crashAfterFirstCommit: false,
      }),
      loopIterationBudgetReservation: makeBudgetHost(calls),
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(externalDispatches).toEqual([runId]);
    expect(calls.reserves).toHaveLength(1);
    expect(calls.reconciles).toEqual([
      expect.objectContaining({ boundary: "reserve" }),
    ]);
    expect(calls.settles).toHaveLength(1);
    expect(calls.releases).toEqual([]);

    const controlRunId = "strict-effect-empty-control";
    const controlCheckpoint = structuredClone(checkpoint!);
    controlCheckpoint.pipelineRunId = controlRunId;
    const controlEconomics = (
      controlCheckpoint.loopState?.["L"] as
        | (NonNullable<PipelineCheckpoint["loopState"]>[string] & {
            iterationEconomics?: {
              reservationId: string;
              reservedCostCents: number;
              settledCostCents?: number;
            };
          })
        | undefined
    )?.iterationEconomics;
    if (controlEconomics === undefined) {
      throw new Error("test setup omitted retained iteration economics");
    }
    controlEconomics.reservationId = deriveIterationReservationId({
      runId: controlRunId,
      loopNodeId: "L",
      iteration: 1,
    });
    const controlJournal = new SharedEffectJournal();
    const controlDispatches: string[] = [];
    const controlCalls = {
      reserves: [] as unknown[],
      settles: [] as unknown[],
      releases: [] as unknown[],
      reconciles: [] as unknown[],
    };
    const control = await new PipelineRuntime({
      definition: budgetedDefinition,
      checkpointStore: new InMemoryPipelineCheckpointStore(),
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: executor({
        journal: controlJournal,
        runId: controlRunId,
        externalDispatches: controlDispatches,
        crashAfterFirstCommit: false,
      }),
      loopIterationBudgetReservation: makeBudgetHost(controlCalls),
    }).resume(controlCheckpoint);

    expect(control.state).toBe("completed");
    expect(controlDispatches).toEqual([controlRunId]);
    expect(controlCalls.reserves).toEqual([]);
    expect(controlCalls.reconciles).toHaveLength(1);
    expect(controlCalls.settles).toHaveLength(1);
  });

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

  it("replays a committed effect while restoring a parallel sibling at the join", async () => {
    class RetainSiblingBranchStore extends InMemoryPipelineCheckpointStore {
      private readyResolve!: () => void;
      readonly ready = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });

      override async save(checkpoint: PipelineCheckpoint): Promise<void> {
        await super.save(checkpoint);
        const branches =
          checkpoint.loopState?.["L"]?.bodyGraphState?.forkState?.["parallel"]
            ?.branches ?? {};
        if (branches["sibling"] !== undefined) this.readyResolve();
      }
    }

    const parallelDefinition: PipelineDefinition = {
      id: "structured-parallel-effect-restart",
      name: "StructuredParallelEffectRestart",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "L",
      checkpointStrategy: "after_each_node",
      resume: { onProcessRestart: "resume_from_checkpoint" },
      nodes: [
        {
          id: "L",
          type: "loop",
          bodyNodeIds: ["fork", "effect", "sibling", "join"],
          bodyGraph: {
            entryNodeId: "fork",
            normalExitNodeIds: ["join"],
            suspendedExitNodeIds: [],
            terminalExitNodeIds: [],
            errorExitNodeIds: [],
          },
          maxIterations: 2,
          continuePredicateName: "notDone",
        },
        { id: "fork", type: "fork", forkId: "parallel" },
        { id: "effect", type: "agent", agentId: "effect" },
        { id: "sibling", type: "agent", agentId: "sibling" },
        { id: "join", type: "join", forkId: "parallel" },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "fork", targetNodeId: "effect" },
        { type: "sequential", sourceNodeId: "fork", targetNodeId: "sibling" },
        { type: "sequential", sourceNodeId: "effect", targetNodeId: "join" },
        { type: "sequential", sourceNodeId: "sibling", targetNodeId: "join" },
      ],
    };

    const store = new RetainSiblingBranchStore();
    const journal = new SharedEffectJournal();
    const runId = "parallel-effect-restart";
    const externalDispatches: string[] = [];
    const idempotencyKeys: string[] = [];
    let effectCommittedResolve!: () => void;
    const effectCommitted = new Promise<void>((resolve) => {
      effectCommittedResolve = resolve;
    });

    const firstRun = new PipelineRuntime({
      definition: parallelDefinition,
      checkpointStore: store,
      predicates: { notDone: (state) => state["done"] !== true },
      nodeExecutor: async (nodeId, node, context) => {
        if (nodeId === "sibling") {
          context.state["winner"] = "sibling";
          context.state["done"] = true;
          return { nodeId, output: "sibling", durationMs: 1 };
        }
        idempotencyKeys.push(context.idempotencyKey!);
        context.state["winner"] = "effect";
        return executor({
          journal,
          runId,
          externalDispatches,
          crashAfterFirstCommit: false,
          onFirstCommit: effectCommittedResolve,
          pauseAfterFirstCommit: true,
        })(nodeId, node, context);
      },
    }).execute(undefined, { runId });
    void firstRun.catch(() => undefined);

    await Promise.all([effectCommitted, store.ready]);
    const checkpoint = await store.load(runId);
    expect(externalDispatches).toEqual([runId]);
    expect(
      Object.keys(
        checkpoint?.loopState?.["L"]?.bodyGraphState?.forkState?.["parallel"]
          ?.branches ?? {}
      )
    ).toEqual(["sibling"]);

    const resumedCalls: string[] = [];
    let resumedConflictWinner: unknown;
    const resumed = await new PipelineRuntime({
      definition: parallelDefinition,
      checkpointStore: store,
      predicates: {
        notDone: (state) => {
          resumedConflictWinner = state["winner"];
          return state["done"] !== true;
        },
      },
      nodeExecutor: async (nodeId, node, context) => {
        resumedCalls.push(nodeId);
        if (nodeId === "sibling") {
          throw new Error("completed sibling branch must not be re-dispatched");
        }
        idempotencyKeys.push(context.idempotencyKey!);
        context.state["winner"] = "effect";
        return executor({
          journal,
          runId,
          externalDispatches,
          crashAfterFirstCommit: false,
        })(nodeId, node, context);
      },
    }).resume(checkpoint!);

    expect(resumed.state).toBe("completed");
    expect(resumedCalls).toEqual(["effect"]);
    expect(externalDispatches).toEqual([runId]);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    // Existing policy: merge fulfilled branches in outgoing-edge order, so the
    // later sibling branch deterministically wins a same-key state conflict.
    expect(resumedConflictWinner).toBe("sibling");

    const emptyJournal = new SharedEffectJournal();
    const emptyDispatches: string[] = [];
    const controlRunId = "parallel-effect-empty-control";
    const controlCheckpoint = {
      ...structuredClone(checkpoint!),
      pipelineRunId: controlRunId,
    };
    let controlConflictWinner: unknown;
    const control = await new PipelineRuntime({
      definition: parallelDefinition,
      checkpointStore: new InMemoryPipelineCheckpointStore(),
      predicates: {
        notDone: (state) => {
          controlConflictWinner = state["winner"];
          return state["done"] !== true;
        },
      },
      nodeExecutor: async (nodeId, node, context) => {
        if (nodeId === "sibling") {
          throw new Error("control must restore the sibling branch");
        }
        context.state["winner"] = "effect";
        return executor({
          journal: emptyJournal,
          runId: controlRunId,
          externalDispatches: emptyDispatches,
          crashAfterFirstCommit: false,
        })(nodeId, node, context);
      },
    }).resume(controlCheckpoint);

    expect(control.state).toBe("completed");
    expect(emptyDispatches).toEqual([controlRunId]);
    expect(controlConflictWinner).toBe("sibling");
  });
});
