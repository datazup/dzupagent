/**
 * MC-04a (MEMCTX-COMPRESS-MEASURE-20261108-R1): measured compression economy
 * on fixed transcripts.
 *
 * Drives `createTokenLifecyclePlugin` over three fixed, deterministic
 * transcripts (tool-heavy run, long chat, mixed run ending in a pending tool
 * call). Each transcript runs three compression rounds under critical
 * pressure; before rounds 2 and 3 a fixed batch larger than the recent window
 * is appended. After round 3 one more critical-pressure call with no new
 * messages checks idempotence.
 *
 * Provider-free: the summary model is a deterministic fake. The token counter
 * is the context package's `TiktokenCounter` when its optional tokenizer
 * resolves, otherwise the chars/4 `CharEstimateCounter`; either way it is
 * passed explicitly as `autoCompressConfig.tokenCounter`.
 *
 * One `MC04A_RESULT <json>` line is printed per transcript.
 *
 * MC-04b (MEMCTX-CACHE-PREFIX-20261108-R1), case e/f extension: every step
 * also measures the serialized Anthropic payload (`convertPromptToAnthropic`,
 * local only) from the start of `system` through the system breakpoint, and
 * asserts it is byte-identical across all rounds and the idempotence check.
 * A fourth, cache-eligible fixture repeats the long chat with an instruction
 * block of at least 1 400 o200k tokens; the original three are the disclosed
 * short-prefix case (structurally stable, not cache-eligible).
 *
 * All placement and gating is production `@dzupagent/context` code
 * (`applyCacheBreakpoints` for structural placement, the injector for the
 * gated payload and `cacheMarkers*`). MC-04b gates run this file with the
 * isolated candidate resolution (`--config
 * node_modules/.mc04b-candidate/vitest.config.mts`, aliasing
 * `@dzupagent/context` to this worktree's `packages/context/src`).
 */
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatPromptValue } from '@langchain/core/prompt_values'
import { convertPromptToAnthropic } from '@langchain/anthropic'
import {
  CharEstimateCounter,
  TiktokenCounter,
  TokenLifecycleManager,
  applyCacheBreakpoints,
  createTokenBudget,
  injectPromptCacheMarkersForModel,
  type TokenCounter,
} from '@dzupagent/context'
import { createTokenLifecyclePlugin } from '../token-lifecycle-wiring.js'
import type { AutoCompressConfig } from '../context/auto-compress.js'

// ---------- Counter selection ------------------------------------------------

/** Model id every count in this file uses (o200k encoding under tiktoken). */
const COUNT_MODEL_ID = 'gpt-4o'
/** Claude id handed to the cache injector (it only places markers for Claude). */
const CLAUDE_MODEL_ID = 'claude-sonnet-4-6'

function jsTiktokenResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('js-tiktoken')
    return true
  } catch {
    return false
  }
}

const tiktokenProbe = new TiktokenCounter().countDetailed('counter probe text', COUNT_MODEL_ID)
/** `TiktokenCounter` reports `heuristic` only when its tokenizer backend is unavailable. */
const TIKTOKEN_ACTIVE = tiktokenProbe.method !== 'heuristic'
const COUNTER: TokenCounter = TIKTOKEN_ACTIVE ? new TiktokenCounter() : new CharEstimateCounter()
const COUNTER_INFO = {
  name: TIKTOKEN_ACTIVE ? 'TiktokenCounter' : 'CharEstimateCounter',
  jsTiktokenResolvable: jsTiktokenResolvable(),
  probeMethod: tiktokenProbe.method,
  encoding: tiktokenProbe.encoding ?? null,
  countModelId: COUNT_MODEL_ID,
}

// ---------- Compression configuration ----------------------------------------

const KEEP = 6
const AUTO_CONFIG: AutoCompressConfig = {
  maxMessages: 12,
  keepRecentMessages: KEEP,
  maxMessageTokens: 6_000,
  // Larger than any recent window here, so tool results inside the kept
  // window are never pruned and the window can be compared verbatim.
  preserveRecentToolResults: 8,
  tokenCounter: COUNTER,
  summaryModelId: COUNT_MODEL_ID,
}

/** Manager budget; `CRITICAL_CHARGE` lands at 96 % (critical is >= 95 %, exhausted >= 100 %). */
const BUDGET_TOTAL = 10_000
const CRITICAL_CHARGE = 9_600

const SUMMARY_HEADER = '## Prior Conversation Context'
const SUMMARY_PREFIX = `${SUMMARY_HEADER}\n\n`

// ---------- Deterministic text -------------------------------------------------

