import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { extractTokenUsage, type TokenUsage } from '@dzupagent/core'
import type { ToolLoopConfig } from '../tool-loop.js'

export interface ModelTurnResult {
  response: BaseMessage
  usage: TokenUsage
}

/**
 * Narrow model-turn kernel: invoke the configured model adapter and extract
 * token usage. Policy concerns such as budgets, compression, halt checks, and
 * telemetry are composed by the facade around this primitive.
 */
export async function executeModelTurn(params: {
  model: BaseChatModel
  messages: BaseMessage[]
  config: Pick<ToolLoopConfig, 'invokeModel'>
}): Promise<ModelTurnResult> {
  const response = params.config.invokeModel
    ? await params.config.invokeModel(params.model, params.messages)
    : await params.model.invoke(params.messages)
  const modelName = (params.model as BaseChatModel & { model?: string }).model
  return {
    response,
    usage: extractTokenUsage(response, modelName),
  }
}
