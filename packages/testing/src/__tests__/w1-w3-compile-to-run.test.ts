import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlowCompiler } from "@dzupagent/flow-compiler";
import type { PipelineDefinition, ToolNode } from "@dzupagent/core/pipeline";
import {
  BUILT_IN_FRAGMENT_REGISTRY,
  createFragmentRegistry,
  parseDslToDocument,
  parseYamlSubset,
} from "@dzupagent/flow-dsl";
import {
  createRuntimeToolHandlers,
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  runtimeToolFailure,
  type NodeExecutor,
  type RuntimeToolHandler,
} from "@dzupagent/agent/pipeline";

const forEachAggregateFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../flow-dsl/src/__tests__/fixtures/golden-expansion/for-each-aggregate-export",
);

function readForEachAggregateFixture(fileName: string): string {
  return readFileSync(join(forEachAggregateFixtureDir, fileName), "utf8");
}

describe("W1 + W3 compile-to-run integration", () => {
  it("executes built-in sdlc.batch_validation through for_each.collect", async () => {
    const parsed = parseDslToDocument(
      `
dsl: dzupflow/v1
id: built-in-sdlc-batch-validation
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.batch_validation:
      id: batch
      itemsKey: validationItems
      output: validationStatuses
`,
      {
        fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
        requirePinnedFragmentUses: true,
      },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected built-in SDLC fragment to parse");

    const compiler = createFlowCompiler({
      toolResolver: {
        resolve(ref) {
          if (ref !== "validate.schema") return null;
          return {
            ref,
            kind: "skill",
            inputSchema: { type: "object" },
            handle: { skillId: ref },
          };
        },
        listAvailable: () => ["validate.schema"],
      },
    });
    const compiled = await compiler.compileDocument(parsed.document);
    expect("errors" in compiled).toBe(false);
    if ("errors" in compiled) throw new Error("expected compile success");
    expect(compiled.target).toBe("pipeline");

    const definition = compiled.artifact as PipelineDefinition;
    const result = await new PipelineRuntime({
      definition,
      runtimeToolHandlers: createRuntimeToolHandlers({
        validateSchema: async ({ context }) => {
          const item = context.state.validationItem as {
            id: string;
            result: "pass" | "fail";
            command: string;
          };
          return {
            output: {
              id: item.id,
              command: item.command,
              accepted: item.result === "pass",
              status: item.result,
            },
          };
        },
      }),
      nodeExecutor: async (nodeId, node) => ({
        nodeId,
        output: null,
        durationMs: 1,
        error: `unexpected fallback execution for ${node.type}`,
      }),
    }).execute({
      validationItems: [
        { id: "types", command: "yarn typecheck", result: "pass" },
        { id: "tests", command: "yarn test", result: "fail" },
      ],
    });

    expect(result.state).toBe("completed");
    const loopResult = [...result.nodeResults.values()].find((nodeResult) => {
      const output = nodeResult.output as { loopOutput?: unknown } | null;
      return output !== null && Array.isArray(output.loopOutput);
    });
    expect(loopResult?.output).toMatchObject({
      loopOutput: [
        {
          id: "types",
          command: "yarn typecheck",
          accepted: true,
          status: "pass",
        },
        {
          id: "tests",
          command: "yarn test",
          accepted: false,
          status: "fail",
        },
      ],
      metrics: {
        iterationCount: 2,
        converged: true,
        terminationReason: "condition_met",
      },
    });
  });

  it("executes the aggregate-export DSL fragment fixture through PipelineRuntime", async () => {
    const fragmentDefinitions = parseYamlSubset(
      readForEachAggregateFixture("fragments.yaml"),
    );
    expect(fragmentDefinitions.ok).toBe(true);
    if (!fragmentDefinitions.ok) throw new Error("expected fixture fragments to parse");

    const registry = createFragmentRegistry([
      fragmentDefinitions.value as Parameters<typeof createFragmentRegistry>[0][number],
    ]);
    const parsed = parseDslToDocument(readForEachAggregateFixture("invocation.yaml"), {
      fragmentRegistry: registry,
      requirePinnedFragmentUses: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected fixture invocation to parse");

    const compiler = createFlowCompiler({
      toolResolver: {
        resolve(ref) {
          if (ref !== "validate.schema") return null;
          return {
            ref,
            kind: "skill",
            inputSchema: { type: "object" },
            handle: { skillId: ref },
          };
        },
        listAvailable: () => ["validate.schema"],
      },
    });
    const compiled = await compiler.compileDocument(parsed.document);

    expect("errors" in compiled).toBe(false);
    if ("errors" in compiled) throw new Error("expected compile success");
    expect(compiled.target).toBe("pipeline");

    const definition = compiled.artifact as PipelineDefinition;
    const runtime = new PipelineRuntime({
      definition,
      runtimeToolHandlers: createRuntimeToolHandlers({
        validateSchema: async ({ context, output }) => {
          const item = context.state.validationItem as { id: string; result: string };
          return {
            output: {
              id: item.id,
              accepted: item.result === "pass",
              status: `${item.id}:${item.result}`,
            },
            metadata: { output },
          };
        },
      }),
      nodeExecutor: async (nodeId, node) => ({
        nodeId,
        output: null,
        durationMs: 1,
        error: `unexpected fallback execution for ${node.type}`,
      }),
    });

    const result = await runtime.execute({
      batch__validationItems: [
        { id: "schema", result: "pass" },
        { id: "tests", result: "fail" },
      ],
    });

    expect(result.state).toBe("completed");
    const loopResult = [...result.nodeResults.values()].find((nodeResult) => {
      const output = nodeResult.output as { loopOutput?: unknown } | null;
      return output !== null && Array.isArray(output.loopOutput);
    });
    expect(loopResult?.output).toMatchObject({
      loopOutput: [
        { id: "schema", accepted: true, status: "schema:pass" },
        { id: "tests", accepted: false, status: "tests:fail" },
      ],
      metrics: {
        iterationCount: 2,
        converged: true,
        terminationReason: "condition_met",
      },
    });
  });

  it("executes a durable planning-dag runtime tool with handler context and checkpointed idempotency", async () => {
    const compiler = createFlowCompiler({
      toolResolver: {
        resolve: () => null,
        listAvailable: () => [],
      },
    });

    const compiled = await compiler.compileDocument({
      dsl: "dzupflow/v1",
      id: "durable-runtime-validate",
      version: 1,
      durability: {
        mode: "durable",
        checkpoint: {
          strategy: "after_each_node",
          includeEvents: true,
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "validate",
            id: "validate-review",
            ref: "schema.review",
            idempotency: "exactly-once-required",
            effectClass: "db_write",
            meta: {
              mutation: {
                policy: "mutating",
                idempotencyKey: "review-validate",
              },
            },
          },
        ],
      },
    });

    expect("errors" in compiled).toBe(false);
    if ("errors" in compiled) throw new Error("expected compile success");
    expect(compiled.target).toBe("planning-dag");

    const definition = compiled.artifact as PipelineDefinition;
    const runtimeNode = definition.nodes[0] as ToolNode;
    expect(runtimeNode).toMatchObject({
      type: "tool",
      toolName: "dzup.runtime.validate",
      arguments: { ref: "schema.review" },
      declaredIdempotencyKey: "review-validate",
      idempotency: "exactly-once-required",
      effectClass: "db_write",
    });

    const fallbackExecutor = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      output: "fallback",
      durationMs: 1,
    }));
    const seen: {
      idempotencyKey?: string;
      arguments?: Record<string, unknown>;
      initialState?: Record<string, unknown>;
    } = {};
    const validateHandler = vi.fn<RuntimeToolHandler>(
      async ({ arguments: args, context }) => {
        seen.idempotencyKey = context.idempotencyKey;
        seen.arguments = args;
        seen.initialState = { ...context.state };
        return { valid: true, schemaRef: args.ref };
      },
    );
    const checkpointStore = new InMemoryPipelineCheckpointStore();

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: fallbackExecutor,
      checkpointStore,
      runtimeToolHandlers: {
        "dzup.runtime.validate": validateHandler,
      },
    });

    const result = await runtime.execute({ document: "draft" });

    expect(result.state).toBe("completed");
    expect(result.nodeResults.get(runtimeNode.id)?.output).toEqual({
      valid: true,
      schemaRef: "schema.review",
    });
    expect(fallbackExecutor).not.toHaveBeenCalled();
    expect(validateHandler).toHaveBeenCalledTimes(1);
    expect(seen.arguments).toEqual({ ref: "schema.review" });
    expect(seen.initialState).toEqual({ document: "draft" });
    expect(seen.idempotencyKey).toBe("dzup:v1:declared:review-validate");

    const checkpoint = await checkpointStore.load(result.runId);
    expect(checkpoint?.completedNodeIds).toEqual([runtimeNode.id]);
    expect(checkpoint?.nodeIdempotencyKeys).toEqual({
      [runtimeNode.id]: "dzup:v1:declared:review-validate",
    });
    expect(checkpoint?.events?.some((event) => event.type === "pipeline:node_completed")).toBe(
      true,
    );
  });

  it("executes a compiled prompt runtime node through the concrete prompt handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "prompt",
        userPrompt: "Collect requirements.",
        outputKey: "requirements",
        provider: "openai",
        model: "gpt-4.1",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        prompt: async ({ userPrompt, outputKey, provider, model }) => ({
          output: {
            text: `response:${userPrompt}`,
            outputKey,
            provider,
            model,
          },
          providerSessionRefs: [
            {
              provider: "openai",
              sessionId: "prompt-session",
              label: "prompt",
            },
          ],
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        requirements: {
          text: "response:Collect requirements.",
          outputKey: "requirements",
          provider: "openai",
          model: "gpt-4.1",
        },
      },
    ]);
    expect(firstRuntimeResult(result)?.providerSessionRefs).toEqual([
      {
        provider: "openai",
        sessionId: "prompt-session",
        label: "prompt",
      },
    ]);
  });

  it("executes a compiled worker.dispatch runtime node through the concrete worker handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "worker.dispatch",
        dispatchId: "review-change",
        provider: "codex",
        instructions: "Review the current diff.",
        outputKey: "workerReview",
        resultFormat: "json",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        workerDispatch: async ({ dispatchId, provider, instructions, resultFormat }) => ({
          output: {
            dispatchId,
            provider,
            instructions,
            resultFormat,
            accepted: true,
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        workerReview: {
          dispatchId: "review-change",
          provider: "codex",
          instructions: "Review the current diff.",
          resultFormat: "json",
          accepted: true,
        },
      },
    ]);
  });

  it("executes a compiled adapter.run runtime node through the concrete adapter handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "adapter.run",
        provider: "codex",
        instructions: "Discuss the architecture.",
        output: "adapterResult",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        adapterRun: async ({ provider, instructions, output }) => ({
          output: { provider, instructions, output, result: "accepted" },
          providerSessionRefs: [{ provider: "codex", sessionId: "run-session" }],
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        adapterResult: {
          provider: "codex",
          instructions: "Discuss the architecture.",
          output: "adapterResult",
          result: "accepted",
        },
      },
    ]);
    expect(firstRuntimeResult(result)?.providerSessionRefs).toEqual([
      { provider: "codex", sessionId: "run-session" },
    ]);
  });

  it("executes a compiled adapter.race runtime node through the concrete adapter handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "adapter.race",
        providers: ["claude", "codex"],
        instructions: "Compare approaches.",
        output: "raceResult",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        adapterRace: async ({ providers, instructions, output }) => ({
          output: {
            winner: providers[1],
            providers,
            instructions,
            output,
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        raceResult: {
          winner: "codex",
          providers: ["claude", "codex"],
          instructions: "Compare approaches.",
          output: "raceResult",
        },
      },
    ]);
  });

  it("executes a compiled adapter.parallel runtime node through the concrete adapter handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "adapter.parallel",
        providers: ["claude", "codex"],
        merge: "all",
        instructions: "Compare approaches.",
        output: "parallelResult",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        adapterParallel: async ({ providers, merge, instructions, output }) => ({
          output: {
            merge,
            outputs: Object.fromEntries(
              providers.map((provider) => [provider, `${provider}:${instructions}`]),
            ),
            output,
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        parallelResult: {
          merge: "all",
          outputs: {
            claude: "claude:Compare approaches.",
            codex: "codex:Compare approaches.",
          },
          output: "parallelResult",
        },
      },
    ]);
  });

  it("executes a compiled adapter.supervisor runtime node through the concrete adapter handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "adapter.supervisor",
        goal: "Review and improve the plan.",
        specialists: ["claude", "codex"],
        output: "supervisorResult",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        adapterSupervisor: async ({ goal, specialists, output }) => ({
          output: {
            goal,
            specialists,
            output,
            summary: "approved",
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        supervisorResult: {
          goal: "Review and improve the plan.",
          specialists: ["claude", "codex"],
          output: "supervisorResult",
          summary: "approved",
        },
      },
    ]);
  });

  it("executes a compiled shell.run runtime node through the concrete shell handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "shell.run",
        command: "yarn typecheck",
        output: "shellValidation",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        shellRun: async ({ command, output }) => ({
          output: {
            command,
            output,
            exitCode: 0,
            stdout: "typecheck passed",
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        shellValidation: {
          command: "yarn typecheck",
          output: "shellValidation",
          exitCode: 0,
          stdout: "typecheck passed",
        },
      },
    ]);
  });

  it("executes a compiled validate.schema runtime node through the concrete schema handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "validate.schema",
        source: "adapterResult",
        schema: "review.schema",
        output: "schemaValidation",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        validateSchema: async ({ source, schema, output, context }) => ({
          output: {
            source,
            schema,
            output,
            valid: context.state[source] === "accepted",
          },
        }),
      }),
      initialState: {
        adapterResult: "accepted",
      },
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([
      {
        adapterResult: "accepted",
        schemaValidation: {
          source: "adapterResult",
          schema: "review.schema",
          output: "schemaValidation",
          valid: true,
        },
      },
    ]);
  });

  it("executes a compiled validate runtime node through the concrete validation suite handler", async () => {
    const seenAtInspector: Record<string, unknown>[] = [];
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "validate",
        ref: "app.preflight",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        validate: async ({ ref }) => ({
          output: {
            valid: true,
            ref,
            commandResults: [
              { id: "typecheck", command: "yarn typecheck", ok: true },
            ],
          },
        }),
      }),
      inspectState: (state) => seenAtInspector.push({ ...state }),
    });

    expect(result.state).toBe("completed");
    expect(seenAtInspector).toEqual([{}]);
    expect(firstRuntimeResult(result)?.output).toEqual({
      valid: true,
      ref: "app.preflight",
      commandResults: [
        { id: "typecheck", command: "yarn typecheck", ok: true },
      ],
    });
  });

  it("surfaces compiled shell.run runtime handler failures as failed pipeline results", async () => {
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "shell.run",
        command: "yarn test",
        output: "shellValidation",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        shellRun: async ({ command, output }) =>
          runtimeToolFailure({
            message: "shell command failed",
            code: "RUNTIME_SHELL_RUN_FAILED",
            retryable: false,
            metadata: { command, output, exitCode: 1 },
          }),
      }),
      inspectState: () => {
        throw new Error("inspect node should not run after shell.run failure");
      },
    });

    const nodeResult = firstRuntimeResult(result);
    expect(result.state).toBe("failed");
    expect(nodeResult?.error).toBe("shell command failed");
    expect(nodeResult?.errorMetadata).toEqual({
      code: "RUNTIME_SHELL_RUN_FAILED",
      retryable: false,
      command: "yarn test",
      output: "shellValidation",
      exitCode: 1,
    });
  });

  it("surfaces compiled validate.schema runtime handler failures as failed pipeline results", async () => {
    const result = await compileAndRunSingleRuntimeNode({
      runtimeNode: {
        type: "validate.schema",
        source: "adapterResult",
        schema: "review.schema",
        output: "schemaValidation",
      },
      runtimeToolHandlers: createRuntimeToolHandlers({
        validateSchema: async ({ source, schema, output }) =>
          runtimeToolFailure({
            message: "schema validation failed",
            code: "RUNTIME_VALIDATE_SCHEMA_FAILED",
            retryable: false,
            metadata: { source, schema, output, failures: 2 },
          }),
      }),
      initialState: {
        adapterResult: "rejected",
      },
      inspectState: () => {
        throw new Error("inspect node should not run after validate.schema failure");
      },
    });

    const nodeResult = firstRuntimeResult(result);
    expect(result.state).toBe("failed");
    expect(nodeResult?.error).toBe("schema validation failed");
    expect(nodeResult?.errorMetadata).toEqual({
      code: "RUNTIME_VALIDATE_SCHEMA_FAILED",
      retryable: false,
      source: "adapterResult",
      schema: "review.schema",
      output: "schemaValidation",
      failures: 2,
    });
  });
});

