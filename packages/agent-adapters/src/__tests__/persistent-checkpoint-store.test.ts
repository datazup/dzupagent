import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FileCheckpointStore } from '../persistence/persistent-checkpoint-store.js'
import type { WorkflowCheckpoint } from '../session/workflow-checkpointer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(
  workflowId: string,
  version: number,
  overrides?: Partial<WorkflowCheckpoint>,
): WorkflowCheckpoint {
  return {
    checkpointId: `ckpt-${workflowId}-v${version}`,
    workflowId,
    version,
    createdAt: new Date('2025-06-01T12:00:00Z'),
    currentStep: 'step-1',
    totalSteps: 3,
    completedSteps: [],
    pendingSteps: [],
    providerSessions: [],
    state: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileCheckpointStore', () => {
  let tmpDir: string
  let store: FileCheckpointStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fcs-test-'))
    store = new FileCheckpointStore({ directory: tmpDir })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('save', () => {
    it('creates directory and file', async () => {
      const checkpoint = makeCheckpoint('wf-1', 1)

      await store.save(checkpoint)

      const loaded = await store.load('wf-1', 1)
      expect(loaded).toBeDefined()
      expect(loaded!.checkpointId).toBe('ckpt-wf-1-v1')
    })
  })

  describe('load', () => {
    it('returns saved checkpoint', async () => {
      const checkpoint = makeCheckpoint('wf-2', 1, {
        currentStep: 'deploy',
        state: { key: 'value' },
      })

      await store.save(checkpoint)
      const loaded = await store.load('wf-2', 1)

      expect(loaded).toBeDefined()
      expect(loaded!.currentStep).toBe('deploy')
      expect(loaded!.state).toEqual({ key: 'value' })
    })

    it('returns undefined for non-existent workflow', async () => {
      const loaded = await store.load('non-existent', 1)
      expect(loaded).toBeUndefined()
    })

    it('returns undefined for non-existent version', async () => {
      await store.save(makeCheckpoint('wf-3', 1))
      const loaded = await store.load('wf-3', 99)
      expect(loaded).toBeUndefined()
    })

    it('loads latest when no version specified', async () => {
      await store.save(makeCheckpoint('wf-4', 1, { currentStep: 'step-1' }))
      await store.save(makeCheckpoint('wf-4', 2, { currentStep: 'step-2' }))
      await store.save(makeCheckpoint('wf-4', 3, { currentStep: 'step-3' }))

      const loaded = await store.load('wf-4')

      expect(loaded).toBeDefined()
      expect(loaded!.version).toBe(3)
      expect(loaded!.currentStep).toBe('step-3')
    })

    it('returns undefined when loading latest from non-existent workflow', async () => {
      const loaded = await store.load('missing')
      expect(loaded).toBeUndefined()
    })
  })

  describe('listVersions', () => {
    it('returns sorted versions', async () => {
      await store.save(makeCheckpoint('wf-5', 3))
      await store.save(makeCheckpoint('wf-5', 1))
      await store.save(makeCheckpoint('wf-5', 2))

      const versions = await store.listVersions('wf-5')

      expect(versions).toEqual([1, 2, 3])
    })

    it('returns empty array for non-existent workflow', async () => {
      const versions = await store.listVersions('nope')
      expect(versions).toEqual([])
    })
  })

  describe('delete', () => {
    it('deletes specific version', async () => {
      await store.save(makeCheckpoint('wf-6', 1))
      await store.save(makeCheckpoint('wf-6', 2))

      await store.delete('wf-6', 1)

      const versions = await store.listVersions('wf-6')
      expect(versions).toEqual([2])
    })

    it('deletes all versions when version not specified', async () => {
      await store.save(makeCheckpoint('wf-7', 1))
      await store.save(makeCheckpoint('wf-7', 2))
      await store.save(makeCheckpoint('wf-7', 3))

      await store.delete('wf-7')

      const versions = await store.listVersions('wf-7')
      expect(versions).toEqual([])
    })

    it('is idempotent for non-existent version', async () => {
      await store.save(makeCheckpoint('wf-8', 1))
      await expect(store.delete('wf-8', 99)).resolves.toBeUndefined()
    })

    it('is idempotent for non-existent workflow', async () => {
      await expect(store.delete('nope')).resolves.toBeUndefined()
    })

    it('cleans up empty directory after last version deleted', async () => {
      await store.save(makeCheckpoint('wf-9', 1))
      await store.delete('wf-9', 1)

      // The directory should be cleaned up
      const versions = await store.listVersions('wf-9')
      expect(versions).toEqual([])
    })
  })

  describe('prettyPrint option', () => {
    it('stores formatted JSON when prettyPrint is true', async () => {
      const prettyStore = new FileCheckpointStore({
        directory: tmpDir,
        prettyPrint: true,
      })
      const checkpoint = makeCheckpoint('wf-pretty', 1)

      await prettyStore.save(checkpoint)

      // Verify it can still be loaded correctly
      const loaded = await prettyStore.load('wf-pretty', 1)
      expect(loaded).toBeDefined()
      expect(loaded!.checkpointId).toBe('ckpt-wf-pretty-v1')

      // Read raw file to verify formatting
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(
        path.join(tmpDir, 'wf-pretty', 'v1.json'),
        'utf-8',
      )
      // Pretty-printed JSON has newlines and indentation
      expect(raw).toContain('\n')
      expect(raw).toContain('  ')
    })
  })

  describe('date reviving', () => {
    it('revives createdAt as Date object', async () => {
      const checkpoint = makeCheckpoint('wf-dates', 1, {
        createdAt: new Date('2025-01-15T10:30:00Z'),
      })

      await store.save(checkpoint)
      const loaded = await store.load('wf-dates', 1)

      expect(loaded!.createdAt).toBeInstanceOf(Date)
      expect(loaded!.createdAt.toISOString()).toBe('2025-01-15T10:30:00.000Z')
    })

    it('revives completedAt in step results', async () => {
      const checkpoint = makeCheckpoint('wf-dates2', 1, {
        completedSteps: [
          {
            stepId: 's1',
            providerId: 'claude',
            result: 'done',
            success: true,
            durationMs: 100,
            completedAt: new Date('2025-02-01T08:00:00Z'),
          },
        ],
      })

      await store.save(checkpoint)
      const loaded = await store.load('wf-dates2', 1)

      expect(loaded!.completedSteps[0]!.completedAt).toBeInstanceOf(Date)
    })
  })
})
