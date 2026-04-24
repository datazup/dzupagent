/**
 * Unit tests for PostgresPipelineCheckpointStore.
 *
 * Uses a hand-rolled mock client that records every query + params and
 * returns stubbed rows — no live database required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PostgresPipelineCheckpointStore,
  type PostgresClientLike,
} from '../pipeline/postgres-checkpoint-store.js'
import type { PipelineCheckpoint } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

interface RecordedCall {
  text: string
  params: unknown[]
}

function createMockClient(responders: Array<(call: RecordedCall) => unknown>) {
  const calls: RecordedCall[] = []
  let idx = 0

  const client: PostgresClientLike = {
    query: vi.fn(async <T>(text: string, params: unknown[] = []) => {
      const call: RecordedCall = { text, params }
      calls.push(call)
      const responder = responders[idx++]
      const result = responder ? responder(call) : { rows: [] }
      return result as { rows: T[] }
    }),
  }

  return { client, calls }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    pipelineRunId: 'run-1',
    pipelineId: 'pipeline-1',
    version: 1,
    schemaVersion: '1.0.0',
    completedNodeIds: ['start'],
    state: { result: 'ok' },
    createdAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresPipelineCheckpointStore', () => {
  describe('setup()', () => {
    it('issues CREATE TABLE and index DDL using the configured table name', async () => {
      const { client, calls } = createMockClient([
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
      ])
      const store = new PostgresPipelineCheckpointStore({
        client,
        tableName: 'my_checkpoints',
      })

      await store.setup()

      expect(calls).toHaveLength(3)
      expect(calls[0]!.text).toContain('CREATE TABLE IF NOT EXISTS my_checkpoints')
      expect(calls[1]!.text).toContain('CREATE INDEX IF NOT EXISTS my_checkpoints_run_idx')
      expect(calls[2]!.text).toContain('CREATE INDEX IF NOT EXISTS my_checkpoints_expiry_idx')
    })

    it('rejects table names with SQL metacharacters', () => {
      const { client } = createMockClient([])
      expect(
        () => new PostgresPipelineCheckpointStore({ client, tableName: 'evil"; DROP' }),
      ).toThrow(/Invalid tableName/)
    })
  })

  describe('save()', () => {
    let client: PostgresClientLike
    let calls: RecordedCall[]
    let store: PostgresPipelineCheckpointStore

    beforeEach(() => {
      const mock = createMockClient([() => ({ rows: [] })])
      client = mock.client
      calls = mock.calls
      store = new PostgresPipelineCheckpointStore({ client })
    })

    it('issues an UPSERT with JSON-serialised payloads', async () => {
      await store.save(makeCheckpoint())

      expect(calls).toHaveLength(1)
      expect(calls[0]!.text).toContain('INSERT INTO pipeline_checkpoints')
      expect(calls[0]!.text).toContain('ON CONFLICT (pipeline_run_id, version)')
      expect(calls[0]!.params[0]).toBe('run-1')
      expect(calls[0]!.params[4]).toBe(JSON.stringify(['start']))
      expect(calls[0]!.params[5]).toBe(JSON.stringify({ result: 'ok' }))
      // expires_at should be null when defaultTtlMs is not set.
      expect(calls[0]!.params[9]).toBeNull()
    })

    it('populates expires_at when defaultTtlMs is configured', async () => {
      const mock = createMockClient([() => ({ rows: [] })])
      const ttlStore = new PostgresPipelineCheckpointStore({
        client: mock.client,
        defaultTtlMs: 60_000,
      })

      const before = Date.now()
      await ttlStore.save(makeCheckpoint())
      const after = Date.now()

      const expiresAtStr = mock.calls[0]!.params[9] as string
      expect(typeof expiresAtStr).toBe('string')
      const expiresAtMs = new Date(expiresAtStr).getTime()
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60_000 - 10)
      expect(expiresAtMs).toBeLessThanOrEqual(after + 60_000 + 10)
    })
  })

  describe('load()', () => {
    it('returns the highest version honouring expiry filter and coerces rows', async () => {
      const { client, calls } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: 'run-1',
              pipeline_id: 'pipeline-1',
              version: 3,
              schema_version: '1.0.0',
              completed_node_ids: ['a', 'b', 'c'],
              state: { step: 3 },
              suspended_at_node_id: null,
              budget_state: null,
              created_at: '2026-04-24T00:00:00.000Z',
              expires_at: null,
            },
          ],
        }),
      ])
      const store = new PostgresPipelineCheckpointStore({ client })

      const result = await store.load('run-1')
      expect(result).toBeDefined()
      expect(result!.version).toBe(3)
      expect(result!.completedNodeIds).toEqual(['a', 'b', 'c'])
      expect(calls[0]!.text).toContain('ORDER BY version DESC')
      expect(calls[0]!.text).toContain('expires_at IS NULL OR expires_at > NOW()')
    })

    it('returns undefined when no rows match', async () => {
      const { client } = createMockClient([() => ({ rows: [] })])
      const store = new PostgresPipelineCheckpointStore({ client })
      const result = await store.load('missing')
      expect(result).toBeUndefined()
    })

    it('re-hydrates suspendedAtNodeId and budgetState when present', async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: 'run-1',
              pipeline_id: 'pipeline-1',
              version: 1,
              schema_version: '1.0.0',
              completed_node_ids: ['start'],
              state: {},
              suspended_at_node_id: 'approval-gate',
              budget_state: { tokensUsed: 42, costCents: 3 },
              created_at: new Date('2026-04-24T00:00:00.000Z'),
              expires_at: null,
            },
          ],
        }),
      ])
      const store = new PostgresPipelineCheckpointStore({ client })
      const result = await store.load('run-1')
      expect(result!.suspendedAtNodeId).toBe('approval-gate')
      expect(result!.budgetState).toEqual({ tokensUsed: 42, costCents: 3 })
      // Date objects are normalised to ISO strings.
      expect(result!.createdAt).toBe('2026-04-24T00:00:00.000Z')
    })
  })

  describe('listVersions()', () => {
    it('maps rows into sorted summaries', async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: 'run-1',
              version: 1,
              created_at: '2026-04-24T00:00:00.000Z',
              completed_node_ids: ['a'],
            },
            {
              pipeline_run_id: 'run-1',
              version: 2,
              created_at: '2026-04-24T00:01:00.000Z',
              completed_node_ids: ['a', 'b'],
            },
          ],
        }),
      ])
      const store = new PostgresPipelineCheckpointStore({ client })
      const versions = await store.listVersions('run-1')
      expect(versions).toHaveLength(2)
      expect(versions[0]!.completedNodeCount).toBe(1)
      expect(versions[1]!.completedNodeCount).toBe(2)
    })
  })

  describe('delete() + prune()', () => {
    it('issues a DELETE with the correct runId', async () => {
      const { client, calls } = createMockClient([() => ({ rows: [] })])
      const store = new PostgresPipelineCheckpointStore({ client })

      await store.delete('run-9')
      expect(calls[0]!.text).toContain('DELETE FROM pipeline_checkpoints')
      expect(calls[0]!.params).toEqual(['run-9'])
    })

    it('prune returns rowCount when the adapter exposes it', async () => {
      const mock = {
        client: {
          query: vi.fn(async () => ({ rows: [], rowCount: 5 })),
        } as unknown as PostgresClientLike,
      }
      const store = new PostgresPipelineCheckpointStore({ client: mock.client })
      const pruned = await store.prune(60_000)
      expect(pruned).toBe(5)
    })
  })
})
