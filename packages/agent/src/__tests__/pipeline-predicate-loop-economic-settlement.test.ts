/**
 * F-R4/F-R6 — strict predicate-loop iteration economics.
 *
 * Pins the same reserve/settle/release/reconcile lifecycle already used by
 * `for_each`, but at one predicate-loop iteration boundary.
 */
import type {
  LoopNode,
  PipelineDefinition,
  PipelineNode,
} from "@dzupagent/core";
import { describe, expect, it } from "vitest";

import { executeLoop } from "../pipeline/loop-executor.js";
import type {
  LoopBudgetStrictHost,
  LoopResumeOptions,
} from "../pipeline/loop-executor.js";
import { deriveIterationReservationId } from "../pipeline/loop-executor/predicate-loop-economics.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const BODY: PipelineNode[] = [
  { id: "body", type: "agent", agentId: "body", timeoutMs: 1000 },
];

function loopNode(options?: {
  maxIterations?: number;
  onExhausted?: "fail" | "continue";
  bodyNodeIds?: string[];
}): LoopNode {
  return {
    id: "loop",
    type: "loop",
    bodyNodeIds: options?.bodyNodeIds ?? ["body"],
    maxIterations: options?.maxIterations ?? 1,
    continuePredicateName: "continue",
    typedWhile: {
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: { op: "literal", value: true },
      onExhausted: options?.onExhausted ?? "continue",
      iterationBudgetCents: 10,
    },
  };
}

function definition(options?: {
  maxIterations?: number;
  onExhausted?: "fail" | "continue";
  body?: PipelineNode[];
}): PipelineDefinition {
  const body = options?.body ?? BODY;
  return {
    id: "predicate-loop-economics",
    name: "PredicateLoopEconomics",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop",
    nodes: [
      loopNode({
        ...(options?.maxIterations === undefined
          ? {}
          : { maxIterations: options.maxIterations }),
        ...(options?.onExhausted === undefined
          ? {}
          : { onExhausted: options.onExhausted }),
        bodyNodeIds: body.map(({ id }) => id),
      }),
      ...body,
    ],
    edges: [],
  };
}

function host(options?: {
  reserve?: LoopBudgetStrictHost["reserve"];
  settle?: LoopBudgetStrictHost["settle"];
  release?: LoopBudgetStrictHost["release"];
  reconcile?: LoopBudgetStrictHost["reconcile"];
  measureItemCost?: LoopBudgetStrictHost["measureItemCost"];
}) {
  const reserves: unknown[] = [];
  const settles: unknown[] = [];
  const releases: unknown[] = [];
  const reconciles: unknown[] = [];
  const config: LoopBudgetStrictHost = {
    mode: "strict",
    reserve: async (input) => {
      reserves.push(input);
      return options?.reserve?.(input) ?? {
        status: "reserved",
        reservedCostCents: 8,
      };
    },
    settle: async (input) => {
      settles.push(input);
      await options?.settle?.(input);
    },
    release: async (input) => {
      releases.push(input);
      await options?.release?.(input);
    },
    reconcile: async (input) => {
      reconciles.push(input);
      return (
        (await options?.reconcile?.(input)) ?? {
          status: "unknown",
        }
      );
    },
    measureItemCost: async (input) =>
      (await options?.measureItemCost?.(input)) ?? {
        status: "known",
        costCents: 3,
      },
  };
  return { config, reserves, settles, releases, reconciles };
}

function okExecutor(runs: string[]): NodeExecutor {
  return async (nodeId) => {
    runs.push(nodeId);
    return { nodeId, output: "ok", durationMs: 1 };
  };
}

