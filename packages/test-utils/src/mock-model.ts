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
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'

/** Standard LangChain usage-metadata shape, as emitted on a stream delta. */
export interface MockUsageMetadata {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

/**
 * One streamed delta. Mirrors what a real provider emits: a slice of text
 * and/or a fragment of a tool call's JSON arguments. Splitting `args`
 * across several chunks is the whole point — it is what exercises
 * `AIMessageChunk.concat` assembly in the consumer.
 */
export interface MockStreamChunk {
  content?: string
  tool_call_chunks?: Array<{
    id?: string
    name?: string
    /** Partial JSON fragment — concatenated across deltas by the consumer. */
    args?: string
    index?: number
  }>
  usage_metadata?: MockUsageMetadata
  response_metadata?: Record<string, unknown>
}

export interface MockResponse {
  content: string
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  /** Usage reported on the assembled response (and on the first stream delta). */
  usage_metadata?: MockUsageMetadata
  /**
   * Explicit multi-delta script for `stream()`. When omitted, streaming
   * synthesises a single delta carrying the whole response, matching the
   * previous single-chunk behaviour.
   */
  stream_chunks?: MockStreamChunk[]
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

    const fields: {
      content: string
      tool_calls?: NonNullable<MockResponse['tool_calls']>
      usage_metadata?: MockUsageMetadata
    } = { content: response.content }
    if (response.tool_calls !== undefined) fields.tool_calls = response.tool_calls
    if (response.usage_metadata !== undefined) {
      fields.usage_metadata = response.usage_metadata
    }
    // LangChain 1.x types `usage_metadata` as `never` on the DEFAULT message
    // structure (it is only inferred for provider-specific structures), while
    // the runtime constructor honours it. Cast at the boundary so mocks can
    // emit the standard usage field.
    const aiMessage = new AIMessage(fields as ConstructorParameters<typeof AIMessage>[0])

    return {
      generations: [{ text: response.content, message: aiMessage }],
    }
  }

  /**
   * Native streaming. Without this, `BaseChatModel.stream()` silently falls
   * back to `_generate` and yields exactly ONE chunk — which never exercises
   * chunk assembly in consumers, so a consumer that overwrites instead of
   * concatenating looks correct under test (C-03).
   *
   * Yields the response's `stream_chunks` script when present; otherwise
   * synthesises a single delta carrying the whole response, preserving the
   * previous single-chunk behaviour for existing tests.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options?: BaseChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this._callLog.push({ messages: [...messages], timestamp: Date.now() })

    const response = this.responses[this.callIndex % this.responses.length]!
    this.callIndex++

    for (const delta of response.stream_chunks ?? synthesizeSingleDelta(response)) {
      const text = delta.content ?? ''
      const fields: {
        content: string
        tool_call_chunks?: Array<{
          type: 'tool_call_chunk'
          id: string
          name?: string
          args: string
          index: number
        }>
        usage_metadata?: MockUsageMetadata
        response_metadata?: Record<string, unknown>
      } = { content: text }
      if (delta.tool_call_chunks !== undefined) {
        fields.tool_call_chunks = delta.tool_call_chunks.map((tc, i) => {
          const entry: {
            type: 'tool_call_chunk'
            id: string
            name?: string
            args: string
            index: number
          } = {
            type: 'tool_call_chunk',
            id: tc.id ?? `call_${i}`,
            args: tc.args ?? '',
            index: tc.index ?? i,
          }
          if (tc.name !== undefined) entry.name = tc.name
          return entry
        })
      }
      if (delta.usage_metadata !== undefined) {
        fields.usage_metadata = delta.usage_metadata
      }
      if (delta.response_metadata !== undefined) {
        fields.response_metadata = delta.response_metadata
      }
      // See the `usage_metadata` note in `_generate` — same typing gap.
      const message = new AIMessageChunk(
        fields as ConstructorParameters<typeof AIMessageChunk>[0],
      )
      await runManager?.handleLLMNewToken(text)
      yield new ChatGenerationChunk({ text, message })
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

/**
 * Fallback stream script for a response that declares no `stream_chunks`:
 * one delta carrying the full content plus any tool calls as already-complete
 * JSON fragments.
 */
function synthesizeSingleDelta(response: MockResponse): MockStreamChunk[] {
  return [
    {
      content: response.content,
      ...(response.tool_calls !== undefined
        ? {
            tool_call_chunks: response.tool_calls.map((tc, index) => ({
              id: tc.id,
              name: tc.name,
              args: JSON.stringify(tc.args),
              index,
            })),
          }
        : {}),
      ...(response.usage_metadata !== undefined
        ? { usage_metadata: response.usage_metadata }
        : {}),
    },
  ]
}
