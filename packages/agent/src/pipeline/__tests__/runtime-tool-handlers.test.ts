import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  PipelineCheckpoint,
  PipelineDefinition,
  ToolNode,
} from "@dzupagent/core/pipeline";
import { InMemoryPipelineCheckpointStore } from "../in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  RuntimeToolHandler,
} from "../pipeline-runtime-types.js";
import {
  createRuntimeAjvValidationRunner,
  createRuntimeJsonSchemaValidationRunner,
  createRuntimeJsonSchemaValidationSuiteResolver,
  createRuntimeShellValidationCommandRunner,
  createRuntimeToolHandlers,
  createRuntimeValidationSuiteRegistry,
  createRuntimeValidatePort,
  createRuntimeZodValidationRunner,
  getRuntimeToolReadiness,
  runtimeToolFailure,
  runtimeShellAllowlistPresets,
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

  it("fails fast before resuming a checkpoint with missing runtime handlers", async () => {
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

    await expect(runtime.resume(makeCheckpoint())).rejects.toThrow(
      'Runtime tool handlers are not ready: missing handler for "dzup.runtime.adapter.run" used by node "adapter_0"',
    );
  });

  it("fails fast before redelivering a checkpoint after process restart", async () => {
    const checkpoint = makeCheckpoint();
    const checkpointStore = new InMemoryPipelineCheckpointStore();
    await checkpointStore.save(checkpoint);

    const runtime = new PipelineRuntime({
      definition: {
        ...makeRuntimeToolPipeline({
          id: "adapter_0",
          type: "tool",
          toolName: "dzup.runtime.adapter.run",
          arguments: { provider: "codex", instructions: "Run.", output: "result" },
        }),
        resume: { onProcessRestart: "redeliver_running" },
      },
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      checkpointStore,
      runtimeToolHandlers: {},
      runtimeToolReadiness: "fail_fast",
    });

    await expect(runtime.recoverAfterProcessRestart("run-1")).rejects.toThrow(
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

  it("runs allowed shell validate commands through the host shell runner", async () => {
    const command = `${process.execPath} -e "process.stdout.write('ok')"`;
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: {
          commands: [{ id: "node-ok", command }],
        },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          runCommand: createRuntimeShellValidationCommandRunner({
            allowCommands: [command],
          }),
        }),
      }),
    });

    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("validate_0")?.output).toMatchObject({
      valid: true,
      commandResults: [
        {
          id: "node-ok",
          command,
          ok: true,
          exitCode: 0,
          stdout: "ok",
        },
      ],
    });
  });

  it("denies shell validate commands that are not approved by policy", async () => {
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: {
          commands: [{ id: "blocked", command: "echo blocked" }],
        },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          runCommand: createRuntimeShellValidationCommandRunner(),
        }),
      }),
    });

    const result = await runtime.execute();
    const nodeResult = result.nodeResults.get("validate_0");

    expect(result.state).toBe("failed");
    expect(nodeResult?.errorMetadata).toMatchObject({
      code: "RUNTIME_VALIDATE_FAILED",
      failedCommandIds: ["blocked"],
    });
    expect(nodeResult?.output).toMatchObject({
      valid: false,
      commandResults: [
        {
          id: "blocked",
          command: "echo blocked",
          ok: false,
          error: "Runtime validation command denied by policy",
          metadata: { code: "RUNTIME_VALIDATE_COMMAND_DENIED" },
        },
      ],
    });
  });

  it("rejects shell validate commands that require shell metacharacter parsing", async () => {
    const command = `${process.execPath} -e "process.stdout.write('ok')" && ${process.execPath} -e "process.stdout.write('bad')"`;
    const runner = createRuntimeShellValidationCommandRunner({
      allowCommands: [command],
    });

    const result = await runner(
      { id: "compound", command },
      validateRequest({}),
    );

    expect(result).toMatchObject({
      id: "compound",
      command,
      ok: false,
      error: "Runtime validation command could not be parsed safely",
      metadata: { code: "RUNTIME_VALIDATE_COMMAND_UNSAFE" },
    });
  });

  it("preserves quoted shell validate arguments as single argv entries", async () => {
    const command = `${process.execPath} -e "process.stdout.write(process.argv[1] + '|' + process.argv[2])" "two words" "quoted ; literal"`;
    const runner = createRuntimeShellValidationCommandRunner({
      allowCommands: [command],
    });

    const result = await runner(
      { id: "quoted", command },
      validateRequest({}),
    );

    expect(result).toMatchObject({
      id: "quoted",
      command,
      ok: true,
      exitCode: 0,
      stdout: "two words|quoted ; literal",
    });
  });

  it("preserves explicit empty quoted shell validate arguments", async () => {
    const command = `${process.execPath} -e "process.stdout.write(String(process.argv.length) + ':' + JSON.stringify(process.argv.slice(1)))" "" "tail"`;
    const runner = createRuntimeShellValidationCommandRunner({
      allowCommands: [command],
    });

    const result = await runner(
      { id: "empty-quoted", command },
      validateRequest({}),
    );

    expect(result).toMatchObject({
      id: "empty-quoted",
      command,
      ok: true,
      exitCode: 0,
      stdout: '3:["","tail"]',
    });
  });

  it("keeps shell.run host-owned when no execution port is configured", async () => {
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "shell_0",
        type: "tool",
        toolName: "dzup.runtime.shell.run",
        arguments: {
          command: "yarn typecheck",
          output: "shellResult",
        },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({}),
    });

    const result = await runtime.execute();
    const nodeResult = result.nodeResults.get("shell_0");

    expect(result.state).toBe("failed");
    expect(nodeResult?.error).toBe(
      'No runtime execution port configured for "dzup.runtime.shell.run"',
    );
    expect(nodeResult?.errorMetadata).toEqual({
      code: "RUNTIME_PORT_MISSING",
      retryable: false,
      toolName: "dzup.runtime.shell.run",
    });
  });

  it("resolves schema validation suites and reports policy-specific schema errors", async () => {
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
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          resolveSuite: createRuntimeJsonSchemaValidationSuiteResolver({
            schemas: {
              "schema.review": {
                type: "object",
                required: ["status"],
              },
            },
          }),
          runCommand: createRuntimeJsonSchemaValidationRunner({
            schemas: {
              "schema.review": {
                type: "object",
                required: ["status"],
              },
            },
            validate: ({ data }) => ({
              ok:
                typeof data === "object" &&
                data !== null &&
                "status" in data,
              errors: ['missing required property "status"'],
            }),
            selectData: (request) => request.context.state,
          }),
        }),
      }),
    });

    const result = await runtime.execute({ title: "draft" });
    const nodeResult = result.nodeResults.get("validate_0");

    expect(result.state).toBe("failed");
    expect(nodeResult?.errorMetadata).toMatchObject({
      code: "RUNTIME_VALIDATE_FAILED",
      failedCommandIds: ["schema.review"],
      failedCommands: ["schema:schema.review"],
    });
    expect(nodeResult?.output).toMatchObject({
      valid: false,
      ref: "schema.review",
      commandResults: [
        {
          id: "schema.review",
          command: "schema:schema.review",
          ok: false,
          error: "JSON schema validation failed",
          metadata: {
            code: "RUNTIME_VALIDATE_SCHEMA_FAILED",
            schemaRef: "schema.review",
            errors: ['missing required property "status"'],
          },
        },
      ],
    });
  });

  it("resolves validation suites from an app registry example", async () => {
    const registry = createRuntimeValidationSuiteRegistry({
      suites: {
        "app.preflight": [
          { id: "typecheck", command: "yarn typecheck", kind: "shell" },
        ],
      },
    });
    const runtime = new PipelineRuntime({
      definition: makeRuntimeToolPipeline({
        id: "validate_0",
        type: "tool",
        toolName: "dzup.runtime.validate",
        arguments: { ref: "app.preflight" },
      }),
      nodeExecutor: async (nodeId) => ({
        nodeId,
        output: "fallback",
        durationMs: 1,
      }),
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: createRuntimeValidatePort({
          resolveSuite: registry.resolveSuite,
          runCommand: async (command) => ({ ...command, ok: true }),
        }),
      }),
    });

    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("validate_0")?.output).toMatchObject({
      valid: true,
      ref: "app.preflight",
      commandResults: [
        { id: "typecheck", command: "yarn typecheck", ok: true },
      ],
    });
  });

  it("provides Ajv-style and Zod schema validation runner adapters", async () => {
    const ajvRunner = createRuntimeAjvValidationRunner({
      schemas: {
        "review.schema": {
          type: "object",
          required: ["status"],
        },
      },
      ajv: {
        validate: (_schema, data) =>
          typeof data === "object" && data !== null && "status" in data,
        errors: [{ message: "must have required property status" }],
      },
    });
    const zodRunner = createRuntimeZodValidationRunner({
      schemas: {
        "review.zod": z.object({ status: z.literal("accepted") }),
      },
    });

    const ajvResult = await ajvRunner(
      { id: "review.schema", command: "schema:review.schema" },
      validateRequest({ title: "draft" }),
    );
    const zodResult = await zodRunner(
      { id: "review.zod", command: "schema:review.zod" },
      validateRequest({ status: "accepted" }),
    );

    expect(ajvResult).toMatchObject({
      id: "review.schema",
      command: "schema:review.schema",
      ok: false,
      metadata: {
        code: "RUNTIME_VALIDATE_SCHEMA_FAILED",
        schemaRef: "review.schema",
        errors: [{ message: "must have required property status" }],
      },
    });
    expect(zodResult).toMatchObject({
      id: "review.zod",
      command: "schema:review.zod",
      ok: true,
      metadata: { schemaRef: "review.zod" },
    });
  });

  it("provides shell allowlist presets for common package-manager checks", async () => {
    const runner = createRuntimeShellValidationCommandRunner(
      runtimeShellAllowlistPresets.yarnChecks(["yarn typecheck"]),
    );

    const denied = await runner(
      { id: "lint", command: "yarn lint" },
      validateRequest({}),
    );

    expect(denied).toMatchObject({
      id: "lint",
      command: "yarn lint",
      ok: false,
      error: "Runtime validation command denied by policy",
      metadata: { code: "RUNTIME_VALIDATE_COMMAND_DENIED" },
    });
  });
});

function makeCheckpoint(
  overrides: Partial<PipelineCheckpoint> = {},
): PipelineCheckpoint {
  return {
    pipelineRunId: "run-1",
    pipelineId: "runtime-tool-handler-test",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: [],
    state: {},
    createdAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

function validateRequest(
  state: Record<string, unknown>,
): Parameters<ReturnType<typeof createRuntimeJsonSchemaValidationRunner>>[1] {
  return {
    nodeId: "validate_0",
    arguments: {},
    ref: "review.schema",
    context: {
      state,
      previousResults: new Map(),
    },
  };
}