describe("predicate-loop strict economic admission", () => {
  it("requires the complete strict lifecycle before dispatch", async () => {
    const runs: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: okExecutor(runs),
      loopIterationBudgetReservation: {
        reserve: () => ({ status: "reserved", reservedCostCents: 8 }),
      },
    }).execute();

    expect(result.state).toBe("failed");
    expect(result.error).toContain("hard iteration ceiling requires a strict budget host");
    expect(runs).toEqual([]);
  });

  it.each([
    {
      label: "unknown",
      reserve: () => ({ status: "unknown" as const }),
      reconcile: () => ({ status: "absent" as const }),
    },
    {
      label: "invalid",
      reserve: () => ({ status: "reserved" as const, reservedCostCents: Number.NaN }),
      reconcile: () => ({ status: "absent" as const }),
    },
  ])("denies $label reservation evidence with zero body dispatch", async ({ reserve, reconcile }) => {
    const runs: string[] = [];
    const budget = host({ reserve, reconcile });
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: okExecutor(runs),
      loopIterationBudgetReservation: budget.config,
    }).execute();

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    expect(budget.settles).toEqual([]);
  });

  it("releases an over-ceiling hold before denying dispatch", async () => {
    const runs: string[] = [];
    const budget = host({
      reserve: () => ({ status: "reserved", reservedCostCents: 11 }),
    });
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: okExecutor(runs),
      loopIterationBudgetReservation: budget.config,
    }).execute();

    expect(result.state).toBe("failed");
    expect(result.error).toContain("exceeds the 10-cent ceiling and was released");
    expect(runs).toEqual([]);
    expect(budget.releases).toEqual([
      expect.objectContaining({
        iteration: 1,
        reservedCostCents: 11,
        reason: "failed",
      }),
    ]);
  });
});

