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
import {
  CharEstimateCounter,
  TiktokenCounter,
  TokenLifecycleManager,
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
  name: 'tool-heavy' | 'long-chat' | 'mixed-pending'
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

const FIXTURES: Fixture[] = [
  { name: 'tool-heavy', initial: toolHeavyInitial, batch: toolHeavyBatch, pendingTail: 0, pendingIds: () => [] },
  { name: 'long-chat', initial: longChatInitial, batch: longChatBatch, pendingTail: 0, pendingIds: () => [] },
  {
    name: 'mixed-pending',
    initial: mixedInitial,
    batch: mixedBatch,
    pendingTail: 2,
    pendingIds: round => [`mx-r${round}-b`],
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
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
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
          expect(instructionPrefix(head.text), step.label).toBe(INSTRUCTIONS)
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

      it('prints the MC04A_RESULT measurement line', () => {
        const result = {
          transcript: fixture.name,
          counter: COUNTER_INFO,
          keepRecentMessages: KEEP,
          maxMessages: AUTO_CONFIG.maxMessages,
          maxMessageTokens: AUTO_CONFIG.maxMessageTokens,
          instructionPrefixTokens: COUNTER.count(INSTRUCTIONS, COUNT_MODEL_ID),
          instructionPrefixChars: INSTRUCTIONS.length,
          cacheModelId: CLAUDE_MODEL_ID,
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
          })),
        }
        console.log(`MC04A_RESULT ${JSON.stringify(result)}`)
        expect(result.steps).toHaveLength(4)
      })
    })
  }
})
