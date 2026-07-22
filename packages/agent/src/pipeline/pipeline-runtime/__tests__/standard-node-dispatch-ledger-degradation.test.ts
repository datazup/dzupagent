/**
 * ERR-M-08 — when the durable node ledger is unavailable, `dispatchStandardNode`
 * falls open to a synthetic lease so the run stays live. That disables the
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
import { defaultLogger } from "@dzupagent/core/utils";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
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
});