const VOCAB = [
  'agent', 'context', 'budget', 'token', 'summary', 'window', 'message', 'tool',
  'result', 'file', 'path', 'packages/agent/src', 'compress', 'round', 'cache',
  'prefix', 'retry', 'error', 'value', 'config', 'stream', 'session', 'record',
  'export', 'import', 'function', 'return', 'const', 'await', 'async', 'string',
  'number', 'boolean', 'array', 'index', 'length', 'slice', 'merge', 'branch',
  'commit', 'review', 'lease', 'claim', 'worktree', 'gate', 'suite', 'typecheck',
  'measure', 'eval', 'fixture', 'deterministic', 'provider', 'model', 'counter',
  'threshold', 'pressure', 'critical', 'warn', 'ok', 'exhausted', 'reset',
  '{', '}', '(', ')', '=>', ';', '.', ',', '42', '1024', '0.95', 'null',
]

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** Deterministic pseudo-text of at least `chars` characters (LCG over `VOCAB`). */
function text(seed: string, chars: number): string {
  let state = hashSeed(seed)
  const words: string[] = []
  let length = 0
  while (length < chars) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const word = VOCAB[state % VOCAB.length]!
    words.push(word)
    length += word.length + 1
  }
  return words.join(' ')
}

// ---------- Fixed instructions --------------------------------------------------

const NAMED_CONSTRAINTS = [
  'C1-NO-PROD-WRITES: never write to a production database.',
  'C2-PATH-SCOPE: edit only files under packages/agent/src.',
  'C3-SPEND-CAP: stop before spend reaches USD 10.',
  'C4-CITE-ADMISSION: every commit cites MEMCTX-COMPRESS-MEASURE-20261108-R1.',
]

const INSTRUCTIONS = [
  'You are the MC-04a fixture agent.',
  '',
  'Named constraints (must survive every compression verbatim):',
  ...NAMED_CONSTRAINTS.map(c => `- ${c}`),
  '',
  'Working policy:',
  text('instructions-policy', 1_600),
  '',
  'Answer concisely and cite file paths.',
].join('\n')

/** Case f: the cache-eligible instruction block (>= 1 400 o200k tokens, no trailing whitespace). */
const LONG_INSTRUCTIONS = [
  'You are the MC-04b cache-eligible fixture agent.',
  '',
  'Named constraints (must survive every compression verbatim):',
  ...NAMED_CONSTRAINTS.map(c => `- ${c}`),
  '',
  'Working policy:',
  text('instructions-policy', 1_600),
  '',
  'Extended policy:',
  text('instructions-policy-extended', 6_400),
  '',
  'Answer concisely and cite file paths.',
].join('\n')

/** Eligibility margin over Anthropic's 1 024-token minimum (o200k estimate). */
const ELIGIBLE_PREFIX_TOKENS = 1_400

// ---------- Transcript builders --------------------------------------------------

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, args, type: 'tool_call' as const }
}

function aiCalls(textContent: string, calls: ReturnType<typeof toolCall>[]): AIMessage {
  return new AIMessage({ content: textContent, tool_calls: calls })
}

function toolResult(id: string, name: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id, name })
}

interface Fixture {
  name: 'tool-heavy' | 'long-chat' | 'mixed-pending' | 'eligible-long-chat'
  /** Instruction text of the leading system message. */
  instructions: string
  /** Case f: `short-prefix` (disclosed negative) or `cache-eligible`. */
  prefixClass: 'short-prefix' | 'cache-eligible'
  initial: () => BaseMessage[]
  /** Fixed batch appended before round `round` (2 or 3). */
  batch: (round: number) => BaseMessage[]
  /** Messages at the end of every round's input that form a pending tool-call tail. */
  pendingTail: number
  /** Tool-call ids in that tail that have no result yet, per round input. */
  pendingIds: (round: number) => string[]
}

function toolHeavyInitial(): BaseMessage[] {
  const out: BaseMessage[] = [
    new SystemMessage(INSTRUCTIONS),
    new HumanMessage(`Audit the token lifecycle wiring. ${text('th-task', 300)}`),
  ]
  for (let i = 0; i < 7; i++) {
    const id = `th-r1-${i}`
    out.push(aiCalls(`Reading file ${i}.`, [toolCall(id, 'read_file', { path: `packages/agent/src/f${i}.ts` })]))
    out.push(toolResult(id, 'read_file', text(`th-result-${i}`, 2_400)))
  }
  // One parallel exchange with two results.
  out.push(aiCalls('Running both greps.', [
    toolCall('th-r1-p1', 'grep', { pattern: 'compress' }),
    toolCall('th-r1-p2', 'grep', { pattern: 'summary' }),
  ]))
  out.push(toolResult('th-r1-p1', 'grep', text('th-grep-1', 1_200)))
  out.push(toolResult('th-r1-p2', 'grep', text('th-grep-2', 1_200)))
  out.push(new AIMessage(`Findings so far: ${text('th-findings', 400)}`))
  return out
}

