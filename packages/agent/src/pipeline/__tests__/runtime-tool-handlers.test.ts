import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition, ToolNode } from "@dzupagent/core/pipeline";
import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  RuntimeToolHandler,
} from "../pipeline-runtime-types.js";
import {
  createRuntimeToolHandlers,
  createRuntimeValidatePort,
  getRuntimeToolReadiness,
  runtimeToolFailure,
  runtimeToolSuccess,
} from "../runtime-tool-handlers.js";

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

  it("unwraps structured runtime-tool success envelopes into node results", async () => {
    const handler = vi.fn<RuntimeToolHandler>(async () =>
      runtimeToolSuccess({
        output: { text: "ok" },
        providerSessionRefs: [
          {
            provider: "openai",
            sessionId: "sess-1",
            label: "prompt",
            metadata: { threadId: "thread-1" },
          },
        ],
      }),
    );

    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "prompt_0",
        type: "tool",
        toolName: "dzup.runtime.prompt",
        arguments: { userPrompt: "Summarize." },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: {
        "dzup.runtime.prompt": handler,
      },
    });

    const result = await runtime.execute();
    const nodeResult = result.nodeResults.get("prompt_0");

    expect(result.state).toBe("completed");
    expect(nodeResult?.output).toEqual({ text: "ok" });
    expect(nodeResult?.providerSessionRefs).toEqual([
      {
        provider: "openai",
        sessionId: "sess-1",
        label: "prompt",
        metadata: { threadId: "thread-1" },
      },
    ]);
  });

  it("unwraps structured runtime-tool failure envelopes into node errors", async () => {
    const handler = vi.fn<RuntimeToolHandler>(async () =>
      runtimeToolFailure({
        message: "schema validation failed",
        code: "VALIDATION_FAILED",
        retryable: false,
        metadata: { schemaRef: "schema.review", failures: 2 },
      }),
    );

    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: { ref: "schema.review" },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: {
        "dzup.runtime.validate": handler,
      },
    });

    const result = await runtime.execute();
    const nodeResult = result.nodeResults.get("validate_0");

    expect(result.state).toBe("failed");
    expect(nodeResult?.error).toBe("schema validation failed");
    expect(nodeResult?.errorMetadata).toEqual({
      code: "VALIDATION_FAILED",
      retryable: false,
      schemaRef: "schema.review",
      failures: 2,
    });
  });

  it("reports missing runtime tool handlers before execution", () => {
    const definition = makeRuntimeToolPipeline({
      id: "adapter_0",
      type: "tool",
      toolName: "dzup.runtime.adapter.run",
      arguments: { provider: "codex", instructions: "Run.", output: "result" },
    });

    expect(getRuntimeToolReadiness(definition, {})).toEqual({
      ready: false,
      requiredToolNames: ["dzup.runtime.adapter.run"],
      missingToolNames: ["dzup.runtime.adapter.run"],
      nodes: [
        {
          nodeId: "adapter_0",
          toolName: "dzup.runtime.adapter.run",
          ready: false,
        },
      ],
    });
  });

  it("fails fast on missing runtime handlers when configured", async () => {
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "adapter_0",
        type: "tool",
        toolName: "dzup.runtime.adapter.run",
        arguments: { provider: "codex", instructions: "Run.", output: "result" },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: {},
      runtimeToolReadiness: "fail_fast",
    });

    await expect(runtime.execute()).rejects.toThrow(
      'Runtime tool handlers are not ready: missing handler for "dzup.runtime.adapter.run" used by node "adapter_0"',
    );
  });

  it("runs validate commands through the concrete validate port", async () => {
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: {
          commands: [
            { id: "typecheck", command: "yarn typecheck" },
            { id: "test", command: "yarn test" },
          ],
        },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          runCommand: async ({ id, command }) => ({
            id,
            command,
            ok: true,
            exitCode: 0,
            stdout: `${command}: ok`,
          }),
        }),
      }),
    });

    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("validate_0")?.output).toEqual({
      valid: true,
      ref: undefined,
      commandResults: [
        {
          id: "typecheck",
          command: "yarn typecheck",
          ok: true,
          exitCode: 0,
          stdout: "yarn typecheck: ok",
          durationMs: expect.any(Number),
        },
        {
          id: "test",
          command: "yarn test",
          ok: true,
          exitCode: 0,
          stdout: "yarn test: ok",
          durationMs: expect.any(Number),
        },
      ],
    });
  });

  it("turns validate command failures into structured runtime errors", async () => {
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: {
          ref: "suite.ci",
          commands: [{ id: "test", command: "yarn test" }],
        },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          runCommand: async ({ id, command }) => ({
            id,
            command,
            ok: false,
            exitCode: 1,
            stderr: "1 failed",
          }),
        }),
      }),
    });

    const result = await runtime.execute();
    const nodeResult = result.nodeResults.get("validate_0");

    expect(result.state).toBe("failed");
    expect(nodeResult?.error).toBe("Runtime validation failed");
    expect(nodeResult?.errorMetadata).toEqual({
      code: "RUNTIME_VALIDATE_FAILED",
      retryable: false,
      ref: "suite.ci",
      failedCommandIds: ["test"],
      failedCommands: ["yarn test"],
    });
    expect(nodeResult?.output).toEqual({
      valid: false,
      ref: "suite.ci",
      commandResults: [
        {
          id: "test",
          command: "yarn test",
          ok: false,
          exitCode: 1,
          stderr: "1 failed",
          durationMs: expect.any(Number),
        },
      ],
    });
  });
});