type RuntimeLeafFixtureNode =
  | {
      type: "prompt";
      userPrompt: string;
      systemPrompt?: string;
      outputKey?: string;
      provider?: string;
      model?: string;
      tools?: boolean;
    }
  | {
      type: "worker.dispatch";
      dispatchId: string;
      provider: "claude" | "codex" | "gemini" | "qwen" | "goose" | "crush";
      instructions: string;
      outputKey: string;
      resultFormat?: "text" | "json";
    }
  | {
      type: "adapter.run";
      provider: "claude" | "codex" | "gemini" | "openai" | "openrouter" | "openrouter-crush" | "qwen" | "goose" | "crush";
      instructions: string;
      output: string;
    }
  | {
      type: "adapter.race";
      providers: Array<"claude" | "codex" | "gemini" | "qwen" | "goose" | "crush">;
      instructions: string;
      output: string;
    }
  | {
      type: "adapter.parallel";
      providers: Array<"claude" | "codex" | "gemini" | "qwen" | "goose" | "crush">;
      merge?: "first-wins" | "all" | "best-of-n";
      instructions: string;
      output: string;
    }
  | {
      type: "adapter.supervisor";
      goal: string;
      specialists?: string[];
      output: string;
    }
  | {
      type: "shell.run";
      command: string;
      output: string;
    }
  | {
      type: "validate.schema";
      source: string;
      schema: string | Record<string, unknown>;
      output: string;
    }
  | {
      type: "validate";
      ref: string;
    };