function toolHeavyBatch(round: number): BaseMessage[] {
  const out: BaseMessage[] = [new HumanMessage(`Continue the audit, round ${round}. ${text(`th-b${round}-ask`, 200)}`)]
  for (let i = 0; i < 4; i++) {
    const id = `th-r${round}-${i}`
    out.push(aiCalls(`Round ${round} read ${i}.`, [toolCall(id, 'read_file', { path: `packages/agent/src/r${round}-${i}.ts` })]))
    out.push(toolResult(id, 'read_file', text(`th-b${round}-result-${i}`, 2_400)))
  }
  out.push(new AIMessage(`Round ${round} findings: ${text(`th-b${round}-findings`, 400)}`))
  return out // 10 messages
}

function longChatInitial(): BaseMessage[] {
  const out: BaseMessage[] = [new SystemMessage(INSTRUCTIONS)]
  for (let i = 0; i < 30; i++) {
    out.push(new HumanMessage(`Question ${i}: ${text(`lc-q-${i}`, 400)}`))
    out.push(new AIMessage(`Answer ${i}: ${text(`lc-a-${i}`, 400)}`))
  }
  return out
}

function longChatBatch(round: number): BaseMessage[] {
  const out: BaseMessage[] = []
  for (let i = 0; i < 5; i++) {
    out.push(new HumanMessage(`Round ${round} question ${i}: ${text(`lc-b${round}-q-${i}`, 400)}`))
    out.push(new AIMessage(`Round ${round} answer ${i}: ${text(`lc-b${round}-a-${i}`, 400)}`))
  }
  return out // 10 messages
}

/** Pending tail of round `round`'s input: AI with calls a (answered) and b (pending). */
function mixedTail(round: number): BaseMessage[] {
  return [
    aiCalls(`Round ${round}: check both builds.`, [
      toolCall(`mx-r${round}-a`, 'run_build', { target: 'agent' }),
      toolCall(`mx-r${round}-b`, 'run_build', { target: 'context' }),
    ]),
    toolResult(`mx-r${round}-a`, 'run_build', text(`mx-r${round}-a-out`, 900)),
  ]
}

function mixedInitial(): BaseMessage[] {
  const out: BaseMessage[] = [
    new SystemMessage(INSTRUCTIONS),
    new HumanMessage(`Fix the flaky build. ${text('mx-task', 300)}`),
  ]
  for (let i = 0; i < 5; i++) {
    out.push(new AIMessage(`Plan step ${i}: ${text(`mx-plan-${i}`, 350)}`))
    const id = `mx-r1-${i}`
    out.push(aiCalls(`Inspecting ${i}.`, [toolCall(id, 'read_file', { path: `packages/agent/src/m${i}.ts` })]))
    out.push(toolResult(id, 'read_file', text(`mx-result-${i}`, 1_800)))
    out.push(new HumanMessage(`Follow-up ${i}: ${text(`mx-follow-${i}`, 250)}`))
  }
  out.push(...mixedTail(1))
  return out
}

function mixedBatch(round: number): BaseMessage[] {
  const prev = round - 1
  const id = `mx-r${round}-c`
  return [
    // Answer the previous round's pending call, so that exchange becomes complete.
    toolResult(`mx-r${prev}-b`, 'run_build', text(`mx-r${prev}-b-out`, 900)),
    new AIMessage(`Round ${round}: both builds reported. ${text(`mx-b${round}-ack`, 300)}`),
    new HumanMessage(`Round ${round}: retry the context build. ${text(`mx-b${round}-ask`, 250)}`),
    aiCalls(`Round ${round}: retrying.`, [toolCall(id, 'run_build', { target: 'context', retry: true })]),
    toolResult(id, 'run_build', text(`mx-b${round}-retry-out`, 1_500)),
    new HumanMessage(`Round ${round}: anything else? ${text(`mx-b${round}-q`, 200)}`),
    new AIMessage(`Round ${round}: one more check. ${text(`mx-b${round}-plan`, 300)}`),
    new HumanMessage(`Round ${round}: go ahead.`),
    ...mixedTail(round),
  ] // 10 messages, ends in a new pending tail
}

