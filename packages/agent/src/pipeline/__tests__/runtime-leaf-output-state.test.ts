/**
 * DSL-WP08: runtime-leaf output reaches state on the bare-executor path.
 *
 * When `PipelineRuntime` has no `runtimeToolHandlers`, the host's node
 * executor runs every `dzup.runtime.*` leaf. A successful output is written to
 * the same state key the handler path uses (`output` / `outputKey`, with
 * `prompt` falling back to the node id). Node `stateWrites` are applied after
 * that write and win on a shared key.
 */
import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
} from "../pipeline-runtime-types.js";
import { createRuntimeToolNodeExecutor } from "../tool-handlers/dispatcher.js";
import { runtimeLeafStateKey } from "../tool-handlers/ports.js";

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "runtime-leaf-output-state",
    name: "Runtime leaf output state",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      { id: "A", type: "tool", ...nodeA },
      { id: "B", type: "agent", agentId: "b1" },
    ],
    edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
  } as PipelineDefinition;
}

type Scripted = Omit<NodeResult, "nodeId" | "durationMs">;

async function run(nodeA: Record<string, unknown>, aResult: Scripted) {
  const calls: string[] = [];
  let seenByB: Record<string, unknown> | undefined;
  const executor: NodeExecutor = async (nodeId, _node, context) => {
    calls.push(nodeId);
    if (nodeId === "A") return { nodeId, durationMs: 1, ...aResult };
    seenByB = structuredClone(context.state);
    return { nodeId, durationMs: 1, output: { ok: nodeId } };
  };
  const runtime = new PipelineRuntime({
    definition: pipeline(nodeA),
    nodeExecutor: executor,
  });
  const result = await runtime.execute({ retained: "before" });
  return { result, calls, seenByB };
}

function context(): NodeExecutionContext {
  return { state: {}, previousResults: new Map() };
}

describe("runtimeLeafStateKey", () => {
  it("uses output, outputKey or the prompt node id", () => {
    for (const toolName of [
      "dzup.runtime.adapter.run",
      "dzup.runtime.adapter.race",
      "dzup.runtime.adapter.parallel",
      "dzup.runtime.adapter.supervisor",
      "dzup.runtime.shell.run",
      "dzup.runtime.validate.schema",
      "dzup.runtime.evidence.write",
    ]) {
      expect(runtimeLeafStateKey(toolName, { output: "out" }, "n")).toBe("out");
      expect(runtimeLeafStateKey(toolName, { outputKey: "k" }, "n")).toBeUndefined();
    }
    expect(
      runtimeLeafStateKey("dzup.runtime.worker.dispatch", { outputKey: "k" }, "n"),
    ).toBe("k");
    expect(
      runtimeLeafStateKey("dzup.runtime.prompt", { outputKey: "k" }, "n"),
    ).toBe("k");
    expect(runtimeLeafStateKey("dzup.runtime.prompt", {}, "n")).toBe("n");
  });

  it("returns undefined instead of throwing for missing or invalid keys", () => {
    for (const output of [undefined, "", 7, null, { key: "x" }]) {
      const args = output === undefined ? {} : { output, outputKey: output };
      expect(runtimeLeafStateKey("dzup.runtime.adapter.run", args, "n")).toBeUndefined();
      expect(
        runtimeLeafStateKey("dzup.runtime.worker.dispatch", args, "n"),
      ).toBeUndefined();
    }
    expect(
      runtimeLeafStateKey("dzup.runtime.validate", { output: "out" }, "n"),
    ).toBeUndefined();
    expect(runtimeLeafStateKey("dzup.runtime.set", { output: "out" }, "n")).toBeUndefined();
    expect(runtimeLeafStateKey("search", { output: "out" }, "n")).toBeUndefined();
  });
});

describe("PipelineRuntime runtime-leaf output on the bare executor", () => {
  it("writes a successful adapter.run output to arguments.output", async () => {
    const output = { text: "hi" };
    const { result, calls, seenByB } = await run(
      { toolName: "dzup.runtime.adapter.run", arguments: { output: "draft" } },
      { output },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
    expect(seenByB).toEqual({ retained: "before", draft: { text: "hi" } });
  });

  it("writes prompt output to its node id when outputKey is absent", async () => {
    const { seenByB } = await run(
      { toolName: "dzup.runtime.prompt", arguments: {} },
      { output: "answer" },
    );
    expect(seenByB).toEqual({ retained: "before", A: "answer" });
  });

  it("adds no key for a missing output or a non-runtime tool", async () => {
    const missing = await run(
      { toolName: "dzup.runtime.shell.run", arguments: {} },
      { output: "x" },
    );
    expect(missing.result.state).toBe("completed");
    expect(missing.seenByB).toEqual({ retained: "before" });

    const plain = await run(
      { toolName: "search", arguments: { output: "draft" } },
      { output: "x" },
    );
    expect(plain.result.state).toBe("completed");
    expect(plain.seenByB).toEqual({ retained: "before" });
  });

  it("lets stateWrites win over the leaf write on a shared key", async () => {
    const { result, seenByB } = await run(
      {
        toolName: "dzup.runtime.adapter.run",
        arguments: { output: "draft" },
        stateWrites: {
          bindings: [{ port: "draft", key: "draft", cardinality: "one" }],
        },
      },
      { output: { draft: "from-port" } },
    );
    expect(result.state).toBe("completed");
    expect(seenByB).toEqual({ retained: "before", draft: "from-port" });
  });

  it("does not write a failed result", async () => {
    const fallback = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      durationMs: 1,
      output: { partial: true },
      error: "boom",
    }));
    const executor = createRuntimeToolNodeExecutor(fallback, undefined);
    const ctx = context();
    const node = {
      id: "A",
      type: "tool",
      toolName: "dzup.runtime.adapter.run",
      arguments: { output: "draft" },
    } as const;
    const result = await executor("A", node as never, ctx);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(ctx.state).not.toHaveProperty("draft");
    expect(result).toEqual({
      nodeId: "A",
      durationMs: 1,
      output: { partial: true },
      error: "boom",
    });
  });

  it("keeps dzup.runtime.set in the runtime and off the fallback", async () => {
    const fallback = vi.fn<NodeExecutor>();
    const executor = createRuntimeToolNodeExecutor(fallback, undefined);
    const ctx = context();
    await executor(
      "A",
      {
        id: "A",
        type: "tool",
        toolName: "dzup.runtime.set",
        arguments: { assign: { flag: true } },
      } as never,
      ctx,
    );
    expect(ctx.state["flag"]).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });
});
