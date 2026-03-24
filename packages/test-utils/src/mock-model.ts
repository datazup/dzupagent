/**
 * MockChatModel — deterministic chat model for testing.
 *
 * Returns pre-configured responses in order. Cycles back to the first
 * response after all are used. No network calls.
 *
 * @example
 * ```ts
 * const model = new MockChatModel([
 *   'First response',
 *   'Second response',
 * ])
 * const result = await model.invoke([new HumanMessage('hello')])
 * // result.content === 'First response'
 * ```
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'

export interface MockResponse {
  content: string
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
}

export class MockChatModel extends BaseChatModel {
  private responses: MockResponse[]
  private callIndex = 0
  private _callLog: Array<{ messages: BaseMessage[]; timestamp: number }> = []

  static lc_name(): string {
    return 'MockChatModel'
  }

  constructor(responses: Array<string | MockResponse>) {
    super({})
    this.responses = responses.map(r =>
      typeof r === 'string' ? { content: r } : r,
    )
    if (this.responses.length === 0) {
      this.responses = [{ content: '' }]
    }
  }

  async _generate(
    messages: BaseMessage[],
    _options?: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    this._callLog.push({ messages: [...messages], timestamp: Date.now() })

    const response = this.responses[this.callIndex % this.responses.length]!
    this.callIndex++

    const aiMessage = new AIMessage({
      content: response.content,
      tool_calls: response.tool_calls,
    })

    return {
      generations: [{ text: response.content, message: aiMessage }],
    }
  }

  _llmType(): string {
    return 'mock'
  }

  /** Get the log of all calls made to this model */
  get callLog(): Array<{ messages: BaseMessage[]; timestamp: number }> {
    return this._callLog
  }

  /** Number of times invoke/generate was called */
  get callCount(): number {
    return this._callLog.length
  }

  /** Reset call counter and log */
  reset(): void {
    this.callIndex = 0
    this._callLog = []
  }
}
