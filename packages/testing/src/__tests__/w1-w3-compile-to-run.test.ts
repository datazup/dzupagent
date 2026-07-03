import { describe, expect, it, vi } from "vitest";
import { createFlowCompiler } from "@dzupagent/flow-compiler";
import type { PipelineDefinition, ToolNode } from "@dzupagent/core/pipeline";
import {
  createRuntimeToolHandlers,
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type NodeExecutor,
  type RuntimeToolHandler,
} from "@dzupagent/agent/pipeline";

describe("W1 + W3 compile-to-run integration", () => {
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
    };

async function compileAndRunSingleRuntimeNode(options: {
  runtimeNode: RuntimeLeafFixtureNode;
  runtimeToolHandlers: ReturnType<typeof createRuntimeToolHandlers>;
  inspectState: (state: Record<string, unknown>) => void;
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

  return runtime.execute();
}

function firstRuntimeResult(
  result: Awaited<ReturnType<PipelineRuntime["execute"]>>,
) {
  return [...result.nodeResults.values()].find(
    (nodeResult) => nodeResult.nodeId !== "tasks.inspect",
  );
}