async function compileAndRunSingleRuntimeNode(options: {
  runtimeNode: RuntimeLeafFixtureNode;
  runtimeToolHandlers: ReturnType<typeof createRuntimeToolHandlers>;
  inspectState: (state: Record<string, unknown>) => void;
  initialState?: Record<string, unknown>;
}) {
  const compiler = createFlowCompiler({
    toolResolver: {
      resolve(ref) {
        if (ref !== "tasks.inspect") return null;
        return {
          ref,
          kind: "skill",
          inputSchema: { type: "object" },
          handle: {
            name: ref,
            description: "inspect runtime state",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            permissionLevel: "read",
            sideEffects: [],
            namespace: "tasks",
          },
        };
      },
      listAvailable: () => ["tasks.inspect"],
    },
  });

  const compiled = await compiler.compileDocument({
    dsl: "dzupflow/v1",
    id: `${options.runtimeNode.type}-compile-to-run`,
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        { id: "runtime-node", ...options.runtimeNode },
        {
          type: "action",
          id: "inspect-state",
          toolRef: "tasks.inspect",
          input: {},
        },
      ],
    },
  });

  expect("errors" in compiled).toBe(false);
  if ("errors" in compiled) throw new Error("expected compile success");
  expect(compiled.target).toBe("planning-dag");

  const definition = compiled.artifact as PipelineDefinition;
  const runtime = new PipelineRuntime({
    definition,
    runtimeToolHandlers: options.runtimeToolHandlers,
    nodeExecutor: async (nodeId, node, context) => {
      if (node.type === "tool" && node.toolName === "tasks.inspect") {
        options.inspectState(context.state);
        return { nodeId, output: { inspected: true }, durationMs: 1 };
      }
      return {
        nodeId,
        output: { unexpected: node.type },
        durationMs: 1,
        error: `unexpected fallback for ${nodeId}`,
      };
    },
  });

  return runtime.execute(options.initialState);
}

function firstRuntimeResult(
  result: Awaited<ReturnType<PipelineRuntime["execute"]>>,
) {
  return [...result.nodeResults.values()].find(
    (nodeResult) => nodeResult.nodeId !== "tasks.inspect",
  );
}
