/**
 * ERR-M-08 — when the durable node ledger is unavailable, `dispatchStandardNode`
 * may fall open for weaker policies so the run stays live. That disables the
 * exactly-once safety net for the node (a retried run could double-execute a
 * side-effecting node), so the degradation MUST be surfaced loudly rather than
 * silently swallowed.
 *
 * These tests drive the full PipelineRuntime (dispatch is internal) with a
 * ledger whose `getByIdempotencyKey` rejects, and assert:
 *   - the node still executes (fail-open liveness preserved), and
 *   - a structured warn is logged with the degradation context.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PipelineRuntime } from "../../pipeline-runtime.js";
import { CrossRunReplayError } from "../node-ledger-integration.js";
import { defaultLogger } from "@dzupagent/core/utils";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type {
  NodeExecutor,
  NodeLedgerLike,
} from "../../pipeline-runtime-types.js";

const NODE: PipelineNode = {
  id: "n1",
  type: "transform",
} as PipelineNode;

function singleNode(node: PipelineNode): PipelineDefinition {
  return {
    id: "err-m-08-pipeline",
    name: "ERR-M-08 Ledger Degradation Test",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: node.id,
    nodes: [node],
    edges: [],
  };
}

/** A ledger that fails on the very first read `beginNodeUnderLedger` performs. */
function rejectingLedger(err: Error): NodeLedgerLike {
  return {
    getByIdempotencyKey: vi.fn().mockRejectedValue(err),
    acquire: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}

describe("dispatchStandardNode — node ledger begin failure (ERR-M-08)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a structured warn and still executes the node when the ledger begin throws", async () => {
    const warnSpy = vi
      .spyOn(defaultLogger, "warn")
      .mockImplementation(() => {});

    const ledgerError = new Error("redis ECONNREFUSED");
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: "n1",
      output: { ok: true },
      durationMs: 1,
    });

    const runtime = new PipelineRuntime({
      definition: singleNode(NODE),
      nodeExecutor: executor,
      nodeLedger: rejectingLedger(ledgerError),
    });

    const result = await runtime.execute();

    // Fail-open liveness: the run completes and the node ran exactly once.
    expect(result.state).toBe("completed");
    expect(executor).toHaveBeenCalledTimes(1);

    // The degradation was surfaced loudly with the expected structured context.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, context] = warnSpy.mock.calls[0]!;
    expect(context).toMatchObject({
      operation: "node.ledger.begin",
      nodeId: "n1",
      error: String(ledgerError),
      effect: "idempotency_disabled_for_node",
    });
    expect((context as { runId?: unknown }).runId).toBe(result.runId);
  });

  it("degrade-open is still the behavior when the policy is set explicitly", async () => {
    vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: "n1",
      output: { ok: true },
      durationMs: 1,
    });

    const result = await new PipelineRuntime({
      definition: singleNode(NODE),
      nodeExecutor: executor,
      nodeLedger: rejectingLedger(new Error("redis ECONNREFUSED")),
      ledgerUnavailablePolicy: "degrade-open",
    }).execute();

    expect(result.state).toBe("completed");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('E2: under "strict", an unreachable ledger fails the node instead of running it', async () => {
    const errorSpy = vi
      .spyOn(defaultLogger, "error")
      .mockImplementation(() => {});
    const ledgerError = new Error("redis ECONNREFUSED");
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: "n1",
      output: { ok: true },
      durationMs: 1,
    });

    const result = await new PipelineRuntime({
      definition: singleNode(NODE),
      nodeExecutor: executor,
      nodeLedger: rejectingLedger(ledgerError),
      ledgerUnavailablePolicy: "strict",
    }).execute();

    expect(result.state).toBe("failed");
    // The point of strict: the side effect never runs without the safety net.
    expect(executor).not.toHaveBeenCalled();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, context] = errorSpy.mock.calls[0]!;
    expect(context).toMatchObject({
      operation: "node.ledger.begin",
      nodeId: "n1",
      error: String(ledgerError),
      effect: "node_failed_ledger_unavailable",
      policy: "strict",
    });
  });

  it.each(["degrade-open", undefined] as const)(
    "a cross-run replay refusal fails the node closed even under policy %s",
    async (policy) => {
      const errorSpy = vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
      // A reachable ledger holding run-1's completion for this node's key.
      const ledger: NodeLedgerLike = {
        getByIdempotencyKey: vi.fn().mockResolvedValue({ runId: "run-1", output: { charged: "run-1" } }),
        acquire: vi.fn().mockResolvedValue(null),
        heartbeat: vi.fn().mockResolvedValue(true),
        complete: vi.fn().mockResolvedValue(undefined),
        fail: vi.fn().mockResolvedValue(undefined),
      };
      const executor = vi.fn<NodeExecutor>().mockResolvedValue({ nodeId: "n1", output: { ok: true }, durationMs: 1 });

      const result = await new PipelineRuntime({
        definition: singleNode(NODE),
        nodeExecutor: executor,
        nodeLedger: ledger,
        ...(policy !== undefined ? { ledgerUnavailablePolicy: policy } : {}),
      }).execute();

      expect(result.state).toBe("failed");
      expect(executor).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [, context] = errorSpy.mock.calls[0]!;
      expect(context).toMatchObject({
        operation: "node.ledger.begin",
        nodeId: "n1",
        effect: "node_failed_cross_run_replay",
        policy: "fail-closed",
      });
      expect(String((context as { error?: unknown }).error)).toContain(new CrossRunReplayError("k", "run-1", "x").name);
    },
  );
});

