/**
 * MC-03a (MEMCTX-OBS-RESTART-20261108-R1): ObservationalMemory survives a
 * restart and produces each fact exactly once.
 *
 * Every case runs on a real MemoryService over `createStore({ type: 'memory' })`,
 * keeps the same store object across "restarts" (a restart builds a new
 * ObservationalMemory), runs candidate-first with a
 * MemoryServiceObservationCandidateStore and `observerDebounceMs: 0`.
 *
 * The model is a deterministic fake: for each distinct marker `Mk` in its
 * input it returns the fixed fact `Fk`, citing the label of the message that
 * carries `Mk` (the extractor resolves the label to that message's id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { BaseStore } from '@langchain/langgraph'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  AIMessage,
  BaseMessage,
  ChatMessage,
  FunctionMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type { MessageType } from '@langchain/core/messages'
import { StagedWriter } from '../staged-writer.js'
import { ObservationalMemory } from '../observational-memory.js'
import type {
  ObservationalMemoryConfig,
  ObservationLifecycleEvent,
} from '../observational-memory.js'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import { MemoryServiceObservationCandidateStore } from '../observation-candidate-store.js'
import type { ObservationCandidateStore } from '../observation-candidate-store.js'
import {
  BaseStoreObservationBufferStore,
  deserializeObservationMessage,
  serializeObservationMessage,
} from '../observation-buffer-store.js'
import type { StagedRecord } from '../staged-writer.js'

// ---------------------------------------------------------------------------
// Fixed oracle: marker -> fact -> source message (id, role, text)
// ---------------------------------------------------------------------------

const SCOPE = { tenantId: 't1', userId: 'u1' }
const OBS_NS = 'observations'
const CAND_NS = 'observation-candidates'
const BUF_NS = 'observation-buffer'
const BUF_KEY = `observation-buffer:${OBS_NS}`

const FACTS: Record<string, string> = {
  M1: 'The release train leaves every tuesday morning',
  M2: 'Invoices are archived for seven years',
  M3: 'Staging deploys require two reviewers',
  M4: 'The design team prefers dark colour themes',
  M5: 'Customer exports run nightly from the warehouse',
  M6: 'Mobile builds ship through the beta channel first',
  M7: 'Support tickets close after fourteen quiet days',
}

const SOURCE_TEXT: Record<number, string> = {
  1: 'we always ship on tuesday morning',
  2: 'finance keeps every invoice for seven years',
  3: 'staging needs two approvals',
  4: 'designers asked for dark themes',
  5: 'exports come from the warehouse each night',
  6: 'mobile goes to beta before release',
  7: 'quiet tickets get closed automatically',
}

function userText(k: number): string {
  return `Turn ${k} note: M${k} ${SOURCE_TEXT[k]}`
}

/** One turn: the user message carries marker `Mk`, the reply carries none. */
function turn(k: number): BaseMessage[] {
  return [
    new HumanMessage({ id: `u${k}`, content: userText(k) }),
    new AIMessage({ id: `a${k}`, content: `Noted turn ${k}.` }),
  ]
}

function turnContents(...turns: number[]): string[] {
  return turns.flatMap(k => turn(k).map(message => message.content as string))
}

const ORACLE: Record<string, { fact: string; source: { id: string; role: string; text: string } }> =
  Object.fromEntries(
    Object.keys(FACTS).map(marker => {
      const k = Number(marker.slice(1))
      return [marker, { fact: FACTS[marker]!, source: { id: `u${k}`, role: 'human', text: userText(k) } }]
    }),
  )

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The stored or staged value cites exactly its true source message. */
function assertEvidence(value: Record<string, unknown>, marker: string): void {
  const { source } = ORACLE[marker]!
  expect(value['evidenceReferences']).toEqual([{
    ref: `observation-message:unscoped:${source.id}`,
    messageId: source.id,
    role: source.role,
    contentDigest: sha256(`${source.role}\u0000${source.text}`),
    excerpt: source.text,
  }])
}

/** Exact non-empty fact set and count, each with the oracle's evidence. */
function assertFactsExactlyOnce(values: Record<string, unknown>[], markers: string[]): void {
  expect(markers.length).toBeGreaterThan(0)
  expect(values.map(value => value['text']).sort())
    .toEqual(markers.map(marker => FACTS[marker]).sort())
  expect(values).toHaveLength(markers.length)
  for (const value of values) {
    const marker = markers.find(m => FACTS[m] === value['text'])!
    assertEvidence(value, marker)
  }
}

// ---------------------------------------------------------------------------
// Deterministic fake model
// ---------------------------------------------------------------------------

interface Gate {
  promise: Promise<void>
  open(): void
}

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

class FakeModel {
  /** Message contents presented on each call, in order. */
  readonly calls: string[][] = []
  /** Full conversation text presented on each call. */
  readonly prompts: string[] = []
  confidence = 0.9
  failNext = 0
  empty = false
  /** Negative control: cite an existing but wrong message. */
  wrongCitation = false
  private hold: { release: Gate; entered: Gate } | null = null

  blockNextCall(): { release: Gate; entered: Gate } {
    this.hold = { release: gate(), entered: gate() }
    return this.hold
  }

