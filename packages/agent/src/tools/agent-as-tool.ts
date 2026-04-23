/**
 * Wrap a DzupAgent as a LangChain StructuredTool so it can be invoked
 * as a sub-tool by a parent agent.
 *
 * Extracted from DzupAgent.asTool() so the agent-as-tool surface can
 * evolve (schema shape, naming conventions, description overrides)
 * without churning the core DzupAgent class.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { GenerateOptions, GenerateResult } from '../agent/agent-types.js'

/** Narrow surface an agent must expose to be wrappable as a tool. */
export interface AgentAsToolContext {
  id: string
  description: string
  generate: (messages: BaseMessage[], options?: GenerateOptions) => Promise<GenerateResult>
}

/**
 * Wrap the given agent as a LangChain structured tool. The resulting tool
 * accepts `{ task, context? }` and returns the agent's final response
 * string.
 *
 * Dynamic imports are used for `zod` and `@langchain/core/tools` to keep
 * the top-level import graph free of peer-dep hard requirements — mirrors
 * the original `DzupAgent.asTool()` behaviour exactly.
 */
export async function agentAsTool(ctx: AgentAsToolContext): Promise<StructuredToolInterface> {
  const { z } = await import('zod')
  const { tool } = await import('@langchain/core/tools')
  const { HumanMessage } = await import('@langchain/core/messages')

  return tool(
    async ({ task, context }: { task: string; context?: string }) => {
      const msgs = [new HumanMessage(context ? `${task}\n\nContext:\n${context}` : task)]
      const result = await ctx.generate(msgs)
      return result.content
    },
    {
      name: `agent-${ctx.id}`,
      description: ctx.description,
      schema: z.object({
        task: z.string().describe('The task for this agent to complete'),
        context: z.string().optional().describe('Additional context for the agent'),
      }),
    },
  )
}