describe("exactly-once-required ledger admission", () => {
  afterEach(() => vi.restoreAllMocks());

  describe.each([undefined, "degrade-open", "strict"] as const)(
    "outage policy %s",
    (policy) => {
      it.each(["lookup", "acquire"] as const)(
        "refuses a failed %s before executor or settlement calls",
        async (operation) => {
          const warn = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
          vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
          const error = new Error("ledger unavailable");
          const ledger = rejectingLedger(error);
          if (operation === "acquire") {
            vi.mocked(ledger.getByIdempotencyKey).mockResolvedValue(undefined);
            vi.mocked(ledger.acquire).mockRejectedValue(error);
          }
          const executor = vi.fn<NodeExecutor>().mockResolvedValue({
            nodeId: NODE.id, output: { charged: true }, durationMs: 1,
          });
          const result = await new PipelineRuntime({
            definition: singleNode({ ...NODE, idempotency: "exactly-once-required" }),
            nodeExecutor: executor,
            nodeLedger: ledger,
            ...(policy === undefined ? {} : { ledgerUnavailablePolicy: policy }),
          }).execute();

          expect(result.state).toBe("failed");
          expect(result.error).toContain("required durable ledger lease");
          expect(executor).not.toHaveBeenCalled();
          expect(warn).not.toHaveBeenCalled();
          expect(ledger.acquire).toHaveBeenCalledTimes(operation === "acquire" ? 1 : 0);
          expect(ledger.heartbeat).not.toHaveBeenCalled();
          expect(ledger.complete).not.toHaveBeenCalled();
          expect(ledger.fail).not.toHaveBeenCalled();
        },
      );

      it.each([
        { label: "busy", lease: null },
        { label: "missing", lease: undefined },
        { label: "empty", lease: {} },
        { label: "empty owner", lease: { owner: "", fenceToken: 1 } },
        { label: "invalid fence", lease: { owner: "fixed-run", fenceToken: 0 } },
      ])("refuses a $label acquisition", async ({ lease }) => {
        vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
        vi.spyOn(defaultLogger, "error").mockImplementation(() => {});
        const ledger = rejectingLedger(new Error("unused"));
        vi.mocked(ledger.getByIdempotencyKey).mockResolvedValue(undefined);
        vi.mocked(ledger.acquire).mockResolvedValue(lease);
        const executor = vi.fn<NodeExecutor>();
        const result = await new PipelineRuntime({
          definition: singleNode({ ...NODE, idempotency: "exactly-once-required" }),
          nodeExecutor: executor,
          nodeLedger: ledger,
          ...(policy === undefined ? {} : { ledgerUnavailablePolicy: policy }),
        }).execute({}, { runId: "fixed-run" });

        expect(result.state).toBe("failed");
        expect(executor).not.toHaveBeenCalled();
        expect(ledger.heartbeat).not.toHaveBeenCalled();
        expect(ledger.complete).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["at-least-once", "idempotent"] as const)(
    "%s can explicitly degrade without fabricating a lease",
    async (idempotency) => {
      vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
      const ledger = rejectingLedger(new Error("ledger unavailable"));
      const executor = vi.fn<NodeExecutor>().mockResolvedValue({
        nodeId: NODE.id, output: "ok", durationMs: 1,
      });
      const result = await new PipelineRuntime({
        definition: singleNode({ ...NODE, idempotency }),
        nodeExecutor: executor,
        nodeLedger: ledger,
        ledgerUnavailablePolicy: "degrade-open",
      }).execute();

      expect(result.state).toBe("completed");
      expect(executor).toHaveBeenCalledTimes(1);
      expect(ledger.heartbeat).not.toHaveBeenCalled();
      expect(ledger.complete).not.toHaveBeenCalled();
      expect(ledger.fail).not.toHaveBeenCalled();
    },
  );
});