  async invoke(prompt: BaseMessage[]): Promise<{ content: string }> {
    const text = prompt[1]!.content as string
    const lines = [...text.matchAll(/^\[(m\d+)\] (\w+): (.*)$/gm)]
    this.calls.push(lines.map(line => line[3]!))
    this.prompts.push(text)
    const hold = this.hold
    if (hold) {
      this.hold = null
      hold.entered.open()
      await hold.release.promise
    }
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('fake model unavailable')
    }
    if (this.empty) return { content: '[]' }
    const seen = new Set<string>()
    const out: Array<Record<string, unknown>> = []
    lines.forEach((line, index) => {
      for (const marker of line[3]!.match(/\bM\d+\b/g) ?? []) {
        if (seen.has(marker) || !FACTS[marker]) continue
        seen.add(marker)
        const label = this.wrongCitation
          ? lines[(index + 1) % lines.length]![1]!
          : line[1]!
        out.push({ text: FACTS[marker], category: 'fact', confidence: this.confidence, evidenceRefs: [label] })
      }
    })
    return { content: JSON.stringify(out) }
  }
}

// ---------------------------------------------------------------------------
// Store wrapper: reject, block, or delay delivery per method and namespace
// ---------------------------------------------------------------------------

type StoreMethod = 'get' | 'put' | 'search' | 'delete'

interface StoreRule {
  method: StoreMethod
  ns: string
  mode: 'reject' | 'block' | 'delay-result'
  remaining: number
  entered: Gate
  release: Gate
}

class ControlledStore {
  readonly store: BaseStore
  readonly calls: Array<{ method: StoreMethod; ns: string }> = []
  private readonly rules: StoreRule[] = []

  constructor(readonly base: BaseStore) {
    this.store = new Proxy(base, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target) as unknown
        if (typeof value !== 'function') return value
        const fn = (value as (...args: unknown[]) => unknown).bind(target)
        if (prop === 'get' || prop === 'put' || prop === 'search' || prop === 'delete') {
          return (...args: unknown[]) => this.intercept(prop, args, fn)
        }
        return fn
      },
    })
  }

  on(method: StoreMethod, ns: string, mode: StoreRule['mode'], times = Infinity): StoreRule {
    const rule: StoreRule = { method, ns, mode, remaining: times, entered: gate(), release: gate() }
    this.rules.push(rule)
    return rule
  }

  off(rule: StoreRule): void {
    rule.remaining = 0
    rule.release.open()
  }

  count(method: StoreMethod, ns: string): number {
    return this.calls.filter(call => call.method === method && call.ns === ns).length
  }

  /** The durable backlog record, read straight from the unwrapped store. */
  async bufferRecord(): Promise<Record<string, unknown> | null> {
    const item = await this.base.get([BUF_NS, SCOPE.tenantId, SCOPE.userId], BUF_KEY)
    return (item?.value as Record<string, unknown> | undefined) ?? null
  }

  private async intercept(
    method: StoreMethod,
    args: unknown[],
    call: (...args: unknown[]) => unknown,
  ): Promise<unknown> {
    const ns = (args[0] as string[])[0]!
    this.calls.push({ method, ns })
    const rule = this.rules.find(r => r.method === method && r.ns === ns && r.remaining > 0)
    if (!rule) return call(...args)
    rule.remaining--
    rule.entered.open()
    if (rule.mode === 'reject') throw new Error(`${method} on ${ns} unavailable`)
    if (rule.mode === 'block') {
      await rule.release.promise
      return call(...args)
    }
    const result = await call(...args)
    await rule.release.promise
    return result
  }
}

/** Candidate-store wrapper whose `put` returns false or throws for chosen records. */
class FlakyCandidateStore implements ObservationCandidateStore {
  failing: ((record: StagedRecord) => boolean) | null = null
  mode: 'false' | 'throw' = 'false'
  /** Number of upcoming getReceipt / remove calls that reject. */
  receiptFailures = 0
  removeFailures = 0

  constructor(private readonly inner: MemoryServiceObservationCandidateStore) {}

