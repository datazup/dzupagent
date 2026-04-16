import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryRunStore } from '../in-memory-store.js'
import { InMemoryRunJournal } from '../in-memory-run-journal.js'
import { RunJournalBridgeRunStore } from '../run-journal-bridge.js'
import type { RunJournalEntry } from '../run-journal-types.js'

describe('RunJournalBridgeRunStore', () => {
  let innerStore: InMemoryRunStore
  let journal: InMemoryRunJournal
  let bridge: RunJournalBridgeRunStore

  const testInput = { agentId: 'agent-1', input: { prompt: 'hello' } }

  beforeEach(() => {
    innerStore = new InMemoryRunStore()
    journal = new InMemoryRunJournal()
  })

  // -------------------------------------------------------------------------
  // Disabled (pass-through)
  // -------------------------------------------------------------------------

  describe('when disabled', () => {
    beforeEach(() => {
      bridge = new RunJournalBridgeRunStore(innerStore, journal, false)
    })

    it('passes through create without writing to journal', async () => {
      const run = await bridge.create(testInput)
      expect(run.agentId).toBe('agent-1')
      expect(run.status).toBe('queued')

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(0)
    })

    it('passes through update without writing to journal', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, { status: 'completed', output: 'done' })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(0)

      // Inner store is still updated
      const updated = await bridge.get(run.id)
      expect(updated?.status).toBe('completed')
    })

    it('passes through get, list, addLog, getLogs', async () => {
      const run = await bridge.create(testInput)

      const fetched = await bridge.get(run.id)
      expect(fetched?.id).toBe(run.id)

      const listed = await bridge.list({ agentId: 'agent-1' })
      expect(listed).toHaveLength(1)

      await bridge.addLog(run.id, { level: 'info', message: 'test' })
      const logs = await bridge.getLogs(run.id)
      expect(logs).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Enabled (dual-write)
  // -------------------------------------------------------------------------

  describe('when enabled', () => {
    beforeEach(() => {
      bridge = new RunJournalBridgeRunStore(innerStore, journal, true)
    })

    it('writes run_started to journal on create', async () => {
      const run = await bridge.create(testInput)

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.type).toBe('run_started')
      expect((entries[0] as RunJournalEntry).type).toBe('run_started')

      // Verify data shape
      const data = (entries[0] as Extract<RunJournalEntry, { type: 'run_started' }>).data
      expect(data.input).toEqual({ prompt: 'hello' })
      expect(data.agentId).toBe('agent-1')
    })

    it('writes run_completed to journal on status update to completed', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, {
        status: 'completed',
        output: { result: 42 },
      })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_completed')

      const data = (entries[1] as Extract<RunJournalEntry, { type: 'run_completed' }>).data
      expect(data.output).toEqual({ result: 42 })
    })

    it('writes run_paused to journal on status update to paused', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, { status: 'paused' })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_paused')
    })

    it('writes run_failed to journal on status update to failed', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, {
        status: 'failed',
        error: 'something broke',
      })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_failed')

      const data = (entries[1] as Extract<RunJournalEntry, { type: 'run_failed' }>).data
      expect(data.error).toBe('something broke')
    })

    it('writes run_cancelled to journal on status update to cancelled', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, { status: 'cancelled' })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_cancelled')
    })

    it('writes run_suspended to journal on status update to suspended', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, {
        status: 'suspended',
        metadata: { stepId: 'step-1', suspendReason: 'waiting' },
      })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_suspended')
    })

    it('writes run_resumed to journal on status update to running', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, {
        status: 'running',
        metadata: { resumeToken: 'tok-abc' },
      })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(2)
      expect(entries[1]?.type).toBe('run_resumed')
    })

    it('does not write to journal for non-lifecycle statuses (e.g. queued)', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, { status: 'queued' })

      const entries = await journal.getAll(run.id)
      // Only run_started from create, no entry for queued
      expect(entries).toHaveLength(1)
    })

    it('does not write to journal when patch has no status', async () => {
      const run = await bridge.create(testInput)
      await bridge.update(run.id, { output: 'partial' })

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(1) // only run_started
    })

    it('does not journal individual log entries', async () => {
      const run = await bridge.create(testInput)
      await bridge.addLog(run.id, { level: 'info', message: 'step done' })
      await bridge.addLogs(run.id, [
        { level: 'debug', message: 'detail 1' },
        { level: 'debug', message: 'detail 2' },
      ])

      const entries = await journal.getAll(run.id)
      expect(entries).toHaveLength(1) // only run_started

      // But logs are still accessible through the store
      const logs = await bridge.getLogs(run.id)
      expect(logs).toHaveLength(3)
    })
  })
})
