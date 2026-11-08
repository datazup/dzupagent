/**
 * MC-04b (MEMCTX-CACHE-PREFIX-20261108-R1): stable instruction cache prefix,
 * agent side.
 *
 * - case a: prefix stability through the system breakpoint, plus the disclosed
 *   negative cases (trailing whitespace, a header ending block 0, empty
 *   instructions).
 * - case b: payload shape of prepared messages and their passage through the
 *   legacy runner envelope codec (no-tool and read-tool delegation paths).
 * - case c: text compatibility against the one oracle (today's string
 *   functions, reproduced verbatim below).
 * - case d: lifecycle counter default (item 3).
 *
 * Provider-free. The installed `@langchain/anthropic` converter
 * (`convertPromptToAnthropic`) runs locally.
 *
 * Placement is production `applyCacheBreakpoints` from `@dzupagent/context`.
 * MC-04b gates run this package with the isolated candidate resolution
 * (`--config node_modules/.mc04b-candidate/vitest.config.mts`, aliasing
 * `@dzupagent/context` to this worktree's `packages/context/src`); under the
 * default resolution (a prebuilt `dist` of the base) the placement cases fail.
 */
import { describe, expect, it } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { ChatPromptValue } from '@langchain/core/prompt_values'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { convertPromptToAnthropic } from '@langchain/anthropic'
import {
  CharEstimateCounter,
  TiktokenCounter,
  TokenLifecycleManager,
  applyCacheBreakpoints,
  createTokenBudget,
  formatSummaryContext,
} from '@dzupagent/context'
import { buildPreparedMessages } from '../agent/message-utils.js'
import {
  _readSummaryForTest as readSummary,
  _writeSummaryForTest as writeSummary,
  createTokenLifecyclePlugin,
} from '../token-lifecycle-wiring.js'
import type { AutoCompressConfig } from '../context/auto-compress.js'
import {
  captureMessageEnvelopeEntry,
  createLegacyRunnerMessageItem,
  reconstructLegacyMessage,
  validMessageEnvelopeEntry,
} from '../runner/legacy-runner-message-envelope-codec.js'

type Block = { type: string; text: string; [key: string]: unknown }
type Content = BaseMessage['content']

const P = '## Prior Conversation Context\n\n'
const HEADER = '## Prior Conversation Context'

// ---------- Today's string functions (the oracle), verbatim from the start base ----------

function legacyBuild(i: string, memory: string | null, summary: string | null): string {
  const parts: string[] = [i]
  if (memory) parts.push(memory)
  const summaryContext = formatSummaryContext(summary)
  if (summaryContext) parts.push(summaryContext)
  return parts.join('\n\n')
}

function legacyRead(content: string): string | null {
  const idx = content.indexOf(P)
  return idx < 0 ? null : content.slice(idx + P.length)
}

function legacyWrite(content: string, summaryContext: string): string {
  const idx = content.indexOf(P)
  const base = (idx < 0 ? content : content.slice(0, idx)).trimEnd()
  if (!summaryContext) return base
  return base ? `${base}\n\n${summaryContext}` : summaryContext
}

// ---------- Helpers ----------

function joined(content: Content): string {
  if (typeof content === 'string') return content
  return (content as Block[]).map((b) => b.text).join('')
}

function blocks(...texts: string[]): Block[] {
  return texts.map((text) => ({ type: 'text', text }))
}

function texts(content: Content): string[] {
  expect(Array.isArray(content)).toBe(true)
  return (content as Block[]).map((b) => b.text)
}

function systemOf(i: string, memory: string | null, summary: string | null): SystemMessage {
  return buildPreparedMessages({
    baseInstructions: i,
    memoryContext: memory,
    conversationSummary: summary,
    messages: [],
  })[0] as SystemMessage
}

/** One compression round as `compressTranscript` applies it to the leading system message. */
function compress(system: SystemMessage, summary: string): SystemMessage {
  return new SystemMessage({
    content: writeSummary(system.content, formatSummaryContext(summary)),
    additional_kwargs: system.additional_kwargs,
  })
}

function convert(messages: BaseMessage[]) {
  return convertPromptToAnthropic(new ChatPromptValue(messages)) as {
    system?: unknown
    messages: unknown[]
  }
}

/** Serialized payload bytes from the start of `system` through the system breakpoint. */
function prefixThroughBreakpoint(system: SystemMessage, rest: BaseMessage[] = [new HumanMessage('turn')]) {
  const payload = convert(applyCacheBreakpoints([system, ...rest]))
  const sys = payload.system as Block[]
  const index = sys.findIndex((b) => 'cache_control' in b)
  return { index, bytes: JSON.stringify(sys.slice(0, index + 1)) }
}

