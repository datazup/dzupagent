import type { SubagentSpec, TaskId } from "../contracts/background-task.js";
import type { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";
import { createFanoutTemplateTool } from "./fanout-tool.js";
import type { FanoutToolConfig } from "./fanout-tool.js";

/**
 * Provider-neutral tool descriptor. Hosts adapt these to their concrete tool
 * type (`StructuredToolInterface`, `DomainToolDefinition`, …). Keeping the shape
 * minimal preserves the package's layer-2 portability — it does not depend on any
 * particular tool framework.
 */
export interface SubagentToolDescriptor<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  description: string;
  /** JSON-schema-ish parameter description for host binding/validation. */
  parameters: Record<string, unknown>;
  invoke(args: TArgs): Promise<TResult>;
}

export interface SubagentToolsConfig {
  runtime: BackgroundSubagentRuntime;
  /**
   * Resolves the parent run id for the current tool invocation. Hosts wire this
   * to their request/run context so spawned tasks are attributed correctly.
   */
  resolveParentRunId: () => string;
  /**
   * Optional tuning for the `fanout_template` tool (batch-id generation,
   * limits, clock, and an optional durable batch ledger). The tool itself is
   * always included; these only tune it.
   */
  fanout?: Pick<
    FanoutToolConfig,
    "generateBatchId" | "limits" | "clock" | "fanoutBatchStore"
  >;
}

/**
 * Build the five LLM-facing subagent tools: the four single-task tools plus
 * the `fanout_template` batch tool. Each delegates to the runtime and returns
 * plain serialisable results so the model can reason about them.
 */
export function createSubagentTools(
  config: SubagentToolsConfig,
): SubagentToolDescriptor[] {
  const { runtime, resolveParentRunId } = config;

  const spawn: SubagentToolDescriptor<{
    agentId: string;
    input: string | Record<string, unknown>;
    instructions?: string;
    ttlMs?: number;
  }> = {
    name: "spawn_subagent",
    description:
      "Spawn a background subagent to work on a task asynchronously. Returns a taskId immediately; the subagent runs concurrently. Use check_subagent/await_subagent to retrieve the result.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Which agent to dispatch." },
        input: { description: "The task input for the subagent." },
        instructions: {
          type: "string",
          description: "Optional instruction override.",
        },
        ttlMs: {
          type: "number",
          description: "Optional time-to-live in milliseconds.",
        },
      },
      required: ["agentId", "input"],
    },
    invoke: async (args) => {
      const spec: SubagentSpec = {
        agentId: args.agentId,
        input: args.input,
        ...(args.instructions !== undefined
          ? { instructions: args.instructions }
          : {}),
      };
      const outcome = await runtime.spawn(
        spec,
        resolveParentRunId(),
        args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {},
      );
      return outcome;
    },
  };

  const check: SubagentToolDescriptor<{ taskId: TaskId }> = {
    name: "check_subagent",
    description:
      "Check the current status (and result, if finished) of a previously spawned background subagent without blocking.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    invoke: async ({ taskId }) => {
      // SEC-M-04: scope the lookup to the caller's run so one run cannot read
      // another run's task by supplying its taskId.
      const task = await runtime.check(taskId, {
        parentRunId: resolveParentRunId(),
      });
      if (!task) {
        return { found: false };
      }
      return {
        found: true,
        status: task.status,
        result: task.result,
        error: task.error,
      };
    },
  };

  const await_: SubagentToolDescriptor<{ taskId: TaskId; timeoutMs?: number }> =
    {
      name: "await_subagent",
      description:
        "Wait for a background subagent to finish (up to an optional timeout), then return its final status and result.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          timeoutMs: {
            type: "number",
            description: "Optional max wait in milliseconds.",
          },
        },
        required: ["taskId"],
      },
      invoke: async ({ taskId, timeoutMs }) => {
        // SEC-M-04: ownership-scoped await; a foreign taskId resolves to null.
        const task = await runtime.await(
          taskId,
          timeoutMs !== undefined ? { timeoutMs } : {},
          { parentRunId: resolveParentRunId() },
        );
        if (!task) {
          return { found: false };
        }
        return {
          found: true,
          status: task.status,
          result: task.result,
          error: task.error,
        };
      },
    };

  const cancel: SubagentToolDescriptor<{ taskId: TaskId }> = {
    name: "cancel_subagent",
    description: "Cancel a running or pending background subagent.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    invoke: async ({ taskId }) => {
      // SEC-M-04: ownership-scoped cancel; a foreign taskId is a no-op (not_found).
      const task = await runtime.cancel(taskId, {
        parentRunId: resolveParentRunId(),
      });
      return { status: task?.status ?? "not_found" };
    },
  };

  const fanout = createFanoutTemplateTool({
    runtime,
    resolveParentRunId,
    ...config.fanout,
  });

  return [spawn, check, await_, cancel, fanout];
}