  load(ns: string, scope: Record<string, string>) { return this.inner.load(ns, scope) }
  loadWithStatus(ns: string, scope: Record<string, string>) { return this.inner.loadWithStatus(ns, scope) }
  async put(record: StagedRecord): Promise<boolean> {
    if (this.failing?.(record)) {
      if (this.mode === 'throw') throw new Error('candidate store unavailable')
      return false
    }
    return this.inner.put(record)
  }
  async remove(record: StagedRecord): Promise<boolean> {
    if (this.removeFailures > 0) {
      this.removeFailures--
      throw new Error('candidate cleanup unavailable')
    }
    return this.inner.remove(record)
  }
  async getReceipt(ns: string, scope: Record<string, string>, key: string) {
    if (this.receiptFailures > 0) {
      this.receiptFailures--
      throw new Error('receipt read unavailable')
    }
    return this.inner.getReceipt(ns, scope, key)
  }
  putReceipt(...args: Parameters<ObservationCandidateStore['putReceipt']>) { return this.inner.putReceipt(...args) }
  prune(...args: Parameters<ObservationCandidateStore['prune']>) { return this.inner.prune(...args) }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function harness() {
  const base = await createStore({ type: 'memory' })
  const ctl = new ControlledStore(base)
  const memoryService = new MemoryService(ctl.store, [
    { name: OBS_NS, scopeKeys: ['tenantId', 'userId'], searchable: false },
    { name: CAND_NS, scopeKeys: ['tenantId', 'userId'], searchable: false },
  ])
  const candidateStore = new MemoryServiceObservationCandidateStore(memoryService, CAND_NS)
  const pendingBuffer = new BaseStoreObservationBufferStore({
    store: ctl.store,
    namespace: BUF_NS,
    scopeKeys: ['tenantId', 'userId'],
  })
  const model = new FakeModel()
  const events: ObservationLifecycleEvent[] = []

  /** A new process: a fresh ObservationalMemory over the same store object. */
  function start(overrides: Partial<ObservationalMemoryConfig> = {}): ObservationalMemory {
    return new ObservationalMemory({
      model: model as unknown as BaseChatModel,
      memoryService,
      store: ctl.store,
      namespace: OBS_NS,
      scope: SCOPE,
      observerThreshold: 8,
      observerDebounceMs: 0,
      observationWriteMode: 'candidate-first',
      candidateStore,
      pendingBuffer,
      onObservationLifecycleEvent: event => events.push(event),
      ...overrides,
    })
  }

  /** Every count uses MemoryService.get. */
  async function stored(): Promise<Record<string, unknown>[]> {
    return memoryService.get(OBS_NS, SCOPE)
  }

  async function confirmAll(om: ObservationalMemory): Promise<void> {
    for (const candidate of await om.listPendingObservationCandidates()) {
      await om.confirmObservation(candidate.key)
    }
    await om.flushConfirmedObservations()
  }

  async function durableCandidates(): Promise<StagedRecord[]> {
    const loaded = await candidateStore.loadWithStatus(OBS_NS, SCOPE)
    return loaded.status === 'loaded' ? loaded.records : []
  }

  function eventsOf(type: ObservationLifecycleEvent['type']): ObservationLifecycleEvent[] {
    return events.filter(event => event.type === type)
  }

  return { base, ctl, memoryService, candidateStore, pendingBuffer, model, events, start, stored, confirmAll, durableCandidates, eventsOf }
}

/** Staged writer contents (internal). */
function writerRecords(om: ObservationalMemory): StagedRecord[] {
  return (om as unknown as { stagedWriter: { getAll(): StagedRecord[] } }).stagedWriter.getAll()
}

/** Records being flushed (internal; absent at the start base). */
function inFlight(om: ObservationalMemory): Map<string, StagedRecord> {
  return (om as unknown as { inFlightFlushes?: Map<string, StagedRecord> }).inFlightFlushes ?? new Map()
}

function bufferState(om: ObservationalMemory): { counted: number; buffered: number } {
  const internals = om as unknown as { messagesSinceLastRun: number; pendingMessages: BaseMessage[] }
  return { counted: internals.messagesSinceLastRun, buffered: internals.pendingMessages.length }
}

function recordIds(record: Record<string, unknown> | null): string[] {
  const messages = (record?.['messages'] as Array<{ id?: string }> | undefined) ?? []
  return messages.map(message => message.id ?? '?')
}

function recordsWithFact(records: StagedRecord[], marker: string): StagedRecord[] {
  return records.filter(record => record.value['text'] === FACTS[marker])
}

/**
 * Durability boundary. The start-base red proof runs this file against the
 * base `observational-memory.ts`, which has no `whenBufferPersisted`; there
 * the boundary is a no-op so the case fails on its real assertion.
 */
async function persistBoundary(om: ObservationalMemory): Promise<void> {
  const fn = (om as unknown as { whenBufferPersisted?: () => Promise<{ persisted: boolean }> })
    .whenBufferPersisted
  if (typeof fn !== 'function') return
  expect((await fn.call(om)).persisted).toBe(true)
}

/** Stage F1 durably at stage `confirmed` with no committed observation. */
async function seedConfirmedF1(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const seeder = h.start({ observerThreshold: 2 })
  const result = await seeder.observe(turn(1))
  const candidate = result!.staged.find(record => record.value['text'] === FACTS['M1'])!
  expect(await h.candidateStore.put({ ...candidate, stage: 'confirmed', confirmedAt: Date.now() }))
    .toBe(true)
  expect(await h.stored()).toEqual([])
  return candidate.key
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('ObservationalMemory restart (MC-03a)', () => {
  describe('oracle', () => {
    it('negative control: a fake citing an existing but wrong message fails the evidence comparison', async () => {
      const h = await harness()
      h.model.wrongCitation = true
      const om = h.start({ observerThreshold: 2 })
      const result = await om.observe(turn(1))
      const staged = recordsWithFact(result!.staged, 'M1')
      expect(staged).toHaveLength(1)
      expect(() => assertEvidence(staged[0]!.value, 'M1')).toThrow()
    })
  })

  describe('a. multi-turn restart below the threshold', () => {
    it('restores turns 1-2 and makes one extractor call over all 8 messages in order', async () => {
      const h = await harness()
      let om = h.start()
      expect(await om.observe(turn(1))).toBeNull()
      expect(await om.observe(turn(2))).toBeNull()
      expect(h.model.calls).toHaveLength(0)
      await persistBoundary(om)

      om = h.start() // restart
      expect(await om.observe(turn(3))).toBeNull()
      expect(h.model.calls).toHaveLength(0)
      const result = await om.observe(turn(4))

      expect(h.model.calls).toHaveLength(1)
      expect(h.model.calls[0]).toEqual(turnContents(1, 2, 3, 4))
      expect(result).not.toBeNull()
      assertFactsExactlyOnce(result!.staged.map(record => record.value), ['M1', 'M2', 'M3', 'M4'])
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()

      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2', 'M3', 'M4'])
    })
  })

  describe('b. failed run, then restart', () => {
    it('extracts the put-back batch followed by the newer messages after a restart', async () => {
      const h = await harness()
      h.model.failNext = 1
      let om = h.start({ observerThreshold: 4 })
      expect(await om.observe(turn(1))).toBeNull()
      expect(await om.observe(turn(2))).toBeNull() // runs and fails
      expect(h.model.calls).toEqual([turnContents(1, 2)])
      expect(bufferState(om).buffered).toBe(4)
      expect(h.eventsOf('observation:observer:failed')).toHaveLength(1)
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])

      om = h.start({ observerThreshold: 4 }) // restart
      const result = await om.observe(turn(3))

      expect(h.model.calls).toHaveLength(2)
      expect(h.model.calls[1]).toEqual(turnContents(1, 2, 3))
      assertFactsExactlyOnce(result!.staged.map(record => record.value), ['M1', 'M2', 'M3'])
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2', 'M3'])
    })
  })

  describe('c. exactly once', () => {
    it('c1. a durably confirmed but unflushed candidate is not staged again on replay', async () => {
      const h = await harness()
      const seededKey = await seedConfirmedF1(h)
      const blockedWrite = h.ctl.on('put', OBS_NS, 'block')

      const om = h.start({ observerThreshold: 2 }) // restart
      const replay = om.observe(turn(1))
      await blockedWrite.entered.promise // the automatic flush is blocked

      const f1 = recordsWithFact([...writerRecords(om), ...inFlight(om).values()], 'M1')
      expect(f1.map(record => record.key)).toEqual([seededKey])

      h.ctl.off(blockedWrite)
      await replay
      await h.confirmAll(om)

      assertFactsExactlyOnce(await h.stored(), ['M1'])
      expect(om.getPendingObservationCandidates()).toEqual([])
      expect(inFlight(om).size).toBe(0)
    })

    it('c2. a flushed fact replayed across restarts is stored exactly once', async () => {
      const h = await harness()
      let om = h.start()
      for (const k of [1, 2, 3, 4]) await om.observe(turn(k))
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2', 'M3', 'M4'])

      om = h.start() // restart
      let replay: Awaited<ReturnType<ObservationalMemory['observe']>> = null
      for (const k of [1, 2, 3, 4]) replay = await om.observe(turn(k)) ?? replay
      expect(replay!.skippedDuplicates).toBe(4)
      expect(replay!.staged).toEqual([])
      await persistBoundary(om)

      om = h.start() // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2', 'M3', 'M4'])
    })

    it('c3. a fact re-extracted while its confirmed write is in flight is not staged again', async () => {
      const h = await harness()
      const om = h.start({ observerThreshold: 2 })
      const first = await om.observe(turn(1))
      const f1Key = recordsWithFact(first!.staged, 'M1')[0]!.key

      const blockedWrite = h.ctl.on('put', OBS_NS, 'block')
      const confirming = om.confirmObservation(f1Key)
      await blockedWrite.entered.promise
      expect([...inFlight(om).keys()]).toEqual([f1Key])

      const replay = await om.observe(turn(1))
      expect(replay!.skippedDuplicates).toBe(1)
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])

      h.ctl.off(blockedWrite)
      expect(await confirming).toBe(true)
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1'])
      expect(inFlight(om).size).toBe(0)
    })

    it('c4. a flush that completes during the dedup read does not let a second candidate in', async () => {
      const h = await harness()
      const seededKey = await seedConfirmedF1(h)
      const om = h.start({ observerThreshold: 2 }) // restart
      expect((await om.listPendingObservationCandidates()).map(record => record.key))
        .toEqual([seededKey])

      const delayedRead = h.ctl.on('search', OBS_NS, 'delay-result', 1)
      const replay = om.observe(turn(1))
      await delayedRead.entered.promise // the (empty) dedup read result is held

      const flushed = await om.flushConfirmedObservations()
      expect(flushed.map(record => record.key)).toEqual([seededKey])
      expect(inFlight(om).size).toBe(0)

      h.ctl.off(delayedRead)
      const result = await replay
      expect(result!.skippedDuplicates).toBe(1)
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])

      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1'])
    })
  })

  describe('c. exactly once: flush failures', () => {
    it('c5. a receipt-read failure during a flush keeps the detached record visible', async () => {
      const h = await harness()
      const seededKey = await seedConfirmedF1(h)
      const flaky = new FlakyCandidateStore(h.candidateStore)
      let om = h.start({ observerThreshold: 2, candidateStore: flaky })
      await om.listPendingObservationCandidates()
      flaky.receiptFailures = 1
      await expect(om.flushConfirmedObservations()).rejects.toThrow(/receipt read/)
      expect(recordsWithFact([...writerRecords(om), ...inFlight(om).values()], 'M1')
        .map(record => record.key)).toEqual([seededKey])

      await om.observe(turn(1)) // replay
      await persistBoundary(om)
      om = h.start({ observerThreshold: 2 }) // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1'])
    })

    it('c6. a cleanup failure mid-batch keeps the remaining detached record visible', async () => {
      const h = await harness()
      const seeder = h.start({ observerThreshold: 4 })
      await seeder.observe(turn(1))
      const seeded = await seeder.observe(turn(2))
      for (const candidate of seeded!.staged) {
        expect(await h.candidateStore.put({ ...candidate, stage: 'confirmed', confirmedAt: Date.now() }))
          .toBe(true)
      }
      const flaky = new FlakyCandidateStore(h.candidateStore)
      let om = h.start({ observerThreshold: 4, candidateStore: flaky })
      expect(await om.listPendingObservationCandidates()).toHaveLength(2)
      flaky.removeFailures = 1
      await expect(om.flushConfirmedObservations()).rejects.toThrow(/cleanup/)
      const storedNow = (await h.stored()).map(record => record['text'])
      const visible = [...writerRecords(om), ...inFlight(om).values()].map(record => record.value['text'])
      expect(storedNow).toHaveLength(1)
      expect([...storedNow, ...visible].sort()).toEqual([FACTS['M1'], FACTS['M2']].sort())

      await om.observe(turn(1)) // replay
      await om.observe(turn(2))
      await persistBoundary(om)
      om = h.start({ observerThreshold: 4 }) // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })
  })

  describe('d. retention and handoff', () => {
    it('keeps an obligation whose captured record the writer evicted; the fact ends stored once', async () => {
      const h = await harness()
      h.model.confidence = 0.5 // stays captured, so the writer may evict it
      const flaky = new FlakyCandidateStore(h.candidateStore)
      flaky.failing = record => record.value['text'] === FACTS['M1']
      const smallWriter = new StagedWriter({ maxPending: 1, autoPromoteThreshold: 0.7, autoConfirmThreshold: 1.01 })
      let om = h.start({ observerThreshold: 2, candidateStore: flaky, stagedWriter: smallWriter })
      await om.observe(turn(1)) // A's write fails: batch kept
      const retry = await om.observe(turn(2)) // A skipped as a duplicate; capturing B evicts A
      expect(retry!.skippedDuplicates).toBe(1)
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])

      flaky.failing = null
      await om.observe([]) // retry persists A from the retained copy
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

      // (b) replay after the obligation was recovered: A is durable but not staged.
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])
      const replay = await om.observe(turn(1))
      expect(replay!.skippedDuplicates).toBe(1)
      expect(replay!.staged).toEqual([])
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

      om = h.start({ observerThreshold: 2 }) // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    it('(a) a candidate persisted and then evicted from the writer is not staged again on replay', async () => {
      const h = await harness()
      h.model.confidence = 0.5
      const smallWriter = new StagedWriter({ maxPending: 1, autoPromoteThreshold: 0.7, autoConfirmThreshold: 1.01 })
      let om = h.start({ observerThreshold: 2, stagedWriter: smallWriter })
      await om.observe(turn(1)) // F1 persisted
      await om.observe(turn(2)) // F2 persisted; capturing F2 evicts F1
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])
      const replay = await om.observe(turn(1))
      expect(replay!.skippedDuplicates).toBe(1)
      expect(replay!.staged).toEqual([])
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

      om = h.start({ observerThreshold: 2 }) // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    it('(c) restoring more candidates than the writer holds still dedups every durable one', async () => {
      const h = await harness()
      h.model.confidence = 0.5
      const seeder = h.start({ observerThreshold: 4 })
      await seeder.observe(turn(1))
      await seeder.observe(turn(2)) // M1, M2 persisted as captured candidates

      const smallWriter = new StagedWriter({ maxPending: 1, autoPromoteThreshold: 0.7, autoConfirmThreshold: 1.01 })
      let om = h.start({ observerThreshold: 4, stagedWriter: smallWriter }) // restart
      await om.listPendingObservationCandidates()
      expect(writerRecords(om)).toHaveLength(1) // capacity 1: one restored record was evicted
      await om.observe(turn(1))
      const replay = await om.observe(turn(2))
      expect(replay!.skippedDuplicates).toBe(2)
      expect(replay!.staged).toEqual([])
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

      om = h.start({ observerThreshold: 4 }) // restart
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    it('deletes the record after a processed run with no arrivals', async () => {
      const h = await harness()
      const om = h.start({ observerThreshold: 4 })
      await om.observe(turn(1))
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1'])
      const processed = await om.observe(turn(2))
      assertFactsExactlyOnce(processed!.staged.map(record => record.value), ['M1', 'M2'])
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    it('holds batch plus arrivals while the run is blocked, then only the arrivals', async () => {
      const h = await harness()
      const om = h.start({ observerThreshold: 2 })
      const hold = h.model.blockNextCall()
      const run = om.observe(turn(1))
      await hold.entered.promise
      expect(await om.observe(turn(2))).toBeNull() // arrivals during the run
      await persistBoundary(om)
      const during = await h.ctl.bufferRecord()
      expect(recordIds(during)).toEqual(['u1', 'a1', 'u2', 'a2'])
      expect(during!['messagesSinceLastRun']).toBe(4)

      hold.release.open()
      const first = await run
      assertFactsExactlyOnce(first!.staged.map(record => record.value), ['M1'])
      await persistBoundary(om)
      const after = await h.ctl.bufferRecord()
      expect(recordIds(after)).toEqual(['u2', 'a2'])
      expect(after!['messagesSinceLastRun']).toBe(2)

      // Drain the retained arrivals.
      const drained = await om.observe([])
      assertFactsExactlyOnce(drained!.staged.map(record => record.value), ['M2'])
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    describe.each([
      ['putCandidateState returns false', 'false', false],
      ['putCandidateState throws', 'throw', false],
      ['one of two candidate writes fails (partial handoff)', 'false', true],
    ] as const)('a run whose candidate write fails: %s', (_label, mode, partial) => {
      async function failedHandoff() {
        const h = await harness()
        const flaky = new FlakyCandidateStore(h.candidateStore)
        flaky.mode = mode
        flaky.failing = partial
          ? record => record.value['text'] === FACTS['M2']
          : () => true
        const om = h.start({ observerThreshold: 4, candidateStore: flaky })
        await om.observe(turn(1))
        const run = await om.observe(turn(2))
        expect(run!.staged).toHaveLength(2)
        // Kept in memory and in the record.
        expect(bufferState(om)).toEqual({ counted: 4, buffered: 4 })
        await persistBoundary(om)
        expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])
        expect(h.eventsOf('observation:observer:failed').map(event => event.reason))
          .toContain('handoff-unverified')

        // Same-instance retry while the write still fails: the RAM-only
        // candidate matches as a duplicate and the batch is still kept.
        const retry = await om.observe([])
        expect(h.model.calls).toHaveLength(2)
        expect(retry!.skippedDuplicates).toBe(2)
        expect(retry!.staged).toEqual([])
        expect(bufferState(om).buffered).toBe(4)
        await persistBoundary(om)
        expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])
        return { h, flaky, om }
      }

      it('discharges the batch once the store recovers and the retry persists the candidate', async () => {
        const { h, flaky, om } = await failedHandoff()
        flaky.failing = null
        const recovered = await om.observe([])
        expect(recovered!.skippedDuplicates).toBe(2)
        await persistBoundary(om)
        expect(await h.ctl.bufferRecord()).toBeNull()
        expect(bufferState(om)).toEqual({ counted: 0, buffered: 0 })
        assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

        await h.confirmAll(om)
        assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
      })

      it('re-extracts the batch after a restart before recovery and ends with each fact once', async () => {
        const { h, flaky } = await failedHandoff()
        const om = h.start({ observerThreshold: 4, candidateStore: flaky }) // restart, still failing
        await om.observe([])
        expect(h.model.calls[2]).toEqual(turnContents(1, 2))
        await persistBoundary(om)
        expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])

        flaky.failing = null
        await om.observe([])
        await persistBoundary(om)
        expect(await h.ctl.bufferRecord()).toBeNull()
        assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])

        await h.confirmAll(om)
        assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
      })
    })

    it('processes an empty extraction', async () => {
      const h = await harness()
      h.model.empty = true
      const om = h.start({ observerThreshold: 2 })
      const result = await om.observe(turn(1))
      expect(result!.staged).toEqual([])
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      expect(bufferState(om)).toEqual({ counted: 0, buffered: 0 })
    })

    it('reset() removes the record', async () => {
      const h = await harness()
      const om = h.start()
      await om.observe(turn(1))
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).not.toBeNull()
      om.reset()
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
    })

    it('keeps the record within the cap across a restart', async () => {
      const h = await harness()
      h.model.failNext = Infinity
      const threshold = 50
      const cap = Math.max(200, 4 * threshold)
      const bulk = (from: number, count: number) => Array.from(
        { length: count },
        (_, i) => new HumanMessage({ id: `b${from + i}`, content: `bulk message ${from + i}` }),
      )
      let om = h.start({ observerThreshold: threshold })
      await om.observe(bulk(0, 120)) // runs, fails, kept
      await om.observe(bulk(120, 120)) // runs, fails, put back and capped
      await persistBoundary(om)
      let record = await h.ctl.bufferRecord()
      expect(recordIds(record)).toHaveLength(cap)
      expect(recordIds(record)[0]).toBe('b40')
      expect(record!['messagesSinceLastRun']).toBe(cap)

      om = h.start({ observerThreshold: threshold }) // restart
      const hold = h.model.blockNextCall()
      const run = om.observe(bulk(240, 10))
      await hold.entered.promise
      // The cap applied when the restored backlog met the new messages.
      expect(h.model.calls.at(-1)).toHaveLength(cap)
      expect(h.model.calls.at(-1)![0]).toBe('bulk message 50')

      await om.observe(bulk(250, 10)) // arrivals during the run
      await persistBoundary(om)
      record = await h.ctl.bufferRecord()
      // Live batch plus arrivals, oldest dropped beyond the cap.
      expect(recordIds(record)).toHaveLength(cap)
      expect(recordIds(record)[0]).toBe('b60')
      expect(recordIds(record)[cap - 1]).toBe('b259')
      expect(record!['messagesSinceLastRun']).toBe(cap)

      hold.release.open()
      expect(await run).toBeNull() // fails again; batch put back
      await persistBoundary(om)
      record = await h.ctl.bufferRecord()
      expect(recordIds(record)).toHaveLength(cap)
      expect(recordIds(record)[0]).toBe('b60')
      expect(recordIds(record)[cap - 1]).toBe('b259')
      expect(record!['messagesSinceLastRun']).toBe(cap)
      expect(bufferState(om)).toEqual({ counted: cap, buffered: cap })
    })
  })

  describe('e. restore failure', () => {
    it('keeps arrivals, never touches the record and does not run until the read recovers', async () => {
      const h = await harness()
      let om = h.start()
      await om.observe(turn(1))
      await om.observe(turn(2))
      await persistBoundary(om)
      const seeded = await h.ctl.bufferRecord()

      const failingRead = h.ctl.on('get', BUF_NS, 'reject')
      om = h.start() // restart
      expect(await om.restorePendingMessages()).toBe(false)
      expect(h.eventsOf('observation:buffer:restore-failed')).toHaveLength(1)
      for (const k of [3, 4, 5, 6]) expect(await om.observe(turn(k))).toBeNull()
      expect(bufferState(om)).toEqual({ counted: 8, buffered: 8 })
      expect(h.model.calls).toHaveLength(0)
      expect(await om.whenBufferPersisted()).toMatchObject({ status: 'restore-pending', persisted: false })
      expect(await h.ctl.bufferRecord()).toEqual(seeded)
      expect(h.ctl.count('put', BUF_NS)).toBe(2)
      expect(h.ctl.count('delete', BUF_NS)).toBe(0)

      h.ctl.off(failingRead)
      const recovered = await om.observe(turn(7))
      expect(h.model.calls).toEqual([turnContents(1, 2, 3, 4, 5, 6, 7)])
      const all = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']
      assertFactsExactlyOnce(recovered!.staged.map(record => record.value), all)
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), all)
    })

    it('surfaces a rejected write and retries it with the newest snapshot', async () => {
      const h = await harness()
      h.ctl.on('put', BUF_NS, 'reject', 1)
      const om = h.start()
      await om.observe(turn(1))
      expect(await om.whenBufferPersisted()).toMatchObject({ status: 'write-failed', persisted: false })
      expect(h.eventsOf('observation:buffer:persistence-failed')).toHaveLength(1)
      expect(await h.ctl.bufferRecord()).toBeNull()

      await om.observe(turn(2))
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1', 'u2', 'a2'])
    })

    it('candidate restore failure: stages nothing, keeps the batch and retries initialization', async () => {
      const h = await harness()
      let om = h.start({ observerThreshold: 2 })
      await om.observe(turn(1)) // M1 staged and persisted
      await om.observe([turn(2)[0]!]) // one message, below the threshold
      await persistBoundary(om)

      const failingRead = h.ctl.on('search', CAND_NS, 'reject')
      om = h.start({ observerThreshold: 2 }) // restart
      const callsBefore = h.model.calls.length
      expect(await om.observe(turn(1))).toBeNull()
      expect(h.model.calls).toHaveLength(callsBefore)
      expect(writerRecords(om)).toEqual([])
      expect(h.eventsOf('observation:state:read-failed').map(event => event.reason))
        .toContainEqual(expect.stringMatching(/^candidate-restore/))
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u2', 'u1', 'a1'])

      h.ctl.off(failingRead)
      const result = await om.observe([])
      expect(result!.skippedDuplicates).toBe(1)
      expect(recordsWithFact(writerRecords(om), 'M1')).toHaveLength(1)
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
    })

    it('final-memory read failure: no second F1 is staged and the batch is kept', async () => {
      const h = await harness()
      let om = h.start({ observerThreshold: 2 })
      await om.observe(turn(1))
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1'])

      const failingRead = h.ctl.on('search', OBS_NS, 'reject')
      om = h.start({ observerThreshold: 2 }) // restart
      expect(await om.observe(turn(1))).toBeNull()
      expect(recordsWithFact(writerRecords(om), 'M1')).toEqual([])
      expect(bufferState(om).buffered).toBe(2)
      await persistBoundary(om)
      expect(recordIds(await h.ctl.bufferRecord())).toEqual(['u1', 'a1'])

      h.ctl.off(failingRead)
      const result = await om.observe([])
      expect(result!.skippedDuplicates).toBe(1)
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      assertFactsExactlyOnce(await h.stored(), ['M1'])
    })
  })

  describe('f. concurrency and fencing', () => {
    it('concurrent first observe() calls restore once and run the observer at most once', async () => {
      const h = await harness()
      let om = h.start()
      for (const k of [1, 2, 3]) await om.observe(turn(k))
      await persistBoundary(om)

      om = h.start() // restart
      const readsBefore = h.ctl.count('get', BUF_NS)
      const results = await Promise.all([om.observe(turn(4)), om.observe(turn(5))])
      expect(h.ctl.count('get', BUF_NS) - readsBefore).toBe(1)
      expect(h.model.calls).toEqual([turnContents(1, 2, 3, 4, 5)])
      const ran = results.filter(result => result !== null)
      expect(ran).toHaveLength(1)
      const markers = ['M1', 'M2', 'M3', 'M4', 'M5']
      assertFactsExactlyOnce(ran[0]!.staged.map(record => record.value), markers)
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), markers)
    })

    it('reset() while a write is held leaves no resurrected record', async () => {
      const h = await harness()
      const heldWrite = h.ctl.on('put', BUF_NS, 'block', 1)
      const om = h.start()
      await om.observe(turn(1))
      await heldWrite.entered.promise
      om.reset()
      heldWrite.release.open()
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
    })

    it('reset() while the restore is held discards the stale record', async () => {
      const h = await harness()
      let om = h.start()
      await om.observe(turn(1))
      await persistBoundary(om)

      const heldRead = h.ctl.on('get', BUF_NS, 'block', 1)
      om = h.start() // restart
      const restoring = om.restorePendingMessages()
      await heldRead.entered.promise
      om.reset()
      heldRead.release.open()
      expect(await restoring).toBe(true)
      await persistBoundary(om)
      expect(await h.ctl.bufferRecord()).toBeNull()
      expect(bufferState(om)).toEqual({ counted: 0, buffered: 0 })
    })

    it('arrivals during a held write are not overwritten by its completion', async () => {
      const h = await harness()
      const heldWrite = h.ctl.on('put', BUF_NS, 'block', 1)
      const om = h.start()
      await om.observe(turn(1))
      await heldWrite.entered.promise
      await om.observe(turn(2))
      heldWrite.release.open()
      await persistBoundary(om)
      const record = await h.ctl.bufferRecord()
      expect(recordIds(record)).toEqual(['u1', 'a1', 'u2', 'a2'])
      expect(record!['messagesSinceLastRun']).toBe(4)
    })
  })

  describe('g. configuration and default', () => {
    it('rejects pendingBuffer outside candidate-first mode or without a capable candidate store', async () => {
      const h = await harness()
      expect(() => h.start({ observationWriteMode: 'direct' })).toThrow(/candidate-first/)
      expect(() => h.start({ observationWriteMode: undefined })).toThrow(/candidate-first/)
      expect(() => h.start({ candidateStore: undefined })).toThrow(/candidateStore/)
      const inner = h.candidateStore
      const legacy: ObservationCandidateStore = {
        load: (ns, scope) => inner.load(ns, scope),
        put: record => inner.put(record),
        remove: record => inner.remove(record),
        getReceipt: (ns, scope, key) => inner.getReceipt(ns, scope, key),
        putReceipt: receipt => inner.putReceipt(receipt),
        prune: (ns, scope, retention) => inner.prune(ns, scope, retention),
      }
      expect(() => h.start({ candidateStore: legacy })).toThrow(/loadWithStatus/)
      expect(() => h.start({
        pendingBuffer: new BaseStoreObservationBufferStore({
          store: h.ctl.store,
          namespace: OBS_NS,
          scopeKeys: ['tenantId', 'userId'],
        }),
      })).toThrow(/observation namespace/)
    })

    it('without pendingBuffer the buffer API is inert and nothing reaches the buffer namespace', async () => {
      const h = await harness()
      const om = h.start({ pendingBuffer: undefined })
      expect(await om.observe(turn(1))).toBeNull()
      expect(await om.whenBufferPersisted()).toEqual({ status: 'disabled', persisted: false, revision: 0 })
      expect(await om.restorePendingMessages()).toBe(true)
      expect(h.ctl.calls.filter(call => call.ns === BUF_NS)).toEqual([])
    })

    it('round-trips every message type through the real buffer store, incl. RemoveMessage and a custom subtype', async () => {
      const h = await harness()
      const originals = mixedMessages()
      const om = h.start({ observerThreshold: 100 })
      expect(await om.observe(originals)).toBeNull()
      await persistBoundary(om)

      const loaded = await h.pendingBuffer.load(OBS_NS, SCOPE)
      expect(loaded.status).toBe('loaded')
      const rebuilt = loaded.status === 'loaded'
        ? loaded.record.messages.map(deserializeObservationMessage)
        : []
      expect(rebuilt).toHaveLength(originals.length)
      rebuilt.forEach((message, i) => {
        const original = originals[i]!
        expect(message._getType()).toBe(original._getType())
        expect(JSON.stringify(message.content)).toBe(JSON.stringify(original.content))
        expect(message.id).toBe(original.id)
      })
      expect(rebuilt.map(message => message._getType()))
        .toEqual(['human', 'ai', 'system', 'tool', 'generic', 'function', 'remove', 'note'])
      expect(serializeObservationMessage(new RemoveMessage({ id: 'r' })))
        .toEqual({ type: 'remove', content: [], id: 'r' })
    })

    it('the extractor sees identical input for a restored mixed-type backlog', async () => {
      const control = await harness()
      const live = control.start({ observerThreshold: 9 })
      await live.observe(mixedMessages())
      await live.observe(turn(2).slice(0, 1))

      const h = await harness()
      let om = h.start({ observerThreshold: 9 })
      await om.observe(mixedMessages())
      await persistBoundary(om)
      om = h.start({ observerThreshold: 9 }) // restart
      await om.observe(turn(2).slice(0, 1))

      expect(h.model.prompts).toHaveLength(1)
      expect(h.model.prompts).toEqual(control.model.prompts)
    })
  })

  describe('h. same-timestamp restart (no key reuse)', () => {
    // A fixed clock across both instances: the sequence restarts at 0, so the
    // first key of the restarted instance equals the restored one.
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('never reuses a restored candidate key', async () => {
      const h = await harness()
      let om = h.start({ observerThreshold: 2 })
      await om.observe(turn(1))
      om = h.start({ observerThreshold: 2 }) // restart, same millisecond
      await om.observe(turn(2))
      assertFactsExactlyOnce((await h.durableCandidates()).map(record => record.value), ['M1', 'M2'])
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })

    it('never overwrites a durable observation key', async () => {
      const h = await harness()
      let om = h.start({ observerThreshold: 2 })
      await om.observe(turn(1))
      await h.confirmAll(om)
      om = h.start({ observerThreshold: 2 }) // restart, same millisecond
      await om.observe(turn(2))
      await h.confirmAll(om)
      assertFactsExactlyOnce(await h.stored(), ['M1', 'M2'])
    })
  })
})

/** A custom BaseMessage subtype the extractor reads like any other. */
class NoteMessage extends BaseMessage {
  readonly type = 'note' as unknown as MessageType
}

function mixedMessages(): BaseMessage[] {
  return [
    new HumanMessage({ id: 'h1', content: userText(1) }),
    new AIMessage({ id: 'ai1', content: [{ type: 'text', text: 'block reply' }] }),
    new SystemMessage({ content: 'system note without id' }),
    new ToolMessage({ id: 't1', content: 'tool output', tool_call_id: 'call-1' }),
    new ChatMessage({ id: 'g1', content: 'critic remark', role: 'critic' }),
    new FunctionMessage({ id: 'f1', content: 'function output', name: 'lookup' }),
    new RemoveMessage({ id: 'r1' }),
    new NoteMessage({ id: 'n1', content: 'custom subtype note' }),
  ]
}
