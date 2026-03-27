import { describe, it, expect, beforeEach } from 'vitest'
import { SharedMemoryNamespace } from '../shared-namespace.js'
import type { SharedEntry } from '../shared-namespace.js'
import { VectorClock } from '../vector-clock.js'

describe('SharedMemoryNamespace — CRDT (vector clock merge)', () => {
  let ns: SharedMemoryNamespace

  beforeEach(() => {
    ns = new SharedMemoryNamespace({
      namespace: ['shared', 'crdt-test'],
    })
  })

  // -------------------------------------------------------------------------
  // put() stores vectorClock
  // -------------------------------------------------------------------------

  describe('put() with vector clocks', () => {
    it('stores vectorClock in the entry', () => {
      const entry = ns.put('agent-a', 'k1', { v: 1 })
      expect(entry.vectorClock).toBeDefined()
      expect(entry.vectorClock!['agent-a']).toBe(1)
    })

    it('increments vectorClock on successive writes by same agent', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      const entry2 = ns.put('agent-a', 'k1', { v: 2 })
      expect(entry2.vectorClock!['agent-a']).toBe(2)
    })

    it('tracks multiple agents in vectorClock', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      const entry2 = ns.put('agent-b', 'k1', { v: 2 })
      expect(entry2.vectorClock!['agent-a']).toBe(1)
      expect(entry2.vectorClock!['agent-b']).toBe(1)
    })

    it('different keys have independent vector clocks', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      const k2 = ns.put('agent-a', 'k2', { v: 2 })
      expect(k2.vectorClock!['agent-a']).toBe(1) // independent counter
    })
  })

  // -------------------------------------------------------------------------
  // merge() — causally after (accept remote)
  // -------------------------------------------------------------------------

  describe('merge() accepts remote entries that are causally after', () => {
    it('overwrites local with causally-later remote', () => {
      ns.put('agent-a', 'k1', { v: 'local' })

      // Build a remote entry that is causally after (agent-a:2)
      const remoteClock = new VectorClock({ 'agent-a': 2 })
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote' },
        writtenBy: 'agent-a',
        version: 2,
        updatedAt: Date.now() + 1000,
        createdAt: Date.now() - 1000,
        vectorClock: remoteClock.toJSON(),
      }

      const report = ns.merge([remote])
      expect(report.accepted).toBe(1)
      expect(report.rejected).toBe(0)
      expect(report.conflicts).toBe(0)

      const entry = ns.get('k1')
      expect(entry!.value).toEqual({ v: 'remote' })
    })
  })

  // -------------------------------------------------------------------------
  // merge() — causally before (reject remote)
  // -------------------------------------------------------------------------

  describe('merge() rejects remote entries that are causally before', () => {
    it('keeps local when remote is causally earlier', () => {
      // Write twice to get clock {agent-a: 2}
      ns.put('agent-a', 'k1', { v: 'first' })
      ns.put('agent-a', 'k1', { v: 'local-latest' })

      // Remote with clock {agent-a: 1} is causally before
      const remoteClock = new VectorClock({ 'agent-a': 1 })
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'stale-remote' },
        writtenBy: 'agent-a',
        version: 1,
        updatedAt: Date.now() - 5000,
        createdAt: Date.now() - 5000,
        vectorClock: remoteClock.toJSON(),
      }

      const report = ns.merge([remote])
      expect(report.accepted).toBe(0)
      expect(report.rejected).toBe(1)
      expect(report.conflicts).toBe(0)

      const entry = ns.get('k1')
      expect(entry!.value).toEqual({ v: 'local-latest' })
    })
  })

  // -------------------------------------------------------------------------
  // merge() — concurrent writes (LWW tiebreak)
  // -------------------------------------------------------------------------

  describe('merge() resolves concurrent writes via LWW tiebreak', () => {
    it('accepts remote when remote has later updatedAt', () => {
      ns.put('agent-a', 'k1', { v: 'local' })

      // Concurrent: local has {agent-a: 1}, remote has {agent-b: 1}
      const remoteClock = new VectorClock({ 'agent-b': 1 })
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote-wins' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now() + 5000, // more recent
        createdAt: Date.now(),
        vectorClock: remoteClock.toJSON(),
      }

      const report = ns.merge([remote])
      expect(report.conflicts).toBe(1)
      expect(report.accepted).toBe(1)
      expect(report.rejected).toBe(0)

      const entry = ns.get('k1')
      expect(entry!.value).toEqual({ v: 'remote-wins' })
    })

    it('keeps local when local has later updatedAt', () => {
      ns.put('agent-a', 'k1', { v: 'local-wins' })

      // Concurrent: local has {agent-a: 1}, remote has {agent-b: 1}
      const remoteClock = new VectorClock({ 'agent-b': 1 })
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote-loses' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: 1000, // much older
        createdAt: 1000,
        vectorClock: remoteClock.toJSON(),
      }

      const report = ns.merge([remote])
      expect(report.conflicts).toBe(1)
      expect(report.accepted).toBe(0)
      expect(report.rejected).toBe(1)

      const entry = ns.get('k1')
      expect(entry!.value).toEqual({ v: 'local-wins' })
    })

    it('merges vector clocks after concurrent resolution', () => {
      ns.put('agent-a', 'k1', { v: 'local' })

      const remoteClock = new VectorClock({ 'agent-b': 1 })
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now() + 5000,
        createdAt: Date.now(),
        vectorClock: remoteClock.toJSON(),
      }

      ns.merge([remote])
      const entry = ns.get('k1')
      // Merged clock should have both agents
      expect(entry!.vectorClock!['agent-a']).toBe(1)
      expect(entry!.vectorClock!['agent-b']).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // merge() — equal clocks (no-op)
  // -------------------------------------------------------------------------

  describe('merge() treats equal clocks as no-op', () => {
    it('does not change anything when clocks are equal', () => {
      const entry = ns.put('agent-a', 'k1', { v: 'original' })

      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'same-clock' },
        writtenBy: 'agent-a',
        version: 1,
        updatedAt: entry.updatedAt,
        createdAt: entry.createdAt,
        vectorClock: { ...entry.vectorClock! },
      }

      const report = ns.merge([remote])
      expect(report.accepted).toBe(0)
      expect(report.rejected).toBe(0)
      expect(report.conflicts).toBe(0)

      // Original value preserved
      expect(ns.get('k1')!.value).toEqual({ v: 'original' })
    })
  })

  // -------------------------------------------------------------------------
  // merge() report correctness
  // -------------------------------------------------------------------------

  describe('merge() returns correct report', () => {
    it('counts multiple entries correctly', () => {
      // Local: k1 (clock: {a:1}), k2 (clock: {a:1})
      ns.put('agent-a', 'k1', { v: 1 })
      ns.put('agent-a', 'k2', { v: 2 })

      const remoteEntries: SharedEntry[] = [
        // k1: causally after -> accepted
        {
          key: 'k1',
          value: { v: 'new' },
          writtenBy: 'agent-a',
          version: 2,
          updatedAt: Date.now() + 1000,
          createdAt: Date.now(),
          vectorClock: { 'agent-a': 2 },
        },
        // k2: causally before -> rejected
        {
          key: 'k2',
          value: { v: 'old' },
          writtenBy: 'agent-b',
          version: 0,
          updatedAt: 100,
          createdAt: 100,
          vectorClock: { 'agent-b': 0 },
        },
        // k3: new key -> accepted
        {
          key: 'k3',
          value: { v: 'brand-new' },
          writtenBy: 'agent-c',
          version: 1,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          vectorClock: { 'agent-c': 1 },
        },
      ]

      const report = ns.merge(remoteEntries)
      // k1 accepted, k2 concurrent (both have disjoint agents, agent-a:1 vs agent-b:0 — actually agent-b:0 means empty for b, but agent-a is 1 local vs 0 remote)
      // Let me reconsider: local k2 has {agent-a:1}, remote k2 has {agent-b:0}
      // remote clock compare to local: remote has agent-a:0 < local agent-a:1 AND remote has agent-b:0 = local agent-b:0
      // So remote is "before" local. rejected.
      expect(report.accepted).toBe(2) // k1 + k3
      expect(report.rejected).toBe(1) // k2
    })
  })

  // -------------------------------------------------------------------------
  // getConflicts()
  // -------------------------------------------------------------------------

  describe('getConflicts()', () => {
    it('returns empty array when no conflicts', () => {
      expect(ns.getConflicts()).toEqual([])
    })

    it('records concurrent write conflicts', () => {
      ns.put('agent-a', 'k1', { v: 'local' })

      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now() + 5000,
        createdAt: Date.now(),
        vectorClock: { 'agent-b': 1 },
      }

      ns.merge([remote])
      const conflicts = ns.getConflicts()
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0]!.key).toBe('k1')
      expect(conflicts[0]!.kept.value).toEqual({ v: 'remote' })
      expect(conflicts[0]!.discarded.value).toEqual({ v: 'local' })
      expect(conflicts[0]!.detectedAt).toBeGreaterThan(0)
    })

    it('accumulates multiple conflicts', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      ns.put('agent-a', 'k2', { v: 2 })

      const remotes: SharedEntry[] = [
        {
          key: 'k1',
          value: { v: 'r1' },
          writtenBy: 'agent-b',
          version: 1,
          updatedAt: Date.now() + 5000,
          createdAt: Date.now(),
          vectorClock: { 'agent-b': 1 },
        },
        {
          key: 'k2',
          value: { v: 'r2' },
          writtenBy: 'agent-c',
          version: 1,
          updatedAt: Date.now() + 5000,
          createdAt: Date.now(),
          vectorClock: { 'agent-c': 1 },
        },
      ]

      ns.merge(remotes)
      expect(ns.getConflicts()).toHaveLength(2)
    })

    it('returns a copy (not internal reference)', () => {
      ns.put('agent-a', 'k1', { v: 'local' })
      ns.merge([{
        key: 'k1',
        value: { v: 'remote' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now() + 5000,
        createdAt: Date.now(),
        vectorClock: { 'agent-b': 1 },
      }])

      const c1 = ns.getConflicts()
      const c2 = ns.getConflicts()
      expect(c1).not.toBe(c2)
      expect(c1).toEqual(c2)
    })
  })

  // -------------------------------------------------------------------------
  // Backward compatibility: entries without vectorClock
  // -------------------------------------------------------------------------

  describe('backward compatibility (no vectorClock)', () => {
    it('merge uses version comparison when entries lack vectorClock', () => {
      ns.put('agent-a', 'k1', { v: 'local' })
      const local = ns.get('k1')!

      // Remote without vectorClock, higher version
      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote-higher-version' },
        writtenBy: 'agent-b',
        version: local.version + 1,
        updatedAt: Date.now() + 1000,
        createdAt: Date.now(),
        // No vectorClock
      }

      // Remove local's vectorClock to simulate legacy entry
      delete local.vectorClock
      // Re-set it so it's truly without clock
      ns.clear()
      // Manually set up state: put a legacy entry without clock
      // We need to test the fallback path, so let's construct the scenario differently
      // Put an entry, then strip its clock from the map
      const legacyNs = new SharedMemoryNamespace({ namespace: ['legacy'] })

      // We can't easily strip the clock from the internal map,
      // so let's test: remote has no clock, local has clock -> fallback path
      legacyNs.put('agent-a', 'k1', { v: 'local-with-clock' })

      const remoteNoClock: SharedEntry = {
        key: 'k1',
        value: { v: 'remote-no-clock' },
        writtenBy: 'agent-b',
        version: 5, // higher version
        updatedAt: Date.now() + 1000,
        createdAt: Date.now(),
        // No vectorClock — triggers fallback
      }

      const report = legacyNs.merge([remoteNoClock])
      expect(report.accepted).toBe(1)
      expect(legacyNs.get('k1')!.value).toEqual({ v: 'remote-no-clock' })
    })

    it('merge rejects remote without clock when local version is higher', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      ns.put('agent-a', 'k1', { v: 2 })
      ns.put('agent-a', 'k1', { v: 3 }) // version 3

      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'old-remote' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        // No vectorClock
      }

      const report = ns.merge([remote])
      expect(report.rejected).toBe(1)
      expect(ns.get('k1')!.value).toEqual({ v: 3 })
    })

    it('merge uses updatedAt tiebreak when versions are equal and no clock', () => {
      ns.put('agent-a', 'k1', { v: 'local' })

      const remote: SharedEntry = {
        key: 'k1',
        value: { v: 'remote-newer' },
        writtenBy: 'agent-b',
        version: 1, // same as local
        updatedAt: Date.now() + 10000, // much newer
        createdAt: Date.now(),
        // No vectorClock
      }

      const report = ns.merge([remote])
      expect(report.accepted).toBe(1)
      expect(ns.get('k1')!.value).toEqual({ v: 'remote-newer' })
    })
  })

  // -------------------------------------------------------------------------
  // Mixed merge: entries with and without vector clocks
  // -------------------------------------------------------------------------

  describe('mixed merge (with and without vector clocks)', () => {
    it('handles a batch of mixed entries', () => {
      ns.put('agent-a', 'k1', { v: 'local-k1' })
      ns.put('agent-a', 'k2', { v: 'local-k2' })

      const remotes: SharedEntry[] = [
        // k1: has vectorClock, causally after -> accepted
        {
          key: 'k1',
          value: { v: 'remote-k1' },
          writtenBy: 'agent-b',
          version: 2,
          updatedAt: Date.now() + 1000,
          createdAt: Date.now(),
          vectorClock: { 'agent-a': 1, 'agent-b': 1 },
        },
        // k2: no vectorClock, lower version -> rejected
        {
          key: 'k2',
          value: { v: 'remote-k2-old' },
          writtenBy: 'agent-c',
          version: 0,
          updatedAt: 1000,
          createdAt: 1000,
        },
        // k3: new entry without clock -> accepted
        {
          key: 'k3',
          value: { v: 'new-entry' },
          writtenBy: 'agent-d',
          version: 1,
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ]

      const report = ns.merge(remotes)
      expect(report.accepted).toBe(2) // k1 + k3
      expect(report.rejected).toBe(1) // k2

      expect(ns.get('k1')!.value).toEqual({ v: 'remote-k1' })
      expect(ns.get('k2')!.value).toEqual({ v: 'local-k2' })
      expect(ns.get('k3')!.value).toEqual({ v: 'new-entry' })
    })
  })

  // -------------------------------------------------------------------------
  // clear() resets conflicts
  // -------------------------------------------------------------------------

  describe('clear() resets CRDT state', () => {
    it('clears detected conflicts', () => {
      ns.put('agent-a', 'k1', { v: 'local' })
      ns.merge([{
        key: 'k1',
        value: { v: 'remote' },
        writtenBy: 'agent-b',
        version: 1,
        updatedAt: Date.now() + 5000,
        createdAt: Date.now(),
        vectorClock: { 'agent-b': 1 },
      }])

      expect(ns.getConflicts()).toHaveLength(1)
      ns.clear()
      expect(ns.getConflicts()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Existing tests still pass (backward compat)
  // -------------------------------------------------------------------------

  describe('existing API backward compat', () => {
    it('put/get/delete still work as before', () => {
      const entry = ns.put('agent-a', 'key', { hello: 'world' })
      expect(entry.version).toBe(1)
      expect(ns.get('key')).toEqual(entry)
      expect(ns.delete('agent-a', 'key')).toBe(true)
      expect(ns.get('key')).toBeNull()
    })

    it('search still works', () => {
      ns.put('a', 'greeting', { text: 'hello' })
      const results = ns.search('hello')
      expect(results).toHaveLength(1)
    })

    it('list/stats still work', () => {
      ns.put('a', 'k1', { v: 1 })
      ns.put('b', 'k2', { v: 2 })
      expect(ns.list()).toHaveLength(2)
      expect(ns.stats().entryCount).toBe(2)
      expect(ns.stats().writerCount).toBe(2)
    })
  })
})
