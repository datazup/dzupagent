/**
 * DZC-P1 (MEMORY-CONTEXT-REVIEW-20261007 item 7) — `autoCompress` in the
 * agent run loop, end to end.
 *
 * Drives a REAL `TokenLifecycleManager` + `createTokenLifecyclePlugin` and
 * the real `autoCompress` through `DzupAgent.generate()` with a fake chat
 * model (no network). The opt-in flag is `DzupAgentConfig.tokenLifecyclePlugin`
 * (default `undefined` → no compression).
 *
 * The over-budget case only passes when `generate()` charges each model
 * call's reported usage to the plugin, as `stream()` already does.
 *
 * DZC-P1b: the adopted transcript keeps the system prompt, carries the
 * summary, and never duplicates a tool result for a pending tool call.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  type ToolMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { TokenLifecycleManager, createTokenBudget } from '@dzupagent/context'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import { createTokenLifecyclePlugin } from '../token-lifecycle-wiring.js'

const SUMMARY_SENTINEL = 'SUMMARY_SENTINEL_DZC_P1'

const SUMMARY_HEADER = '## Prior Conversation Context'

/** 10k budget, critical at 80% → one 9k-token call crosses it, 100 does not. */
function makePlugin(maxMessages = 4) {
  const manager = new TokenLifecycleManager({
    budget: createTokenBudget(10_000, 0),
    warnThresholdPct: 0.5,
    criticalThresholdPct: 0.8,
  })
  const plugin = createTokenLifecyclePlugin(manager, {
    autoCompressConfig: { maxMessages, keepRecentMessages: 2 },
  })
  return { manager, plugin }
}

function withUsage(message: AIMessage, inputTokens: number): AIMessage {
  ;(message as AIMessage<StandardMessageStructure>).usage_metadata = {
    input_tokens: inputTokens,
    output_tokens: 0,
    total_tokens: inputTokens,
  }
  return message
}

function toolCallTurn(inputTokens: number, index = 0): AIMessage {
  const message = new AIMessage({ content: '' })
  ;(message as AIMessage & { tool_calls: unknown[] }).tool_calls = [
    { id: `dzc-call-${index}`, name: 'echo', args: {} },
  ]
  return withUsage(message, inputTokens)
}

/** `summarizeAndTrim` sends exactly [system, human] with one of these prompts. */
function isSummaryRequest(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1]
  return messages.length === 2
    && typeof last?.content === 'string'
    && /^(Conversation to summarize:|Existing summary to UPDATE)/.test(last.content)
}

/**
 * Invoke-only fake model. Agent turns get `toolTurns` tool calls, then a final
 * answer; a summarization request (recognised by its prompt) gets a summary.
 */
function makeModel(inputTokensPerTurn: number, toolTurns = 1) {
  const agentCalls: BaseMessage[][] = []
  const summaryCalls: BaseMessage[][] = []
  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      if (isSummaryRequest(messages)) {
        summaryCalls.push([...messages])
        return new AIMessage(`## Goal\n${SUMMARY_SENTINEL}`)
      }
      agentCalls.push([...messages])
      return agentCalls.length <= toolTurns
        ? toolCallTurn(inputTokensPerTurn, agentCalls.length - 1)
        : withUsage(new AIMessage('final answer'), inputTokensPerTurn)
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    model: 'dzc-fake-model',
    _modelType: () => 'base_chat_model',
    _llmType: () => 'dzc-fake',
  } as unknown as BaseChatModel
  return { model, agentCalls, summaryCalls }
}

function makeTool() {
  return {
    name: 'echo',
    description: 'Mock echo',
    schema: { type: 'object', properties: {} } as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'tool-result'),
  } as never
}

/** Prior history long enough that `maxMessages: 4` forces summarization. */
function history(): BaseMessage[] {
  const out: BaseMessage[] = []
  for (let i = 0; i < 4; i++) {
    out.push(new HumanMessage(`earlier question ${i}`))
    out.push(new AIMessage(`earlier answer ${i}`))
  }
  out.push(new HumanMessage('current request'))
  return out
}

function makeAgent(model: BaseChatModel, overrides: Partial<DzupAgentConfig> = {}) {
  return new DzupAgent({
    id: 'dzc-p1-agent',
    instructions: 'Base instructions.',
    model,
    tools: [makeTool()],
    guardrails: { maxIterations: 4 },
    ...overrides,
  })
}

function contains(messages: BaseMessage[], text: string): boolean {
  return messages.some(m => JSON.stringify(m.content).includes(text))
}

