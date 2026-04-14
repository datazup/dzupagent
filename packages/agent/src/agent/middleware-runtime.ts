import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentMiddleware } from '@dzupagent/core'

export interface AgentMiddlewareRuntimeConfig {
  agentId: string
  middleware?: AgentMiddleware[]
}

export class AgentMiddlewareRuntime {
  constructor(private readonly config: AgentMiddlewareRuntimeConfig) {}

  resolveTools(tools: StructuredToolInterface[] = []): StructuredToolInterface[] {
    const resolvedTools = [...tools]

    for (const middleware of this.config.middleware ?? []) {
      if (middleware.tools) {
        resolvedTools.push(...middleware.tools)
      }
    }

    return resolvedTools
  }

  async runBeforeAgentHooks(): Promise<void> {
    for (const middleware of this.config.middleware ?? []) {
      if (!middleware.beforeAgent) {
        continue
      }

      try {
        await middleware.beforeAgent({})
      } catch {
        // Middleware failures are non-fatal.
      }
    }
  }

  async invokeModel(
    model: BaseChatModel,
    messages: BaseMessage[],
  ): Promise<BaseMessage> {
    const wrapper = (this.config.middleware ?? []).find(
      (middleware) => typeof middleware.wrapModelCall === 'function',
    )

    if (wrapper?.wrapModelCall) {
      return wrapper.wrapModelCall(model, messages, { agentId: this.config.agentId })
    }

    return model.invoke(messages)
  }

  async transformToolResult(
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ): Promise<string> {
    let current = result

    for (const middleware of this.config.middleware ?? []) {
      if (!middleware.wrapToolCall) {
        continue
      }

      try {
        current = await middleware.wrapToolCall(toolName, input, current)
      } catch {
        // Middleware failures are non-fatal.
      }
    }

    return current
  }
}
