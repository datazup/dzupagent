/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-SW1: exact-port state writes.
 *
 * When a top-level node succeeds and declares `stateWrites`, every bound
 * output port is validated first and then written to its state key together.
 * An invalid output fails the run without writing anything. Failed nodes and
 * nodes without the field keep today's behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  NodeLedgerLike,
  NodeResult,
} from "../pipeline-runtime-types.js";

const stateWrites = {
  bindings: [
    { port: "draft", key: "draft", cardinality: "one" },
    { port: "notes", key: "reviewNotes", cardinality: "optional" },
    { port: "tags", key: "tags", cardinality: "many" },
  ],
};

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "state-writes",
    name: "State writes",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      { id: "A", type: "agent", agentId: "a1", stateWrites, ...nodeA },
      { id: "B", type: "agent", agentId: "b1" },
    ],
    edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
  } as PipelineDefinition;
}

type Scripted = Omit<NodeResult, "nodeId" | "durationMs">;

async function run(
  aResult: Scripted,
  options: { nodeA?: Record<string, unknown>; nodeLedger?: NodeLedgerLike } = {},
) {
  const calls: string[] = [];
  let seenByB: Record<string, unknown> | undefined;
  const executor: NodeExecutor = async (nodeId, _node, context) => {
    calls.push(nodeId);
    if (nodeId === "A") return { nodeId, durationMs: 1, ...aResult };
    seenByB = structuredClone(context.state);
    return { nodeId, durationMs: 1, output: { ok: nodeId } };
  };
  const runtime = new PipelineRuntime({
    definition: pipeline(options.nodeA ?? {}),
    nodeExecutor: executor,
    ...(options.nodeLedger === undefined ? {} : { nodeLedger: options.nodeLedger }),
  });
  const result = await runtime.execute({ retained: "before" });
  return { result, calls, seenByB };
}

describe("PipelineRuntime stateWrites", () => {
  it("writes every bound port to its key and ignores unbound ports", async () => {
    const tags = ["a", "b"];
    const output = { draft: { text: "hi" }, notes: "ok", tags, extra: 1 };
    const { result, calls, seenByB } = await run({ output });
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
    expect(seenByB).toEqual({
      retained: "before",
      draft: { text: "hi" },
      reviewNotes: "ok",
      tags: ["a", "b"],
    });
  });

  it("skips a missing optional port", async () => {
    const { result, seenByB } = await run({ output: { draft: "d", tags: [] } });
    expect(result.state).toBe("completed");
    expect(seenByB).toEqual({ retained: "before", draft: "d", tags: [] });
  });

  it("writes clones, not the executor's own objects", async () => {
    const draft = { text: "hi" };
    const { seenByB } = await run({ output: { draft, tags: [] } });
    draft.text = "mutated";
    expect(seenByB?.["draft"]).toEqual({ text: "hi" });
  });

  it("fails the run and writes nothing when a required port is missing", async () => {
    const { result, calls } = await run({ output: { tags: ["a"] } });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^PIPELINE_STATE_WRITE_INVALID: node "A".*outputs\.draft/);
    expect(calls).toEqual(["A"]);
  });

  it("fails the run when a many port is not an array", async () => {
    const { result, calls } = await run({ output: { draft: "d", tags: "a" } });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^PIPELINE_STATE_WRITE_INVALID: .*outputs\.tags/);
    expect(calls).toEqual(["A"]);
  });

  it("fails the run when the output is not a plain object", async () => {
    for (const output of [null, "text", ["draft"]]) {
      const { result, calls } = await run({ output });
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(/^PIPELINE_STATE_WRITE_INVALID: node "A"/);
      expect(calls).toEqual(["A"]);
    }
  });

  it("writes nothing when the node fails and a catch continues", async () => {
    const { result, calls, seenByB } = await run(
      { output: { draft: "d", tags: [] }, error: "boom", errorMetadata: { code: "NOT_FOUND" } },
      {
        nodeA: {
          terminalCatch: { clauses: [{ errorCodes: ["NOT_FOUND"], action: "continue" }] },
        },
      },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
    expect(seenByB).toEqual({ retained: "before" });
  });

  it("applies the writes when a ledger replays the node", async () => {
    // Node A is dispatched first, so only the first lookup finds a completion.
    let lookups = 0;
    const ledger: NodeLedgerLike = {
      getByIdempotencyKey: vi.fn(async () =>
        lookups++ === 0
          ? ({ output: { draft: "replayed", tags: ["r"] } } as never)
          : undefined,
      ),
      acquire: vi.fn(async () => ({ owner: "w", fenceToken: 1 }) as never),
      heartbeat: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const { result, calls, seenByB } = await run({ output: {} }, { nodeLedger: ledger });
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["B"]);
    expect(seenByB).toEqual({ retained: "before", draft: "replayed", tags: ["r"] });
  });

  it("leaves nodes without stateWrites unchanged", async () => {
    const { result, seenByB } = await run(
      { output: { draft: "d" } },
      { nodeA: { stateWrites: undefined } },
    );
    expect(result.state).toBe("completed");
    expect(seenByB).toEqual({ retained: "before" });
  });
});