function textOf(message: BaseMessage | undefined): string {
  return typeof message?.content === 'string'
    ? message.content
    : JSON.stringify(message?.content)
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** Every tool call is answered by exactly one ToolMessage, right after its AI message. */
function expectWellFormedToolPairs(messages: BaseMessage[]): void {
  const toolIds = messages
    .filter((m): m is ToolMessage => m._getType() === 'tool')
    .map(m => m.tool_call_id)
  expect(new Set(toolIds).size).toBe(toolIds.length)
  expect(contains(messages, 'Result unavailable')).toBe(false)
  messages.forEach((m, i) => {
    const calls = (m as AIMessage).tool_calls ?? []
    if (m._getType() !== 'ai' || calls.length === 0) return
    const next = messages.slice(i + 1, i + 1 + calls.length)
    expect(next.map(n => (n as ToolMessage).tool_call_id))
      .toEqual(calls.map(c => c.id))
  })
}

describe('DzupAgent.generate() — autoCompress via tokenLifecyclePlugin (DZC-P1)', () => {
  it('compresses once usage crosses the critical threshold and hands the next turn the compressed transcript', async () => {
    const { model, agentCalls, summaryCalls } = makeModel(9_000)
    const { plugin } = makePlugin()
    const onUsage = vi.spyOn(plugin, 'onUsage')
    const userOnUsage = vi.fn()

    const result = await makeAgent(model, { tokenLifecyclePlugin: plugin })
      .generate(history(), { onUsage: userOnUsage })

    expect(agentCalls).toHaveLength(2)
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1)
    expect(result.compressionLog?.length).toBeGreaterThanOrEqual(1)
    const first = result.compressionLog![0]!
    expect(first.after).toBeLessThan(first.before)
    expect(first.summary).toContain(SUMMARY_SENTINEL)

    // Turn 2 runs on the compressed transcript, not the full earlier history.
    expect(contains(agentCalls[0]!, 'earlier question 0')).toBe(true)
    expect(contains(agentCalls[1]!, 'earlier question 0')).toBe(false)
    expect(agentCalls[1]!.length).toBeLessThan(agentCalls[0]!.length)

    // Exactly one plugin charge and one caller callback per agent model call.
    expect(onUsage).toHaveBeenCalledTimes(2)
    expect(userOnUsage).toHaveBeenCalledTimes(2)
    expect(userOnUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: 9_000 })
    expect(result.stopReason).not.toBe('token_exhausted')
  })

  it('keeps the system prompt, adopts the summary, and does not duplicate the pending tool result (DZC-P1b)', async () => {
    const { model, agentCalls } = makeModel(9_000)
    const { plugin } = makePlugin()

    await makeAgent(model, { tokenLifecyclePlugin: plugin }).generate(history())

    const turn2 = agentCalls[1]!
    expect(turn2[0]!._getType()).toBe('system')
    const system = textOf(turn2[0])
    expect(system).toContain('Base instructions.')
    expect(system).toContain(`${SUMMARY_HEADER}\n\n## Goal\n${SUMMARY_SENTINEL}`)
    expect(turn2.filter(m => m._getType() === 'system')).toHaveLength(1)

    // The tool call made in turn 1 is answered exactly once, by the real result.
    expectWellFormedToolPairs(turn2)
    const results = turn2.filter(m => m._getType() === 'tool')
    expect(results).toHaveLength(1)
    expect(textOf(results[0])).toContain('tool-result')
    expect(contains(turn2, 'current request')).toBe(true)
  })

  it('updates the summary on a second compression instead of stacking it (DZC-P1b)', async () => {
    const { model, agentCalls, summaryCalls } = makeModel(9_000, 2)
    const { plugin } = makePlugin(3)

    const result = await makeAgent(model, { tokenLifecyclePlugin: plugin })
      .generate(history())

    // Turns 1 and 2 each cross the threshold before the next agent turn.
    // (The final turn compresses too; the loop compresses before it checks
    // for a final answer.)
    expect(agentCalls).toHaveLength(3)
    expect(result.compressionLog!.length).toBeGreaterThanOrEqual(2)
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2)
    // The second summarization is fed the first summary from the system prompt.
    const update = textOf(summaryCalls[1]![1])
    expect(update.startsWith('Existing summary to UPDATE')).toBe(true)
    expect(update).toContain(SUMMARY_SENTINEL)

    const turn3 = agentCalls[2]!
    const system = textOf(turn3[0])
    expect(system).toContain('Base instructions.')
    expect(occurrences(system, SUMMARY_HEADER)).toBe(1)
    expect(turn3.filter(m => m._getType() === 'system')).toHaveLength(1)
    expectWellFormedToolPairs(turn3)
    expect(contains(turn3, 'tool-result')).toBe(true)
  })

  it('does not compress while usage stays under the threshold', async () => {
    const { model, agentCalls, summaryCalls } = makeModel(100)
    const { plugin, manager } = makePlugin()

    const result = await makeAgent(model, { tokenLifecyclePlugin: plugin })
      .generate(history())

    expect(agentCalls).toHaveLength(2)
    expect(summaryCalls).toHaveLength(0)
    expect(result.compressionLog).toBeUndefined()
    expect(contains(agentCalls[1]!, 'earlier question 0')).toBe(true)
    // Usage is charged, but stays below critical.
    expect(manager.usedTokens).toBeGreaterThanOrEqual(200)
    expect(manager.status).not.toBe('critical')
  })

  it('does not compress when the flag is off (no tokenLifecyclePlugin), even over budget', async () => {
    const { model, agentCalls, summaryCalls } = makeModel(9_000)

    const result = await makeAgent(model).generate(history())

    expect(agentCalls).toHaveLength(2)
    expect(summaryCalls).toHaveLength(0)
    expect(result.compressionLog).toBeUndefined()
    expect(contains(agentCalls[1]!, 'earlier question 0')).toBe(true)
  })

  it('charges the plugin exactly once per model call on the stream() fallback path', async () => {
    const { model, agentCalls } = makeModel(100)
    const { plugin } = makePlugin()
    const onUsage = vi.spyOn(plugin, 'onUsage')
    const userOnUsage = vi.fn()

    for await (const _event of makeAgent(model, { tokenLifecyclePlugin: plugin })
      .stream(history(), { onUsage: userOnUsage })) {
      // drain
    }

    expect(agentCalls).toHaveLength(2)
    expect(onUsage).toHaveBeenCalledTimes(2)
    expect(userOnUsage).toHaveBeenCalledTimes(2)
  })
})
