/**
 * Wrap a DzupAgent as a LangChain StructuredTool so it can be invoked
 * as a sub-tool by a parent agent.
 *
 * Extracted from DzupAgent.asTool() so the agent-as-tool surface can
 * evolve (schema shape, naming conventions, description overrides)
 * without churning the core DzupAgent class.
 */

import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { GenerateOptions, GenerateResult } from "../agent/agent-types.js";

/**
 * Default ceiling on cross-agent `asTool` recursion depth.
 *
 * AGENT-M-14 — the in-process `agentAsTool` path is distinct from the
 * subagent-runtime `maxSpawnDepth` guard (which bounds *spawn*, not the
 * in-process `asTool` call chain). Without a depth ceiling, an agent that
 * exposes itself (or a mutually-referential A↔B pair) can recurse without
 * bound and exhaust memory/cost. This is the safe default when the caller
 * does not override it.
 */
export const DEFAULT_MAX_AGENT_TOOL_DEPTH = 3;

/** Narrow surface an agent must expose to be wrappable as a tool. */
export interface AgentAsToolContext {
  id: string;
  description: string;
  generate: (
    messages: BaseMessage[],
    options?: GenerateOptions
  ) => Promise<GenerateResult>;
  /**
   * Depth-propagation options (AGENT-M-14). Optional so existing callers keep
   * working; when omitted the guard uses {@link DEFAULT_MAX_AGENT_TOOL_DEPTH}
   * and a private counter that still bounds direct self-reference.
   */
  depth?: {
    /**
     * Maximum allowed cross-agent `asTool` call depth. Once the incoming
     * depth reaches this value the tool short-circuits instead of invoking
     * the wrapped agent again.
     */
    maxAgentToolDepth?: number;
    /**
     * Returns the current cross-agent `asTool` depth for the wrapping agent's
     * live run. Threaded by {@link AgentAsToolContext} so that depth
     * accumulates across nested `asTool` invocations (self-reference and
     * mutually-referential A↔B loops alike) rather than resetting per tool
     * instance.
     */
    current?: () => number;
  };
}

/**
 * Wrap the given agent as a LangChain structured tool. The resulting tool
 * accepts `{ task, context? }` and returns the agent's final response
 * string.
 *
 * Dynamic imports are used for `zod` and `@langchain/core/tools` to keep
 * the top-level import graph free of peer-dep hard requirements — mirrors
 * the original `DzupAgent.asTool()` behaviour exactly.
 *
 * AGENT-M-14 — every invocation reads the wrapping agent's current
 * cross-agent `asTool` depth, rejects once it reaches the configured ceiling,
 * and otherwise propagates an incremented depth into the wrapped
 * `generate()` via {@link GenerateOptions._agentToolDepth}. This bounds the
 * in-process recursion that is otherwise unguarded by the spawn-side
 * `maxSpawnDepth`.
 */
export async function agentAsTool(
  ctx: AgentAsToolContext
): Promise<StructuredToolInterface> {
  const { z } = await import("zod");
  const { tool } = await import("@langchain/core/tools");
  const { HumanMessage } = await import("@langchain/core/messages");

  const maxDepth = ctx.depth?.maxAgentToolDepth ?? DEFAULT_MAX_AGENT_TOOL_DEPTH;
  // Fallback counter: bounds direct self-reference even when the caller does
  // not thread a live `current()` supplier.
  let localDepth = 0;

  return tool(
    async ({ task, context }: { task: string; context?: string }) => {
      const depth = ctx.depth?.current ? ctx.depth.current() : localDepth;
      if (depth >= maxDepth) {
        return (
          `[agent-${ctx.id}] refused: max agent-as-tool recursion depth ` +
          `(${maxDepth}) reached at depth ${depth}. Aborting to prevent ` +
          `unbounded cross-agent recursion.`
        );
      }

      localDepth = depth + 1;
      const msgs = [
        new HumanMessage(context ? `${task}\n\nContext:\n${context}` : task),
      ];
      try {
        const result = await ctx.generate(msgs, { _agentToolDepth: depth + 1 });
        return result.content;
      } finally {
        localDepth = depth;
      }
    },
    {
      name: `agent-${ctx.id}`,
      description: ctx.description,
      schema: z.object({
        task: z.string().describe("The task for this agent to complete"),
        context: z
          .string()
          .optional()
          .describe("Additional context for the agent"),
      }),
    }
  );
}