/** Blocks that carry a summary section (start with `P` or `'\n\n' + P`). */
function summaryBlocks(content: Content): number {
  return (content as Block[]).filter((b) => b.text.startsWith(P) || b.text.startsWith(`\n\n${P}`)).length
}

// ---------- case a ----------

const INSTRUCTIONS = 'You are the MC-04b agent.\nFollow the named constraints.\n- C1 keep scope.'

describe('MC-04b case a: prefix stability through the system breakpoint', () => {
  it('precondition: non-empty instructions, no trailing whitespace, no summary prefix in instructions + "\\n\\n"', () => {
    expect(INSTRUCTIONS.length).toBeGreaterThan(0)
    expect(INSTRUCTIONS).toBe(INSTRUCTIONS.trimEnd())
    expect(`${INSTRUCTIONS}\n\n`.includes(P)).toBe(false)
  })

  it('is byte-identical across memory changes, with and without a summary, and repeated compressions', () => {
    const t1 = systemOf(INSTRUCTIONS, null, null)
    const t2 = systemOf(INSTRUCTIONS, '## Memory Context\n- recall A', null)
    const t3 = systemOf(INSTRUCTIONS, '## Memory Context\n- recall B\n', 'summary one')
    const t4 = systemOf(INSTRUCTIONS, null, 'summary two')
    const c1 = compress(t3, 'summary three')
    const c2 = compress(c1, 'summary four')
    const c3 = compress(c2, 'summary five')
    const c4 = compress(t1, 'first summary')
    const c5 = compress(t2, 'first summary')
    const turns = { t1, t2, t3, t4, c1, c2, c3, c4, c5 }
    const expected = JSON.stringify([{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }])
    for (const [label, system] of Object.entries(turns)) {
      const prefix = prefixThroughBreakpoint(system)
      expect(prefix.index, label).toBe(0)
      expect(prefix.bytes, label).toBe(expected)
    }
  })

  it('a re-marked, compressed system message keeps the same prefix (marks applied before compression)', () => {
    const marked = applyCacheBreakpoints([systemOf(INSTRUCTIONS, 'memo', 'old')])[0] as SystemMessage
    const after = compress(marked, 'new')
    expect(prefixThroughBreakpoint(after)).toEqual(prefixThroughBreakpoint(systemOf(INSTRUCTIONS, null, null)))
    expect(joined(after.content)).toBe(legacyWrite(legacyBuild(INSTRUCTIONS, 'memo', 'old'), formatSummaryContext('new')))
  })

  it('negative (disclosed): instructions "I " change their cached bytes on summarised turns without real memory', () => {
    const memories: Array<[string, string | null]> = [['absent', null], ['present', 'memo'], ['whitespace', '   ']]
    const differs: string[] = []
    const reference = prefixThroughBreakpoint(systemOf('I ', null, null)).bytes
    for (const [name, memory] of memories) {
      const t0 = systemOf('I ', memory, null)
      const r1 = compress(t0, 's1')
      const r2 = compress(r1, 's2')
      for (const [phase, system, legacy] of [
        ['before', t0, legacyBuild('I ', memory, null)],
        ['round-1', r1, legacyWrite(legacyBuild('I ', memory, null), formatSummaryContext('s1'))],
        ['round-2', r2, legacyWrite(legacyWrite(legacyBuild('I ', memory, null), formatSummaryContext('s1')), formatSummaryContext('s2'))],
      ] as const) {
        expect(joined(system.content), `${name} ${phase}`).toBe(legacy)
        if (prefixThroughBreakpoint(system).bytes !== reference) differs.push(`${name}:${phase}`)
      }
    }
    // Recorded result: the string-compatible trimEnd trims block 0 when it is the
    // last remaining block, i.e. when memory is absent or whitespace only.
    expect(differs).toEqual([
      'absent:round-1', 'absent:round-2', 'whitespace:round-1', 'whitespace:round-2',
    ])
  })

  it('negative (disclosed): instructions ending in the summary header let the cut start in block 0', () => {
    const i = `Rules. ${HEADER}`
    expect(`${i}\n\n`.includes(P)).toBe(true)
    const t0 = systemOf(i, 'memo', null)
    const r1 = compress(t0, 's1')
    expect(joined(r1.content)).toBe(legacyWrite(legacyBuild(i, 'memo', null), formatSummaryContext('s1')))
    expect(texts(r1.content)[0]).toBe('Rules.')
    expect(prefixThroughBreakpoint(r1).bytes).not.toBe(prefixThroughBreakpoint(t0).bytes)
  })

  it('negative (disclosed): empty instructions put memory at block 0, so the cached bytes change with recall', () => {
    const a = systemOf('', 'a', null)
    const b = systemOf('', 'b', null)
    expect(texts(a.content)).toEqual(['\n\na'])
    expect(joined(a.content)).toBe(legacyBuild('', 'a', null))
    expect(joined(b.content)).toBe(legacyBuild('', 'b', null))
    expect(prefixThroughBreakpoint(a).bytes).not.toBe(prefixThroughBreakpoint(b).bytes)
  })
})