describe("predicate-loop strict terminal disposition", () => {
  it("settles known actual cost exactly once on normal completion", async () => {
    const runs: string[] = [];
    const budget = host();
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: okExecutor(runs),
      loopIterationBudgetReservation: budget.config,
    }).execute(undefined, { runId: "normal-settlement" });

    expect(result.state).toBe("completed");
    expect(runs).toEqual(["body"]);
    expect(budget.reserves).toEqual([
      expect.objectContaining({
        iteration: 1,
        reservationId: "resv:v1:normal-settlement:iteration:loop:1",
      }),
    ]);
    expect(budget.settles).toEqual([
      expect.objectContaining({
        reservationId: "resv:v1:normal-settlement:iteration:loop:1",
        reservedCostCents: 8,
        actualCostCents: 3,
      }),
    ]);
    expect(budget.releases).toEqual([]);
  });

  it("fails closed with retained outcome-unknown economics when actual cost is unavailable", async () => {
    const runs: string[] = [];
    const checkpoints: Array<{
      outcome: string;
      economics: { reservationId: string; reservedCostCents: number };
    }> = [];
    const budget = host({
      measureItemCost: () => ({
        status: "unknown",
        reason: "provider receipt omitted usage",
      }),
    });
    const result = await executeLoop(
      loopNode(),
      BODY,
      okExecutor(runs),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        budgetMode: "strict",
        budgetRunId: "unknown-cost-run",
        reserveIterationBudget: budget.config.reserve,
        settleIterationBudget: budget.config.settle,
        releaseIterationBudget: budget.config.release,
        reconcileIterationBudget: budget.config.reconcile,
        measureItemCost: budget.config.measureItemCost,
        onIterationBudgetCheckpoint: async (progress) => {
          checkpoints.push(progress);
        },
      }
    );

    expect(result.result.error).toContain("usage/cost is unknown");
    expect(runs).toEqual(["body"]);
    expect(budget.settles).toEqual([]);
    expect(budget.releases).toEqual([]);
    expect(checkpoints.at(-1)).toMatchObject({
      outcome: "outcome_unknown",
      economics: {
        reservationId: "resv:v1:unknown-cost-run:iteration:loop:1",
        reservedCostCents: 8,
      },
    });
  });

  it("releases a body failure and an interrupted iteration", async () => {
    const failedBudget = host();
    const failed = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: null,
        durationMs: 1,
        error: "body failed",
      }),
      loopIterationBudgetReservation: failedBudget.config,
    }).execute();
    expect(failed.state).toBe("failed");
    expect(failedBudget.releases).toEqual([
      expect.objectContaining({ reason: "failed", reservedCostCents: 8 }),
    ]);
    expect(failedBudget.settles).toEqual([]);

    const controller = new AbortController();
    const cancelledBudget = host();
    const cancelledRuns: string[] = [];
    const body = [
      { id: "first", type: "agent", agentId: "first" } as const,
      { id: "second", type: "agent", agentId: "second" } as const,
    ];
    const cancelled = await new PipelineRuntime({
      definition: definition({ body }),
      signal: controller.signal,
      predicates: { continue: () => false },
      nodeExecutor: async (nodeId) => {
        cancelledRuns.push(nodeId);
        controller.abort();
        return { nodeId, output: "first", durationMs: 1 };
      },
      loopIterationBudgetReservation: cancelledBudget.config,
    }).execute();
    expect(cancelled.state).toBe("completed");
    expect(cancelledRuns).toEqual(["first"]);
    expect(cancelledBudget.releases).toEqual([
      expect.objectContaining({ reason: "aborted", reservedCostCents: 8 }),
    ]);
    expect(cancelledBudget.settles).toEqual([]);
  });

  it("settles the final iteration before fail-closed exhaustion", async () => {
    const budget = host();
    const result = await new PipelineRuntime({
      definition: definition({ maxIterations: 1, onExhausted: "fail" }),
      predicates: { continue: () => true },
      nodeExecutor: async (nodeId) => ({ nodeId, output: "ok", durationMs: 1 }),
      loopIterationBudgetReservation: budget.config,
    }).execute();

    expect(result.state).toBe("failed");
    expect(result.error).toContain("maxIterations");
    expect(budget.settles).toHaveLength(1);
    expect(budget.releases).toEqual([]);
  });

  it("settles a terminal graph outcome before returning control", async () => {
    const loop = loopNode();
    loop.bodyGraph = {
      entryNodeId: "body",
      normalExitNodeIds: [],
      suspendedExitNodeIds: [],
      terminalExitNodeIds: ["body"],
      errorExitNodeIds: [],
    };
    const budget = host();
    const resume: LoopResumeOptions = {
      budgetMode: "strict",
      budgetRunId: "terminal-run",
      reserveIterationBudget: budget.config.reserve,
      settleIterationBudget: budget.config.settle,
      releaseIterationBudget: budget.config.release,
      reconcileIterationBudget: budget.config.reconcile,
      measureItemCost: budget.config.measureItemCost,
      scheduleBodyGraph: async () => ({
        outcome: { kind: "terminal", exitNodeId: "body" },
        state: "completed",
        bodyResults: new Map([
          ["body", { nodeId: "body", output: "done", durationMs: 1 }],
        ]),
        lastResult: { nodeId: "body", output: "done", durationMs: 1 },
        checkpointState: {
          completed: true,
          completedNodeIds: ["body"],
          nodeResults: {
            body: { nodeId: "body", output: "done", durationMs: 1 },
          },
          nodeIdempotencyKeys: { body: "terminal-run:body" },
          outcome: { kind: "terminal", exitNodeId: "body" },
        },
      }),
    };
    const result = await executeLoop(
      loop,
      BODY,
      okExecutor([]),
      { state: {}, previousResults: new Map() },
      { continue: () => true },
      undefined,
      resume
    );

    expect(result.control?.outcome.kind).toBe("terminal");
    expect(budget.settles).toHaveLength(1);
    expect(budget.releases).toEqual([]);
  });

  it("retains one suspension hold and settles it after resume without reserving twice", async () => {
    const loop = loopNode();
    loop.bodyGraph = {
      entryNodeId: "body",
      normalExitNodeIds: ["body"],
      suspendedExitNodeIds: ["body"],
      terminalExitNodeIds: [],
      errorExitNodeIds: [],
    };
    const budget = host({
      reconcile: () => ({ status: "reserved", reservedCostCents: 8 }),
    });
    const budgetCheckpoints: Array<{
      outcome: string;
      economics: {
        reservationId: string;
        reservedCostCents: number;
        settledCostCents?: number;
      };
    }> = [];
    const result = { nodeId: "body", output: "paused", durationMs: 1 };
    const suspendedFrame = {
      completed: false,
      completedNodeIds: ["body"],
      nodeResults: { body: result },
      nodeIdempotencyKeys: { body: "suspension-run:body" },
      outcome: { kind: "suspended" as const, exitNodeId: "body" },
    };
    const baseResume: LoopResumeOptions = {
      budgetMode: "strict",
      budgetRunId: "suspension-run",
      reserveIterationBudget: budget.config.reserve,
      settleIterationBudget: budget.config.settle,
      releaseIterationBudget: budget.config.release,
      reconcileIterationBudget: budget.config.reconcile,
      measureItemCost: budget.config.measureItemCost,
      onIterationBudgetCheckpoint: async (progress) => {
        budgetCheckpoints.push(progress);
      },
      scheduleBodyGraph: async () => ({
        outcome: { kind: "suspended", exitNodeId: "body" },
        state: "suspended",
        bodyResults: new Map([["body", result]]),
        lastResult: result,
        checkpointState: suspendedFrame,
      }),
    };
    const first = await executeLoop(
      loop,
      BODY,
      okExecutor([]),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      baseResume
    );

    expect(first.control?.outcome.kind).toBe("suspended");
    expect(budget.reserves).toHaveLength(1);
    expect(budget.settles).toEqual([]);
    expect(budget.releases).toEqual([]);
    expect(budgetCheckpoints.at(-1)).toMatchObject({
      outcome: "reserved",
      economics: {
        reservationId: "resv:v1:suspension-run:iteration:loop:1",
        reservedCostCents: 8,
      },
    });

    const resumedResult = {
      nodeId: "body",
      output: "done",
      durationMs: 1,
    };
    const resumed = await executeLoop(
      loop,
      BODY,
      okExecutor([]),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        ...baseResume,
        bodyGraphState: suspendedFrame,
        iterationOutcome: "running",
        iterationEconomics: budgetCheckpoints.at(-1)!.economics,
        scheduleBodyGraph: async () => ({
          outcome: { kind: "normal", exitNodeId: "body" },
          state: "completed",
          bodyResults: new Map([["body", resumedResult]]),
          lastResult: resumedResult,
          checkpointState: {
            completed: true,
            completedNodeIds: ["body"],
            nodeResults: { body: resumedResult },
            nodeIdempotencyKeys: { body: "suspension-run:body" },
            outcome: { kind: "normal", exitNodeId: "body" },
          },
        }),
      }
    );

    expect(resumed.result.error).toBeUndefined();
    expect(budget.reserves).toHaveLength(1);
    expect(budget.reconciles).toEqual([
      expect.objectContaining({
        boundary: "reserve",
        reservationId: "resv:v1:suspension-run:iteration:loop:1",
      }),
    ]);
    expect(budget.settles).toHaveLength(1);
    expect(budget.releases).toEqual([]);
  });
});

