import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition, ToolNode } from "@dzupagent/core/pipeline";
import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  RuntimeToolHandler,
} from "../pipeline-runtime-types.js";

function makeRuntimeToolPipeline(node: ToolNode): PipelineDefinition {
  return {
    id: "runtime-tool-handler-test",
    name: "Runtime Tool Handler Test",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: node.id,
    nodes: [node],
    edges: [],
  };
}

describe("PipelineRuntime runtime tool handlers", () => {
  it("executes registered dzup.runtime tool handlers with lowered arguments and runtime context", async () => {
    const fallbackExecutor = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      output: "fallback",
      durationMs: 1,
    }));
    const handler = vi.fn<RuntimeToolHandler>(async ({ arguments: args, context }) => {
      expect(args).toEqual({ ref: "schema.review" });
      expect(context.state).toEqual({ input: "draft" });
      expect(context.previousResults.size).toBe(0);
      return { ok: true, ref: args.ref };
    });

    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: { ref: "schema.review" },
      }),
      nodeExecutor: fallbackExecutor,
      runtimeToolHandlers: {
        "dzup.runtime.validate": handler,
      },
    });

    const result = await runtime.execute({ input: "draft" });

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("validate_0")?.output).toEqual({
      ok: true,
      ref: "schema.review",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fallbackExecutor).not.toHaveBeenCalled();
  });

  it("fails clearly when a configured runtime-tool registry lacks a namespaced handler", async () => {
    const fallbackExecutor = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      output: "fallback",
      durationMs: 1,
    }));

    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "adapter_0",
        type: "tool",
        toolName: "dzup.runtime.adapter.run",
        arguments: { provider: "mock" },
      }),
      nodeExecutor: fallbackExecutor,
      runtimeToolHandlers: {},
    });

    const result = await runtime.execute();

    expect(result.state).toBe("failed");
    expect(result.nodeResults.get("adapter_0")?.error).toBe(
      'No runtime tool handler registered for "dzup.runtime.adapter.run"',
    );
    expect(fallbackExecutor).not.toHaveBeenCalled();
  });

  it("leaves non-runtime tool nodes on the configured nodeExecutor path", async () => {
    const fallbackExecutor = vi.fn<NodeExecutor>(async (nodeId, node) => ({
      nodeId,
      output: { type: node.type },
      durationMs: 1,
    }));

    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "tool_0",
        type: "tool",
        toolName: "regular.tool",
        arguments: { value: 1 },
      }),
      nodeExecutor: fallbackExecutor,
      runtimeToolHandlers: {},
    });

    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("tool_0")?.output).toEqual({ type: "tool" });
    expect(fallbackExecutor).toHaveBeenCalledTimes(1);
  });
});