function eligibleLongChatInitial(): BaseMessage[] {
  return [new SystemMessage(LONG_INSTRUCTIONS), ...longChatInitial().slice(1)]
}

const SHORT = { instructions: INSTRUCTIONS, prefixClass: 'short-prefix' as const }

const FIXTURES: Fixture[] = [
  { name: 'tool-heavy', ...SHORT, initial: toolHeavyInitial, batch: toolHeavyBatch, pendingTail: 0, pendingIds: () => [] },
  { name: 'long-chat', ...SHORT, initial: longChatInitial, batch: longChatBatch, pendingTail: 0, pendingIds: () => [] },
  {
    name: 'mixed-pending',
    ...SHORT,
    initial: mixedInitial,
    batch: mixedBatch,
    pendingTail: 2,
    pendingIds: round => [`mx-r${round}-b`],
  },
  {
    name: 'eligible-long-chat',
    instructions: LONG_INSTRUCTIONS,
    prefixClass: 'cache-eligible',
    initial: eligibleLongChatInitial,
    batch: longChatBatch,
    pendingTail: 0,
    pendingIds: () => [],
  },
]

// ---------- Fake summary model ---------------------------------------------------

/** Deterministic, invoke-only summary model; records every prompt it receives. */
function makeSummaryModel(fixture: string) {
  const prompts: string[] = []
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      const last = messages[messages.length - 1]
      const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
      prompts.push(prompt)
      const folded = (prompt.match(/^\[(human|ai|tool|system)\]: /gm) ?? []).length
      return new AIMessage([
        '## Goal',
        `Finish the ${fixture} fixture task.`,
        '## Constraints',
        '- Follow the leading instructions.',
        '## Progress',
        '### Done',
        `- Summary pass ${prompts.length} folded ${folded} messages.`,
        '### In Progress',
        '- Continue from the recent window.',
        '### Blocked',
        '- None',
        '## Key Decisions',
        '- Keep the instructions out of the summary.',
        '## Relevant Files',
        '- packages/agent/src/token-lifecycle-wiring.ts',
        '## Next Steps',
        '- Resume the run.',
      ].join('\n'))
    },
    model: 'mc04a-fake-summary',
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mc04a-fake',
  } as unknown as BaseChatModel
  return { model, prompts }
}

const CLAUDE_MODEL = { model: CLAUDE_MODEL_ID } as unknown as BaseChatModel

// ---------- Measurement helpers ----------------------------------------------------

function contentText(m: BaseMessage): string {
  if (typeof m.content === 'string') return m.content
  // MC-04b: a text-only block array (the prepared/compressed system message)
  // reads as its joined text, which equals the former single string.
  const blocks = m.content as Array<{ type?: unknown; text?: unknown }>
  if (blocks.every(b => b.type === 'text' && typeof b.text === 'string')) {
    return blocks.map(b => b.text as string).join('')
  }
  return JSON.stringify(m.content)
}

function toolCallsOf(m: BaseMessage): ReturnType<typeof toolCall>[] {
  if (m._getType() !== 'ai') return []
  return ((m as AIMessage).tool_calls ?? []) as ReturnType<typeof toolCall>[]
}

/** Tokens the provider would receive for a message: its content plus any tool calls. */
function messageTokens(m: BaseMessage): number {
  const calls = toolCallsOf(m)
  const extra = calls.length > 0 ? JSON.stringify(calls) : ''
  return COUNTER.count(contentText(m) + extra, COUNT_MODEL_ID)
}