describe("predicate-loop acknowledgement loss and retained-byte reconciliation", () => {
  it("reconciles a settle acknowledgement loss without a duplicate settle", async () => {
    let settled = false;
    const budget = host({
      settle: () => {
        settled = true;
        throw new Error("settle acknowledgement lost");
      },
      reconcile: () =>
        settled
          ? { status: "settled", cost: { status: "known", costCents: 3 } }
          : { status: "reserved", reservedCostCents: 8 },
    });
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: async (nodeId) => ({ nodeId, output: "ok", durationMs: 1 }),
      loopIterationBudgetReservation: budget.config,
    }).execute();

    expect(result.state).toBe("completed");
    expect(budget.settles).toHaveLength(1);
    expect(budget.reconciles).toEqual([
      expect.objectContaining({ boundary: "settle", budgetCents: 10 }),
    ]);
  });

  it("reconciles a release acknowledgement loss without redispatch", async () => {
    let released = false;
    const budget = host({
      release: () => {
        released = true;
        throw new Error("release acknowledgement lost");
      },
      reconcile: () =>
        released
          ? { status: "released" }
          : { status: "reserved", reservedCostCents: 8 },
    });
    const runs: string[] = [];
    const result = await new PipelineRuntime({
      definition: definition(),
      predicates: { continue: () => false },
      nodeExecutor: async (nodeId) => {
        runs.push(nodeId);
        return {
          nodeId,
          output: null,
          durationMs: 1,
          error: "failed body",
        };
      },
      loopIterationBudgetReservation: budget.config,
    }).execute();

    expect(result.state).toBe("failed");
    expect(runs).toEqual(["body"]);
    expect(budget.releases).toHaveLength(1);
    expect(budget.reconciles).toEqual([
      expect.objectContaining({ boundary: "release" }),
    ]);
  });

  it("restores a body-complete hold, settles it, and dispatches no body node", async () => {
    const runId = "body-complete-resume";
    const reservationId = deriveIterationReservationId({
      runId,
      loopNodeId: "loop",
      iteration: 1,
    });
    const budget = host({
      reconcile: () => ({ status: "reserved", reservedCostCents: 8 }),
    });
    const runs: string[] = [];
    const resume: LoopResumeOptions = {
      startBodyNodeIndex: 1,
      bodyResults: {
        body: { nodeId: "body", output: "retained", durationMs: 1 },
      },
      iterationOutcome: "running",
      iterationEconomics: { reservationId, reservedCostCents: 8 },
      budgetMode: "strict",
      budgetRunId: runId,
      reserveIterationBudget: budget.config.reserve,
      settleIterationBudget: budget.config.settle,
      releaseIterationBudget: budget.config.release,
      reconcileIterationBudget: budget.config.reconcile,
      measureItemCost: budget.config.measureItemCost,
    };
    const result = await executeLoop(
      loopNode(),
      BODY,
      okExecutor(runs),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      resume
    );

    expect(result.result.error).toBeUndefined();
    expect(runs).toEqual([]);
    expect(budget.reserves).toEqual([]);
    expect(budget.reconciles).toEqual([
      expect.objectContaining({
        boundary: "settle",
        reservationId,
      }),
    ]);
    expect(budget.settles).toHaveLength(1);
  });

  it.each([
    {
      label: "foreign reservation",
      economics: { reservationId: "foreign", reservedCostCents: 8 },
    },
    {
      label: "over-ceiling checkpoint",
      economics: {
        reservationId: "resv:v1:foreign-byte-run:iteration:loop:1",
        reservedCostCents: 11,
      },
    },
  ])("rejects $label bytes before body or lifecycle dispatch", async ({ economics }) => {
    const budget = host();
    const runs: string[] = [];
    const result = await executeLoop(
      loopNode(),
      BODY,
      okExecutor(runs),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        iterationOutcome: "running",
        iterationEconomics: economics,
        budgetMode: "strict",
        budgetRunId: "foreign-byte-run",
        reserveIterationBudget: budget.config.reserve,
        settleIterationBudget: budget.config.settle,
        releaseIterationBudget: budget.config.release,
        reconcileIterationBudget: budget.config.reconcile,
        measureItemCost: budget.config.measureItemCost,
      }
    );

    expect(result.result.error).toMatch(/checkpoint|reservation|reserved cost/);
    expect(runs).toEqual([]);
    expect(budget.reserves).toEqual([]);
    expect(budget.settles).toEqual([]);
    expect(budget.releases).toEqual([]);
    expect(budget.reconciles).toEqual([]);
  });
});
