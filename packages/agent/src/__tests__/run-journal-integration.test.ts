/**
 * F13-T6: Integration test — RunJournalBridgeRunStore captures full run lifecycle.
 *
 * Wires up InMemoryRunStore + InMemoryRunJournal + RunJournalBridgeRunStore
 * and verifies that store mutations are dual-written to the journal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryRunStore,
  InMemoryRunJournal,
  RunJournalBridgeRunStore,
} from '@dzupagent/core'
import type { RunJournal, RunJournalEntry } from '@dzupagent/core'

describe('RunJournalBridgeRunStore integration', () => {
  let store: InMemoryRunStore
  let journal: InMemoryRunJournal
  let bridge: RunJournalBridgeRunStore

  beforeEach(() => {
    store = new InMemoryRunStore()
    journal = new InMemoryRunJournal()
    bridge = new RunJournalBridgeRunStore(store, journal, /* enabled */ true)
  })

  // ── 1. Full lifecycle captured ──────────────────────────────────────────────

  describe('full lifecycle captured', () => {
    it('journals run_started on create and run_completed on status update', async () => {
      // Arrange & Act: create a run through the bridge
      const run = await bridge.create({
        agentId: 'test-agent',
        input: 'What is 2+2?',
      })

      // Update to running (maps to run_resumed in the bridge)
      await bridge.update(run.id, { status: 'running' })

      // Update to completed
      await bridge.update(run.id, {
        status: 'completed',
        output: 'The answer is 4.',
        tokenUsage: { input: 10, output: 5 },
        costCents: 0.01,
      })

      // Assert: journal should have entries
      const entries = await journal.getAll(run.id)
      expect(entries.length).toBeGreaterThanOrEqual(3)

      // First entry: run_started
      const startEntry = entries.find((e) => e.type === 'run_started')
      expect(startEntry).toBeDefined()
      expect(startEntry!.runId).toBe(run.id)
      if (startEntry!.type === 'run_started') {
        expect(startEntry!.data.agentId).toBe('test-agent')
        expect(startEntry!.data.input).toBe('What is 2+2?')
      }

      // Second entry: run_resumed (from status: 'running')
      const resumedEntry = entries.find((e) => e.type === 'run_resumed')
      expect(resumedEntry).toBeDefined()

      // Third entry: run_completed
      const completedEntry = entries.find((e) => e.type === 'run_completed')
      expect(completedEntry).toBeDefined()
      if (completedEntry!.type === 'run_completed') {
        expect(completedEntry!.data.output).toBe('The answer is 4.')
        expect(completedEntry!.data.totalTokens).toBe(15)
        expect(completedEntry!.data.totalCostCents).toBe(0.01)
      }
    })

    it('the underlying store also reflects the updates', async () => {
      const run = await bridge.create({
        agentId: 'test-agent',
        input: 'hello',
      })
      await bridge.update(run.id, { status: 'completed', output: 'done' })

      const storedRun = await bridge.get(run.id)
      expect(storedRun).not.toBeNull()
      expect(storedRun!.status).toBe('completed')
      expect(storedRun!.output).toBe('done')
    })
  })

  // ── 2. Status transitions are journaled ─────────────────────────────────────

  describe('status transitions are journaled', () => {
    it('journals each mapped status transition correctly', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test input',
      })

      await bridge.update(run.id, { status: 'running' })
      await bridge.update(run.id, { status: 'completed', output: 'result' })

      const entries = await journal.getAll(run.id)
      const types = entries.map((e) => e.type)

      // run_started from create, run_resumed from running, run_completed from completed
      expect(types).toContain('run_started')
      expect(types).toContain('run_resumed')
      expect(types).toContain('run_completed')
    })

    it('journals run_failed when status is failed', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'will fail',
      })

      await bridge.update(run.id, {
        status: 'failed',
        error: 'Something went wrong',
      })

      const entries = await journal.getAll(run.id)
      const failEntry = entries.find((e) => e.type === 'run_failed')
      expect(failEntry).toBeDefined()
      if (failEntry!.type === 'run_failed') {
        expect(failEntry!.data.error).toBe('Something went wrong')
      }
    })

    it('journals run_cancelled when status is cancelled', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'will cancel',
      })

      await bridge.update(run.id, {
        status: 'cancelled',
        metadata: { cancelReason: 'user requested' },
      })

      const entries = await journal.getAll(run.id)
      const cancelEntry = entries.find((e) => e.type === 'run_cancelled')
      expect(cancelEntry).toBeDefined()
      if (cancelEntry!.type === 'run_cancelled') {
        expect(cancelEntry!.data.reason).toBe('user requested')
      }
    })

    it('journals run_paused when status is paused', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'will pause',
      })

      await bridge.update(run.id, {
        status: 'paused',
        metadata: { pauseReason: 'cooperative' },
      })

      const entries = await journal.getAll(run.id)
      const pauseEntry = entries.find((e) => e.type === 'run_paused')
      expect(pauseEntry).toBeDefined()
      if (pauseEntry!.type === 'run_paused') {
        expect(pauseEntry!.data.reason).toBe('cooperative')
      }
    })

    it('journals run_suspended when status is suspended', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'will suspend',
      })

      await bridge.update(run.id, {
        status: 'suspended',
        metadata: { stepId: 'step-42', suspendReason: 'waiting for human' },
      })

      const entries = await journal.getAll(run.id)
      const suspendEntry = entries.find((e) => e.type === 'run_suspended')
      expect(suspendEntry).toBeDefined()
      if (suspendEntry!.type === 'run_suspended') {
        expect(suspendEntry!.data.stepId).toBe('step-42')
        expect(suspendEntry!.data.reason).toBe('waiting for human')
      }
    })

    it('does not journal unmapped statuses like queued or pending', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      // 'queued' and 'pending' are not in STATUS_TO_ENTRY_TYPE
      await bridge.update(run.id, { status: 'queued' })
      await bridge.update(run.id, { status: 'pending' })

      const entries = await journal.getAll(run.id)
      // Only the run_started from create should exist
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe('run_started')
    })

    it('sequence numbers increase monotonically', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await bridge.update(run.id, { status: 'running' })
      await bridge.update(run.id, { status: 'completed', output: 'done' })

      const entries = await journal.getAll(run.id)
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq)
      }
    })
  })

  // ── 3. Journal failures are non-fatal ───────────────────────────────────────

  describe('journal failures are non-fatal', () => {
    it('store create succeeds even when journal.append throws', async () => {
      const throwingJournal: RunJournal = {
        append: vi.fn().mockRejectedValue(new Error('journal down')),
        query: vi.fn(),
        getAll: vi.fn(),
        compact: vi.fn(),
        needsCompaction: vi.fn(),
      }

      const faultyBridge = new RunJournalBridgeRunStore(
        store,
        throwingJournal,
        /* enabled */ true,
      )

      // Should not throw -- journal error is swallowed
      const run = await faultyBridge.create({
        agentId: 'agent-1',
        input: 'test',
      })
      expect(run).toBeDefined()
      expect(run.id).toBeTruthy()

      // Verify the underlying store has the run
      const stored = await store.get(run.id)
      expect(stored).not.toBeNull()
      expect(stored!.agentId).toBe('agent-1')
    })

    it('store update succeeds even when journal.append throws', async () => {
      // First create normally
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      // Now create a faulty bridge for updates
      const throwingJournal: RunJournal = {
        append: vi.fn().mockRejectedValue(new Error('journal down')),
        query: vi.fn(),
        getAll: vi.fn(),
        compact: vi.fn(),
        needsCompaction: vi.fn(),
      }

      const faultyBridge = new RunJournalBridgeRunStore(
        store,
        throwingJournal,
        /* enabled */ true,
      )

      // Should not throw
      await faultyBridge.update(run.id, {
        status: 'completed',
        output: 'done',
      })

      // Underlying store still updated
      const stored = await store.get(run.id)
      expect(stored!.status).toBe('completed')
      expect(stored!.output).toBe('done')
    })

    it('read operations (get, list, getLogs) are unaffected by journal', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await bridge.addLog(run.id, {
        level: 'info',
        message: 'hello',
      })

      // These pass through directly to the underlying store
      const fetched = await bridge.get(run.id)
      expect(fetched).not.toBeNull()

      const listed = await bridge.list({ agentId: 'agent-1' })
      expect(listed).toHaveLength(1)

      const logs = await bridge.getLogs(run.id)
      expect(logs).toHaveLength(1)
      expect(logs[0]!.message).toBe('hello')
    })
  })

  // ── 4. Bridge can be disabled ───────────────────────────────────────────────

  describe('bridge can be disabled', () => {
    it('journal receives zero entries when bridge is disabled', async () => {
      const disabledBridge = new RunJournalBridgeRunStore(
        store,
        journal,
        /* enabled */ false,
      )

      const run = await disabledBridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await disabledBridge.update(run.id, { status: 'running' })
      await disabledBridge.update(run.id, {
        status: 'completed',
        output: 'done',
      })

      // Journal should have no entries at all
      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(0)
    })

    it('store operations still work when bridge is disabled', async () => {
      const disabledBridge = new RunJournalBridgeRunStore(
        store,
        journal,
        /* enabled */ false,
      )

      const run = await disabledBridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await disabledBridge.update(run.id, {
        status: 'completed',
        output: 'result',
      })

      const stored = await disabledBridge.get(run.id)
      expect(stored).not.toBeNull()
      expect(stored!.status).toBe('completed')
      expect(stored!.output).toBe('result')
    })

    it('disabled is the default (third arg omitted)', async () => {
      // RunJournalBridgeRunStore defaults enabled to false
      const defaultBridge = new RunJournalBridgeRunStore(store, journal)

      const run = await defaultBridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await defaultBridge.update(run.id, { status: 'completed' })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(0)
    })
  })

  // ── 5. Querying journal with filters ────────────────────────────────────────

  describe('journal query integration', () => {
    it('can query journal entries by type filter', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      await bridge.update(run.id, { status: 'running' })
      await bridge.update(run.id, { status: 'completed', output: 'done' })

      // Query only for run_completed entries
      const page = await journal.query(run.id, {
        types: ['run_completed'],
      })

      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]!.type).toBe('run_completed')
      expect(page.hasMore).toBe(false)
    })

    it('entries carry correct runId and timestamps', async () => {
      const run = await bridge.create({
        agentId: 'agent-1',
        input: 'test',
      })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(1)

      const entry = entries[0]!
      expect(entry.runId).toBe(run.id)
      expect(entry.v).toBe(1)
      expect(entry.ts).toBeTruthy()
      // ts should be a valid ISO 8601 string
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts)
    })
  })
})