function totalTokens(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

function fingerprint(m: BaseMessage): string {
  return JSON.stringify({
    type: m._getType(),
    content: m.content,
    toolCalls: toolCallsOf(m).map(c => ({ id: c.id, name: c.name, args: c.args })),
    toolCallId: m._getType() === 'tool' ? (m as ToolMessage).tool_call_id : undefined,
    name: m.name,
  })
}

function cacheMarkers(messages: BaseMessage[]): number {
  return injectPromptCacheMarkersForModel(messages, CLAUDE_MODEL).filter(
    m => (m.additional_kwargs as { cache_control?: unknown }).cache_control !== undefined,
  ).length
}

/**
 * MC-04b: the payload `system` field the installed converter produces for the
 * cached messages, cut through the system breakpoint.
 */
interface PrefixMeasure {
  /** Index of the system block carrying `cache_control` (-1 when none). */
  breakpointIndex: number
  /** Serialized system blocks from the start through the breakpoint. */
  bytes: string
  /** Text of those blocks, for the o200k token estimate. */
  text: string
  /**
   * Whether the production injector's size gate (item 4) opened for this
   * prompt. Structural placement above is measured independent of it.
   */
  cacheGateOpen: boolean
  /** System breakpoint index in the gated (injector) payload; `null` when the gate stayed closed. */
  gatedBreakpointIndex: number | null
}

function systemBreakpoint(messages: BaseMessage[]) {
  const payload = convertPromptToAnthropic(new ChatPromptValue(messages)) as { system?: unknown }
  const system = (typeof payload.system === 'string'
    ? [{ type: 'text', text: payload.system }]
    : (payload.system ?? [])) as Array<{ text?: string; cache_control?: unknown }>
  return system.findIndex(b => b.cache_control !== undefined)
}

function prefixMeasure(messages: BaseMessage[]): PrefixMeasure {
  // Structural placement: production `applyCacheBreakpoints`, independent of the size gate.
  const cached = applyCacheBreakpoints(messages)
  // Gated payload: what the production injector emits (unchanged array when its gate stays closed).
  const gated = injectPromptCacheMarkersForModel(messages, CLAUDE_MODEL)
  const gateOpen = gated !== messages
  const gatedBreakpointIndex = gateOpen ? systemBreakpoint(gated) : null
  const payload = convertPromptToAnthropic(new ChatPromptValue(cached)) as { system?: unknown }
  const system = (typeof payload.system === 'string'
    ? [{ type: 'text', text: payload.system }]
    : (payload.system ?? [])) as Array<{ text?: string; cache_control?: unknown }>
  const breakpointIndex = system.findIndex(b => b.cache_control !== undefined)
  const through = breakpointIndex < 0 ? [] : system.slice(0, breakpointIndex + 1)
  return {
    breakpointIndex,
    bytes: JSON.stringify(through),
    text: through.map(b => b.text ?? '').join(''),
    cacheGateOpen: gateOpen,
    gatedBreakpointIndex,
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let from = haystack.indexOf(needle)
  while (from >= 0) {
    count++
    from = haystack.indexOf(needle, from + needle.length)
  }
  return count
}

/**
 * Immutable, serialized record of one message. Built only from strings and
 * frozen arrays, so a later call that mutates the live message object (or
 * returns the same array with mutated members) cannot change it.
 */
interface MessageSnapshot {
  readonly type: string
  readonly text: string
  readonly toolCallIds: readonly string[]
  readonly toolCallId: string | undefined
  /** Deep serialized role, content, tool calls, tool-call id and name. */
  readonly fp: string
}

function snapshot(messages: readonly BaseMessage[]): readonly MessageSnapshot[] {
  return Object.freeze(messages.map(m => Object.freeze({
    type: m._getType(),
    text: contentText(m),
    toolCallIds: Object.freeze(toolCallsOf(m).map(c => c.id)),
    toolCallId: m._getType() === 'tool' ? (m as ToolMessage).tool_call_id : undefined,
    fp: fingerprint(m),
  })))
}

// ---------- Scenario -------------------------------------------------------------

/**
 * Evidence for one call. It holds no live message reference: every `before`
 * value is captured before `maybeCompress` runs, every `after` value right
 * after it returns and before the next call.
 */
interface Step {
  label: 'round-1' | 'round-2' | 'round-3' | 'idempotence'
  input: readonly MessageSnapshot[]
  output: readonly MessageSnapshot[]
  /** The call received exactly the previous call's returned array (or the fixture plus a batch). */
  inputIsPreviousOutput: boolean
  compressed: boolean
  summary: string | null
  statusBefore: string
  statusAfter: string
  tokensBefore: number
  tokensAfter: number
  cacheMarkersBefore: number
  cacheMarkersAfter: number
  summaryCallsBefore: number
  summaryCallsAfter: number
  prefixBefore: PrefixMeasure
  prefixAfter: PrefixMeasure
}

interface Run {
  steps: Step[]
  prompts: string[]
}

async function runScenario(fixture: Fixture): Promise<Run> {
  const manager = new TokenLifecycleManager({
    budget: createTokenBudget(BUDGET_TOTAL, 0),
    warnThresholdPct: 0.8,
    criticalThresholdPct: 0.95,
  })
  const plugin = createTokenLifecyclePlugin(manager, { autoCompressConfig: AUTO_CONFIG })
  const { model, prompts } = makeSummaryModel(fixture.name)
  const steps: Step[] = []
  let transcript = fixture.initial()
  let previousOutput: BaseMessage[] | null = null

  const labels: Step['label'][] = ['round-1', 'round-2', 'round-3', 'idempotence']
  for (const [i, label] of labels.entries()) {
    const round = i + 1
    const batched = round === 2 || round === 3
    if (batched) transcript = [...transcript, ...fixture.batch(round)]
    plugin.trackPhase('input', CRITICAL_CHARGE)
    const input = transcript
    // Before-state, captured before the call can touch any message.
    const statusBefore = plugin.status
    const summaryCallsBefore = prompts.length
    const inputSnapshot = snapshot(input)
    const tokensBefore = totalTokens(input)
    const cacheMarkersBefore = cacheMarkers(input)
    const prefixBefore = prefixMeasure(input)
    const inputIsPreviousOutput = previousOutput === null || batched || input === previousOutput

    const result = await plugin.maybeCompress(input, model)

    // After-state, captured immediately, before any later call runs.
    steps.push({
      label,
      input: inputSnapshot,
      output: snapshot(result.messages),
      inputIsPreviousOutput,
      compressed: result.compressed,
      summary: result.summary,
      statusBefore,
      statusAfter: plugin.status,
      tokensBefore,
      tokensAfter: totalTokens(result.messages),
      cacheMarkersBefore,
      cacheMarkersAfter: cacheMarkers(result.messages),
      summaryCallsBefore,
      summaryCallsAfter: prompts.length,
      prefixBefore,
      prefixAfter: prefixMeasure(result.messages),
    })
    previousOutput = result.messages
    transcript = result.messages
  }
  plugin.cleanup()
  return { steps, prompts }
}

/** Instruction text of a leading system message before its summary section. */
function instructionPrefix(content: string): string {
  const idx = content.indexOf(SUMMARY_PREFIX)
  if (idx < 0) return content
  // `writeSummary` joins instructions and summary with one blank line.
  return content.slice(0, idx).replace(/\n\n$/, '')
}

/** Case e/f: the reusable prefix across every measured payload of a run. */
function reusablePrefix(run: Run) {
  const measures = [run.steps[0]!.prefixBefore, ...run.steps.map(s => s.prefixAfter)]
  const stable = measures.every(m => m.breakpointIndex >= 0 && m.bytes === measures[0]!.bytes)
  // Informative only: leading serialized characters shared by every payload.
  let common = measures[0]!.bytes.length
  for (const m of measures) {
    let i = 0
    while (i < common && i < m.bytes.length && m.bytes[i] === measures[0]!.bytes[i]) i++
    common = i
  }
  const bytes = stable ? Buffer.byteLength(measures[0]!.bytes, 'utf8') : 0
  const tokens = stable ? COUNTER.count(measures[0]!.text, COUNT_MODEL_ID) : 0
  return {
    prefixStable: stable,
    payloads: measures.length,
    reusablePrefixBytes: bytes,
    reusablePrefixTokens: tokens,
    commonLeadingSerializedChars: common,
    eligible: stable && tokens >= ELIGIBLE_PREFIX_TOKENS,
  }
}

function stepRound(label: Step['label']): number {
  return label === 'idempotence' ? 3 : Number(label.slice('round-'.length))
}

// ---------- Tests ------------------------------------------------------------------

describe('MC-04a compression economy on fixed transcripts', () => {
  it('selects and records the token counter it passes to the plugin', () => {
    expect(AUTO_CONFIG.tokenCounter).toBe(COUNTER)
    expect(COUNTER_INFO.name).toBe(TIKTOKEN_ACTIVE ? 'TiktokenCounter' : 'CharEstimateCounter')
    expect(COUNTER.count(INSTRUCTIONS, COUNT_MODEL_ID)).toBeGreaterThan(0)
  })

  for (const fixture of FIXTURES) {
    describe(`transcript ${fixture.name}`, () => {
      let run: Run

      beforeAll(async () => {
        run = await runScenario(fixture)
      })

      it('drives the manager to critical pressure before every call', () => {
        for (const step of run.steps) {
          expect(step.statusBefore, step.label).toBe('critical')
        }
      })

      it('item 1: instruction prefix is byte-identical and there is exactly one summary section', () => {
        for (const step of run.steps) {
          const head = step.output[0]!
          expect(head.type, step.label).toBe('system')
          expect(instructionPrefix(head.text), step.label).toBe(fixture.instructions)
          for (const constraint of NAMED_CONSTRAINTS) {
            expect(instructionPrefix(head.text), `${step.label}: ${constraint}`).toContain(constraint)
          }
          const all = step.output.map(s => s.text).join('\n')
          expect(occurrences(all, SUMMARY_HEADER), step.label).toBe(1)
          expect(occurrences(head.text, SUMMARY_HEADER), step.label).toBe(1)
          // The section carries the summary this step reports.
          expect(head.text.slice(head.text.indexOf(SUMMARY_PREFIX) + SUMMARY_PREFIX.length), step.label)
            .toBe(step.summary)
          expect(step.output.slice(1).some(s => s.type === 'system'), step.label).toBe(false)
        }
        // Rolling summary integrity: rounds 2 and 3 update the previous summary.
        const rounds = run.steps.filter(s => s.label !== 'idempotence')
        for (const [i, step] of rounds.entries()) {
          expect(step.summaryCallsAfter - step.summaryCallsBefore, step.label).toBe(1)
          const prompt = run.prompts[step.summaryCallsBefore]!
          if (i === 0) {
            expect(prompt.startsWith('Conversation to summarize:'), step.label).toBe(true)
          } else {
            expect(prompt.startsWith('Existing summary to UPDATE'), step.label).toBe(true)
            expect(prompt, step.label).toContain(rounds[i - 1]!.summary!)
          }
        }
      })

      it('item 2: recent window and pending tool-call tail are kept verbatim, nothing orphaned', () => {
        for (const step of run.steps.filter(s => s.label !== 'idempotence')) {
          const tail = fixture.pendingTail
          const inBody = step.input.slice(1, step.input.length - tail)
          const outBody = step.output.slice(1, step.output.length - tail)
          // Pending tail verbatim and still last.
          // Compared as snapshots taken before and right after this call.
          expect(step.output.slice(step.output.length - tail).map(s => s.fp), step.label)
            .toEqual(step.input.slice(step.input.length - tail).map(s => s.fp))
          // The configured recent window (and any boundary-aligned extension) verbatim.
          expect(outBody.length, step.label).toBeGreaterThanOrEqual(KEEP)
          expect(outBody.map(s => s.fp), step.label)
            .toEqual(inBody.slice(inBody.length - outBody.length).map(s => s.fp))
          // No orphaned tool result or tool call, and no repair stub.
          const pending = new Set(fixture.pendingIds(stepRound(step.label)))
          const emitted = new Set<string>()
          for (const [i, s] of step.output.entries()) {
            for (const id of s.toolCallIds) {
              emitted.add(id)
              if (pending.has(id)) continue
              const answered = step.output.slice(i + 1).some(
                later => later.type === 'tool' && later.toolCallId === id,
              )
              expect(answered, `${step.label}: call ${id} answered`).toBe(true)
            }
            if (s.type === 'tool') {
              expect(emitted.has(s.toolCallId!), `${step.label}: result ${s.toolCallId} has its call`).toBe(true)
              expect(s.text, step.label).not.toContain('[Result unavailable')
            }
          }
          for (const id of pending) {
            expect(emitted.has(id), `${step.label}: pending call ${id} kept`).toBe(true)
          }
        }
      })

      it('item 3: every round lowers the token total, including its appended batch', () => {
        const rounds = run.steps.filter(s => s.label !== 'idempotence')
        expect(rounds).toHaveLength(3)
        for (const step of rounds) {
          expect(step.compressed, step.label).toBe(true)
          expect(step.statusAfter, step.label).toBe('ok')
          expect(step.tokensAfter, step.label).toBeLessThan(step.tokensBefore)
        }
        // Rounds 2 and 3 really carried a new batch larger than the window.
        for (const [i, step] of rounds.entries()) {
          if (i === 0) continue
          const appended = step.input.length - rounds[i - 1]!.output.length
          expect(appended, step.label).toBeGreaterThan(KEEP)
        }
      })

      it('item 4: idempotence call does not grow tokens and changes only the summary section', () => {
        const step = run.steps.find(s => s.label === 'idempotence')!
        const prev = run.steps.find(s => s.label === 'round-3')!
        // The call received round 3's returned array, unchanged since it was snapshotted.
        expect(step.inputIsPreviousOutput).toBe(true)
        expect(step.input.map(s => s.fp)).toEqual(prev.output.map(s => s.fp))
        // Before-values were captured before the call; after-values right after it.
        expect(step.tokensAfter).toBeLessThanOrEqual(step.tokensBefore)
        expect(step.output).toHaveLength(step.input.length)
        expect(step.output[0]!.type).toBe('system')
        expect(instructionPrefix(step.output[0]!.text)).toBe(instructionPrefix(step.input[0]!.text))
        expect(step.output.slice(1).map(s => s.fp)).toEqual(step.input.slice(1).map(s => s.fp))
      })

      it('case e: the instruction-prefix payload bytes through the system breakpoint are identical across all rounds and the idempotence check', () => {
        // Case a's precondition, checked on this fixture's instructions first.
        expect(fixture.instructions, 'no trailing whitespace').toBe(fixture.instructions.trimEnd())
        expect(`${fixture.instructions}\n\n`.includes(SUMMARY_PREFIX)).toBe(false)
        const expectedBytes = JSON.stringify([
          { type: 'text', text: fixture.instructions, cache_control: { type: 'ephemeral' } },
        ])
        for (const step of run.steps) {
          for (const [phase, m] of [['before', step.prefixBefore], ['after', step.prefixAfter]] as const) {
            expect(m.breakpointIndex, `${step.label} ${phase}`).toBe(0)
            expect(m.bytes, `${step.label} ${phase}`).toBe(expectedBytes)
            // Gated payload: when the production gate opens, the injector's system breakpoint is block 0 too;
            // when it stays closed there is no gated breakpoint (and no after-markers).
            expect(m.gatedBreakpointIndex, `${step.label} ${phase} gated`).toBe(m.cacheGateOpen ? 0 : null)
          }
          if (!step.prefixAfter.cacheGateOpen) expect(step.cacheMarkersAfter, step.label).toBe(0)
          // Production item-4 gate on the compressed outputs: the long chat compresses below 1024 tokenizer
          // tokens (gate closed); the other fixtures stay above it (gate open).
          expect(step.prefixAfter.cacheGateOpen, `${step.label} gate`).toBe(fixture.name !== 'long-chat')
        }
        expect(reusablePrefix(run).prefixStable).toBe(true)
      })

      it(`case f: reusable prefix is ${fixture.prefixClass === 'cache-eligible' ? 'stable and cache-eligible' : 'stable but reported ineligible (short prefix)'}`, () => {
        const reusable = reusablePrefix(run)
        expect(reusable.prefixStable).toBe(true)
        if (fixture.prefixClass === 'cache-eligible') {
          expect(COUNTER_INFO.name).toBe('TiktokenCounter')
          expect(reusable.reusablePrefixTokens).toBeGreaterThanOrEqual(ELIGIBLE_PREFIX_TOKENS)
          expect(reusable.eligible).toBe(true)
        } else {
          expect(reusable.reusablePrefixTokens).toBeLessThan(1_024)
          expect(reusable.eligible).toBe(false)
        }
      })

      it('prints the MC04A_RESULT measurement line', () => {
        const result = {
          transcript: fixture.name,
          counter: COUNTER_INFO,
          keepRecentMessages: KEEP,
          maxMessages: AUTO_CONFIG.maxMessages,
          maxMessageTokens: AUTO_CONFIG.maxMessageTokens,
          instructionPrefixTokens: COUNTER.count(fixture.instructions, COUNT_MODEL_ID),
          instructionPrefixChars: fixture.instructions.length,
          instructionsTrailingWhitespace: fixture.instructions !== fixture.instructions.trimEnd(),
          cacheModelId: CLAUDE_MODEL_ID,
          prefixClass: fixture.prefixClass,
          ...reusablePrefix(run),
          steps: run.steps.map(s => ({
            step: s.label,
            compressed: s.compressed,
            messagesBefore: s.input.length,
            messagesAfter: s.output.length,
            tokensBefore: s.tokensBefore,
            tokensAfter: s.tokensAfter,
            cacheMarkersBefore: s.cacheMarkersBefore,
            cacheMarkersAfter: s.cacheMarkersAfter,
            summaryCalls: s.summaryCallsAfter - s.summaryCallsBefore,
            breakpointIndexBefore: s.prefixBefore.breakpointIndex,
            breakpointIndexAfter: s.prefixAfter.breakpointIndex,
            cacheGateOpenBefore: s.prefixBefore.cacheGateOpen,
            cacheGateOpenAfter: s.prefixAfter.cacheGateOpen,
            gatedBreakpointIndexAfter: s.prefixAfter.gatedBreakpointIndex,
            prefixBytesAfter: Buffer.byteLength(s.prefixAfter.bytes, 'utf8'),
            prefixTokensAfter: COUNTER.count(s.prefixAfter.text, COUNT_MODEL_ID),
            prefixStable: s.prefixBefore.bytes === s.prefixAfter.bytes
              && s.prefixAfter.bytes === run.steps[0]!.prefixBefore.bytes,
          })),
        }
        console.log(`MC04A_RESULT ${JSON.stringify(result)}`)
        expect(result.steps).toHaveLength(4)
      })
    })
  }
})