// ---------- case b ----------

describe('MC-04b case b: payload shape and envelope codec', () => {
  const prepared = buildPreparedMessages({
    baseInstructions: INSTRUCTIONS,
    memoryContext: '## Memory Context\n- fact',
    conversationSummary: '## Goal\nship',
    messages: [
      new HumanMessage('q1 '.repeat(800)),
      new AIMessage('a1 '.repeat(800)),
      new HumanMessage('q2 '.repeat(800)),
      new AIMessage('a2 '.repeat(800)),
      new HumanMessage('now'),
    ],
  })

  it('buildPreparedMessages returns one system message of ordered type/text blocks with no additional_kwargs', () => {
    const system = prepared[0]!
    expect(system).toBeInstanceOf(SystemMessage)
    expect(prepared.filter((m) => m._getType() === 'system')).toHaveLength(1)
    expect(system.additional_kwargs).toEqual({})
    expect(system.content).toEqual([
      { type: 'text', text: INSTRUCTIONS },
      { type: 'text', text: '\n\n## Memory Context\n- fact' },
      { type: 'text', text: `\n\n${P}## Goal\nship` },
    ])
  })

  it('the converted payload has one system block array, cache_control on block 0 (the instructions), at most 4 breakpoints', () => {
    for (const cacheStrategy of ['content-addressed', 'positional'] as const) {
      const payload = convert(applyCacheBreakpoints(prepared, { cacheStrategy }))
      const system = payload.system as Block[]
      expect(Array.isArray(system), cacheStrategy).toBe(true)
      expect(system).toHaveLength(3)
      expect(system[0]!.text).toBe(INSTRUCTIONS)
      expect(system[0]!['cache_control']).toEqual({ type: 'ephemeral' })
      expect(system.slice(1).every((b) => !('cache_control' in b))).toBe(true)
      for (const block of system) {
        expect(Object.keys(block).every((k) => ['type', 'text', 'cache_control'].includes(k))).toBe(true)
      }
      const total = JSON.stringify(payload).split('"cache_control"').length - 1
      expect(total, cacheStrategy).toBeLessThanOrEqual(4)
    }
  })

  it('empty-block regressions: leading and interior empty blocks are omitted and never carry the breakpoint', () => {
    const s = formatSummaryContext('s')
    const leading = writeSummary(blocks('', 'I'), s)
    expect(leading).toEqual(blocks('I', `\n\n${P}s`))
    const interior = writeSummary(blocks('I', '', '\n\nmemo'), s)
    expect(interior).toEqual(blocks('I', '\n\nmemo', `\n\n${P}s`))
    expect(writeSummary(blocks('', 'I'), '')).toEqual(blocks('I'))
    for (const [label, input, out] of [['leading', ['', 'I'], leading], ['interior', ['I', '', '\n\nmemo'], interior]] as const) {
      expect(joined(out), label).toBe(legacyWrite(input.join(''), s))
      const system = convert(applyCacheBreakpoints([new SystemMessage({ content: out }), new HumanMessage('x')]))
        .system as Block[]
      expect(system.every((b) => b.text.length > 0), label).toBe(true)
      expect(system[0]).toEqual({ type: 'text', text: 'I', cache_control: { type: 'ephemeral' } })
    }
  })

  it('a string or single-block system message keeps today\'s placement', () => {
    const single = systemOf(INSTRUCTIONS, null, null)
    expect(single.content).toEqual([{ type: 'text', text: INSTRUCTIONS }])
    expect(convert(applyCacheBreakpoints([single, new HumanMessage('x')])).system).toEqual([
      { type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
    ])
    expect(convert(applyCacheBreakpoints([new SystemMessage('S'), new HumanMessage('x')])).system).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('prepared and compressed messages pass the legacy envelope codec unchanged (no-tool and read-tool delegation)', () => {
    const compressed = [compress(prepared[0] as SystemMessage, 'next'), ...prepared.slice(1)]
    for (const [label, messages] of [['prepared', prepared], ['compressed', compressed]] as const) {
      for (const [index, message] of messages.entries()) {
        const item = createLegacyRunnerMessageItem(message, `item-${index}`)
        expect(typeof item, `${label} ${index}`).toBe('object')
        const entry = captureMessageEnvelopeEntry(message, item as Exclude<typeof item, string>, index)
        expect(typeof entry, `${label} ${index}`).toBe('object')
        const roundTripped = JSON.parse(JSON.stringify(entry)) as unknown
        expect(validMessageEnvelopeEntry(roundTripped, index), `${label} ${index}`).toBe(true)
        const restored = reconstructLegacyMessage(entry as Exclude<typeof entry, string>)
        expect(restored._getType()).toBe(message._getType())
        expect(restored.content, `${label} ${index}`).toEqual(message.content)
      }
      const system = createLegacyRunnerMessageItem(messages[0]!, 's')
      expect((system as { content: unknown }).content).toEqual(messages[0]!.content)
    }
  })
})

// ---------- case c ----------

describe('MC-04b case c: text compatibility against the one oracle', () => {
  it('pipeline: build then compress, step by step equal to the former string pipeline', () => {
    const instructions = ['Base rules.', '', 'Base rules.  \n']
    const memories = [null, 'mem', 'mem\n']
    const summaries = [null, 'prior summary']
    const rounds = ['r1', 'r2', 'r3', '']
    let checked = 0
    for (const i of instructions) {
      for (const m of memories) {
        for (const s of summaries) {
          let system = systemOf(i, m, s)
          let legacy = legacyBuild(i, m, s)
          expect(joined(system.content)).toBe(legacy)
          expect(readSummary(system.content)).toBe(legacyRead(legacy))
          for (const r of rounds) {
            system = compress(system, r)
            legacy = legacyWrite(legacy, formatSummaryContext(r))
            expect(joined(system.content), JSON.stringify({ i, m, s, r })).toBe(legacy)
            expect(readSummary(system.content)).toBe(legacyRead(legacy))
            checked++
          }
          // After the final empty replacement no summary block remains.
          expect(summaryBlocks(system.content)).toBe(0)
        }
      }
    }
    expect(checked).toBe(3 * 3 * 2 * 4)
  })

  it('string input: writeSummary keeps the string with no summary and returns blocks otherwise', () => {
    expect(writeSummary('I  \n', '')).toBe('I')
    expect(writeSummary('', formatSummaryContext('s'))).toEqual(blocks(`${P}s`))
    expect(writeSummary('I  \n', formatSummaryContext('s'))).toEqual(blocks('I', `\n\n${P}s`))
    expect(writeSummary(`I \n\n${P}old`, formatSummaryContext('s'))).toEqual(blocks('I', `\n\n${P}s`))
  })

  it('generated arrays: both oracle equations hold for every array over the fragments (deterministic table)', () => {
    const fragments = ['', ' ', 'I', 'I ', '\n\n', P, `\n\n${P}old`, 'memo ', HEADER, '\n\nmemo']
    const arrays: string[][] = [[]]
    for (const a of fragments) arrays.push([a])
    for (const a of fragments) for (const b of fragments) arrays.push([a, b])
    for (const a of fragments) for (const b of fragments) for (const c of fragments) arrays.push([a, b, c])
    const summaryContexts = [formatSummaryContext('new summary'), '']
    let equations = 0
    for (const x of arrays) {
      const input = blocks(...x)
      const j = x.join('')
      expect(readSummary(input), JSON.stringify(x)).toBe(legacyRead(j))
      equations++
      for (const s of summaryContexts) {
        const out = writeSummary(input, s)
        expect(joined(out), JSON.stringify({ x, s })).toBe(legacyWrite(j, s))
        // Every output block is exactly type/text with non-empty text.
        for (const block of out as Block[]) {
          expect(Object.keys(block).sort()).toEqual(['text', 'type'])
          expect(block.text.length, JSON.stringify({ x, s })).toBeGreaterThan(0)
        }
        equations++
      }
    }
    expect(arrays).toHaveLength(1 + 10 + 100 + 1000)
    expect(equations).toBe(arrays.length * 3)
  })

  it('named regression: embedded header in memory', () => {
    const memo = `memo ${P}old`
    let system = systemOf('I', memo, null)
    let legacy = legacyBuild('I', memo, null)
    expect(summaryBlocks(system.content)).toBe(0)
    expect(readSummary(system.content)).toBe('old')
    for (const [r, count] of [['s1', 1], ['s2', 1], ['', 0]] as const) {
      system = compress(system, r)
      legacy = legacyWrite(legacy, formatSummaryContext(r))
      expect(joined(system.content)).toBe(legacy)
      expect(summaryBlocks(system.content), r).toBe(count)
    }
    expect(texts(system.content)).toEqual(['I', '\n\nmemo'])
  })

  it('named regression: header formed across the join (instructions header, memory "memo")', () => {
    let system = systemOf(HEADER, 'memo', null)
    let legacy = legacyBuild(HEADER, 'memo', null)
    expect(readSummary(system.content)).toBe(legacyRead(legacy))
    expect(readSummary(system.content)).toBe('memo')
    for (const [r, count] of [['s1', 1], ['s2', 1], ['', 0]] as const) {
      system = compress(system, r)
      legacy = legacyWrite(legacy, formatSummaryContext(r))
      expect(joined(system.content)).toBe(legacy)
      expect(summaryBlocks(system.content), r).toBe(count)
    }
    expect(system.content).toEqual([])
  })

  it('named regression: trim-formed header (round 6: instructions "I", memory "memo ## Prior Conversation Context ", two replacements)', () => {
    const memo = `memo ${HEADER} `
    let system = systemOf('I', memo, null)
    let legacy = legacyBuild('I', memo, null)
    expect(readSummary(system.content)).toBeNull()
    system = compress(system, 's1')
    legacy = legacyWrite(legacy, formatSummaryContext('s1'))
    expect(joined(system.content)).toBe(legacy)
    expect(texts(system.content)).toEqual(['I', `\n\nmemo ${HEADER}`, `\n\n${P}s1`])
    expect(summaryBlocks(system.content)).toBe(1)
    // The trim formed a header: the first occurrence now starts in the memory block.
    expect(readSummary(system.content)).toBe(legacyRead(legacy))
    system = compress(system, 's2')
    legacy = legacyWrite(legacy, formatSummaryContext('s2'))
    expect(joined(system.content)).toBe(legacy)
    expect(texts(system.content)).toEqual(['I', '\n\nmemo', `\n\n${P}s2`])
    expect(summaryBlocks(system.content)).toBe(1)
  })

  it('named regression: bare header with no memory', () => {
    let system = systemOf(HEADER, null, null)
    let legacy = legacyBuild(HEADER, null, null)
    for (const [r, count] of [['s1', 1], ['s2', 1], ['s3', 1], ['', 0]] as const) {
      system = compress(system, r)
      legacy = legacyWrite(legacy, formatSummaryContext(r))
      expect(joined(system.content), r).toBe(legacy)
      expect(readSummary(system.content), r).toBe(legacyRead(legacy))
      expect(summaryBlocks(system.content), r).toBe(count)
    }
  })

  it('caller-built (intended change): text after a summary block is dropped', () => {
    const out = writeSummary(blocks('I', `\n\n${P}old`, '\n\ntrailing'), formatSummaryContext('new'))
    expect(out).toEqual(blocks('I', `\n\n${P}new`))
    expect(joined(out)).toBe(legacyWrite(`I\n\n${P}old\n\ntrailing`, formatSummaryContext('new')))
  })

  it('caller-built (intended change): ["I"] plus a first summary gives "I\\n\\n" + summary', () => {
    const out = writeSummary(blocks('I'), formatSummaryContext('s'))
    expect(out).toEqual(blocks('I', `\n\n${P}s`))
    expect(joined(out)).toBe(`I\n\n${P}s`)
  })

  it('caller-built (intended change): a prefix split across two blocks is recognised, separator added, trailing whitespace trimmed', () => {
    const input = blocks('I  \n\n## Prior Conv', 'ersation Context\n\nold')
    expect(readSummary(input)).toBe('old')
    const out = writeSummary(input, formatSummaryContext('new'))
    expect(out).toEqual(blocks('I', `\n\n${P}new`))
    expect(joined(out)).toBe(legacyWrite(joined(input), formatSummaryContext('new')))
  })

  it('a kept block keeps its other keys (a cache_control placed before compression)', () => {
    const input = [{ type: 'text', text: 'I', cache_control: { type: 'ephemeral' } }, ...blocks('\n\nmemo')]
    const out = writeSummary(input as Content, formatSummaryContext('s')) as Block[]
    expect(out[0]).toEqual(input[0])
    expect(out[2]).toEqual({ type: 'text', text: `\n\n${P}s` })
  })
})

// ---------- case d (item 3) ----------

describe('MC-04b case d: lifecycle counter default (item 3)', () => {
  const WORDS = 'internationalization '.repeat(100)
  const body = (): BaseMessage[] => [
    new HumanMessage(`h1 ${WORDS}`), new AIMessage(`a1 ${WORDS}`),
    new HumanMessage(`h2 ${WORDS}`), new AIMessage(`a2 ${WORDS}`),
    new HumanMessage(`h3 ${WORDS}`), new AIMessage(`a3 ${WORDS}`),
  ]
  const MAX_TOKENS = 2_000

  function summaryModel(id: string): BaseChatModel {
    return {
      invoke: async () => new AIMessage('## Goal\nsummary'),
      model: id,
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mc04b-fake',
    } as unknown as BaseChatModel
  }

  async function compressed(config: AutoCompressConfig, modelId: string): Promise<boolean> {
    const manager = new TokenLifecycleManager({
      budget: createTokenBudget(10_000, 0),
      warnThresholdPct: 0.8,
      criticalThresholdPct: 0.95,
    })
    const plugin = createTokenLifecyclePlugin(manager, { autoCompressConfig: config })
    plugin.trackPhase('input', 9_600)
    const result = await plugin.maybeCompress([new SystemMessage('I'), ...body()], summaryModel(modelId))
    plugin.cleanup()
    return result.compressed
  }

  const base: AutoCompressConfig = { maxMessages: 1_000, keepRecentMessages: 2, maxMessageTokens: MAX_TOKENS }

  it('precondition: chars/4 exceeds the budget while the tokenizer count does not', () => {
    const text = body().map((m) => m.content as string)
    const chars = text.reduce((n, t) => n + t.length, 0)
    const tokens = text.reduce((n, t) => n + new TiktokenCounter().count(t, 'gpt-4o'), 0)
    expect(new TiktokenCounter().countDetailed('probe', 'gpt-4o').method).not.toBe('heuristic')
    expect(Math.ceil(chars / 4)).toBeGreaterThan(MAX_TOKENS)
    expect(tokens).toBeLessThan(MAX_TOKENS)
  })

  it('default config: the plugin passes the derived model id, so the tokenizer decides (no compression)', async () => {
    expect(await compressed({ ...base }, 'gpt-4o')).toBe(false)
  })

  it('unchanged: a model with no derivable id keeps the chars heuristic (compresses)', async () => {
    const model = {
      invoke: async () => new AIMessage('## Goal\nsummary'),
      _modelType: () => 'base_chat_model',
    } as unknown as BaseChatModel
    const manager = new TokenLifecycleManager({ budget: createTokenBudget(10_000, 0), criticalThresholdPct: 0.95 })
    const plugin = createTokenLifecyclePlugin(manager, { autoCompressConfig: { ...base } })
    plugin.trackPhase('input', 9_600)
    const result = await plugin.maybeCompress([new SystemMessage('I'), ...body()], model)
    expect(result.compressed).toBe(true)
  })

  it('unchanged: an explicit charsPerToken keeps the chars heuristic (compresses)', async () => {
    expect(await compressed({ ...base, charsPerToken: 4 }, 'gpt-4o')).toBe(true)
  })

  it('unchanged: an explicit tokenCounter wins (compresses with the chars counter)', async () => {
    expect(await compressed({ ...base, tokenCounter: new CharEstimateCounter() }, 'gpt-4o')).toBe(true)
  })

  it('regression: an explicit known summaryModelId already selects the tokenizer (no compression)', async () => {
    expect(await compressed({ ...base, summaryModelId: 'gpt-4o' }, 'no-id-used')).toBe(false)
    // The explicit id is kept, not replaced by the call's model id: a model whose
    // derived id is `unknown` (no counter selection) must not override it.
    expect(await compressed({ ...base, summaryModelId: 'gpt-4o' }, 'unknown')).toBe(false)
    // Control: with no explicit id that model keeps the chars heuristic.
    expect(await compressed({ ...base }, 'unknown')).toBe(true)
  })

  it('does not mutate the caller config', async () => {
    const config: AutoCompressConfig = { ...base }
    await compressed(config, 'gpt-4o')
    expect(config).toEqual(base)
  })
})
