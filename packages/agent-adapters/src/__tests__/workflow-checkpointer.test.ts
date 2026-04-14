import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  WorkflowCheckpointer,
  InMemoryCheckpointStore,
} from '../session/workflow-checkpointer.js'
import type {
  StepDefinition,
  CheckpointerConfig,
} from '../session/workflow-checkpointer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

function makeSteps(ids: string[], deps?: Record<string, string[]>): StepDefinition[] {
  return ids.map((id) => ({
    stepId: id,
    description: `Step ${id}`,
    tags: ['general'],
    dependsOn: deps?.[id],
  }))
}

// ---------------------------------------------------------------------------
// InMemoryCheckpointStore tests
// ---------------------------------------------------------------------------

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore

  beforeEach(() => {
    store = new InMemoryCheckpointStore()
  })

  it('saves and loads a checkpoint', async () => {
    const cp = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: 'step-1',
      totalSteps: 2,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: { foo: 'bar' },
    }

    await store.save(cp)
    const loaded = await store.load('wf-1')

    expect(loaded).toBeDefined()
    expect(loaded!.checkpointId).toBe('cp-1')
    expect(loaded!.state).toEqual({ foo: 'bar' })
  })

  it('loads specific version', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: 'step-1',
      totalSteps: 2,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: {},
    }

    await store.save({ ...base, version: 1, state: { v: 1 } })
    await store.save({ ...base, version: 2, state: { v: 2 } })

    const v1 = await store.load('wf-1', 1)
    expect(v1!.state).toEqual({ v: 1 })

    const v2 = await store.load('wf-1', 2)
    expect(v2!.state).toEqual({ v: 2 })
  })

  it('loads latest version by default', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: '',
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: {},
    }

    await store.save({ ...base, version: 1 })
    await store.save({ ...base, version: 3 })
    await store.save({ ...base, version: 2 })

    const latest = await store.load('wf-1')
    expect(latest!.version).toBe(3)
  })

  it('returns undefined for non-existent workflow', async () => {
    const result = await store.load('nonexistent')
    expect(result).toBeUndefined()
  })

  it('lists versions sorted', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: '',
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: {},
    }

    await store.save({ ...base, version: 3 })
    await store.save({ ...base, version: 1 })
    await store.save({ ...base, version: 2 })

    const versions = await store.listVersions('wf-1')
    expect(versions).toEqual([1, 2, 3])
  })

  it('returns empty array for non-existent workflow versions', async () => {
    expect(await store.listVersions('nonexistent')).toEqual([])
  })

  it('deletes specific version', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: '',
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: {},
    }

    await store.save({ ...base, version: 1 })
    await store.save({ ...base, version: 2 })

    await store.delete('wf-1', 1)
    expect(await store.listVersions('wf-1')).toEqual([2])
  })

  it('deletes all versions when no version specified', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: '',
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: {},
    }

    await store.save({ ...base, version: 1 })
    await store.save({ ...base, version: 2 })

    await store.delete('wf-1')
    expect(await store.listVersions('wf-1')).toEqual([])
    expect(await store.load('wf-1')).toBeUndefined()
  })

  it('returns deep clones so mutations do not propagate', async () => {
    const base = {
      checkpointId: 'cp-1',
      workflowId: 'wf-1',
      version: 1,
      createdAt: new Date(),
      currentStep: '',
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: { mutable: 'original' },
    }

    await store.save(base)
    const loaded = await store.load('wf-1')
    loaded!.state['mutable'] = 'mutated'

    const reloaded = await store.load('wf-1')
    expect(reloaded!.state['mutable']).toBe('original')
  })
})

// ---------------------------------------------------------------------------
// WorkflowCheckpointer tests
// ---------------------------------------------------------------------------

describe('WorkflowCheckpointer', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]
  let checkpointer: WorkflowCheckpointer

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
    checkpointer = new WorkflowCheckpointer({ eventBus: bus })
  })

  describe('createWorkflow', () => {
    it('creates workflow with steps', async () => {
      const steps = makeSteps(['a', 'b', 'c'])
      const cp = await checkpointer.createWorkflow('wf-1', steps)

      expect(cp.workflowId).toBe('wf-1')
      expect(cp.version).toBe(1)
      expect(cp.totalSteps).toBe(3)
      expect(cp.currentStep).toBe('a')
      expect(cp.pendingSteps).toHaveLength(3)
      expect(cp.completedSteps).toHaveLength(0)
    })

    it('uses initial state when provided', async () => {
      const cp = await checkpointer.createWorkflow(
        'wf-1',
        makeSteps(['a']),
        { key: 'value' },
      )
      expect(cp.state).toEqual({ key: 'value' })
    })

    it('emits checkpoint_saved event', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']))

      const cpEvents = emitted.filter((e) => e.type === 'pipeline:checkpoint_saved')
      expect(cpEvents).toHaveLength(1)
    })
  })

  describe('completeStep', () => {
    it('moves step from pending to completed and auto-checkpoints', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a', 'b']))

      const cp = await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'Step A done',
        success: true,
        durationMs: 100,
      })

      expect(cp.completedSteps).toHaveLength(1)
      expect(cp.completedSteps[0]!.stepId).toBe('a')
      expect(cp.pendingSteps).toHaveLength(1)
      expect(cp.currentStep).toBe('b')
      // Version incremented by auto-checkpoint
      expect(cp.version).toBe(2)
    })

    it('throws for non-existent workflow', async () => {
      await expect(
        checkpointer.completeStep('nonexistent', 'a', {
          providerId: 'claude',
          result: 'done',
          success: true,
          durationMs: 0,
        }),
      ).rejects.toThrow('not found')
    })

    it('skips auto-checkpoint when disabled', async () => {
      const noAutoCheckpointer = new WorkflowCheckpointer({
        eventBus: bus,
        autoCheckpoint: false,
      })

      await noAutoCheckpointer.createWorkflow('wf-1', makeSteps(['a', 'b']))
      const cp = await noAutoCheckpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 50,
      })

      // Version stays at 1 (only the initial save)
      expect(cp.version).toBe(1)
    })
  })

  describe('getNextStep', () => {
    it('respects dependencies', async () => {
      const steps = makeSteps(['a', 'b', 'c'], {
        b: ['a'],
        c: ['a', 'b'],
      })
      await checkpointer.createWorkflow('wf-1', steps)

      // Initially only 'a' is ready (no deps)
      const next1 = checkpointer.getNextStep('wf-1')
      expect(next1!.stepId).toBe('a')

      // Complete 'a', now 'b' is ready
      await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      const next2 = checkpointer.getNextStep('wf-1')
      expect(next2!.stepId).toBe('b')

      // Complete 'b', now 'c' is ready
      await checkpointer.completeStep('wf-1', 'b', {
        providerId: 'codex',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      const next3 = checkpointer.getNextStep('wf-1')
      expect(next3!.stepId).toBe('c')
    })

    it('returns undefined when all steps complete', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']))
      await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      expect(checkpointer.getNextStep('wf-1')).toBeUndefined()
    })

    it('returns undefined for unknown workflow', () => {
      expect(checkpointer.getNextStep('nonexistent')).toBeUndefined()
    })
  })

  describe('getPendingSteps', () => {
    it('returns remaining steps', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a', 'b', 'c']))
      await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      const pending = checkpointer.getPendingSteps('wf-1')
      expect(pending).toHaveLength(2)
      expect(pending.map((s) => s.stepId)).toEqual(['b', 'c'])
    })

    it('returns empty array for unknown workflow', () => {
      expect(checkpointer.getPendingSteps('nonexistent')).toEqual([])
    })
  })

  describe('checkpoint', () => {
    it('increments version', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']))

      const cp1 = await checkpointer.checkpoint('wf-1')
      expect(cp1.version).toBe(2)

      const cp2 = await checkpointer.checkpoint('wf-1')
      expect(cp2.version).toBe(3)
    })

    it('emits checkpoint and suspended events', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']))

      // Reset emitted to only track checkpoint call
      emitted.length = 0
      await checkpointer.checkpoint('wf-1')

      const types = emitted.map((e) => e.type)
      expect(types).toContain('pipeline:checkpoint_saved')
      expect(types).toContain('pipeline:suspended')
    })

    it('throws for unknown workflow', async () => {
      await expect(checkpointer.checkpoint('nonexistent')).rejects.toThrow('not found')
    })
  })

  describe('resume', () => {
    it('restores from store', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a', 'b']))
      await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      // Create a new checkpointer that shares the same store
      const store = new InMemoryCheckpointStore()
      const cp1 = new WorkflowCheckpointer({ store, eventBus: bus })
      await cp1.createWorkflow('wf-resume', makeSteps(['x', 'y']))
      await cp1.completeStep('wf-resume', 'x', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 5,
      })

      // Resume from the same store in a new checkpointer
      const cp2 = new WorkflowCheckpointer({ store, eventBus: bus })
      const resumed = await cp2.resume('wf-resume')

      expect(resumed.completedSteps).toHaveLength(1)
      expect(resumed.pendingSteps).toHaveLength(1)
      expect(resumed.currentStep).toBe('y')
    })

    it('throws when no checkpoint exists', async () => {
      await expect(checkpointer.resume('nonexistent')).rejects.toThrow('No checkpoints found')
    })

    it('throws for specific version not found', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']))
      await expect(checkpointer.resume('wf-1', 999)).rejects.toThrow('v999 not found')
    })

    it('emits resumed event', async () => {
      const store = new InMemoryCheckpointStore()
      const cp1 = new WorkflowCheckpointer({ store, eventBus: bus })
      await cp1.createWorkflow('wf-1', makeSteps(['a']))

      emitted.length = 0
      const cp2 = new WorkflowCheckpointer({ store, eventBus: bus })
      await cp2.resume('wf-1')

      const types = emitted.map((e) => e.type)
      expect(types).toContain('pipeline:resumed')
    })
  })

  describe('updateState', () => {
    it('persists arbitrary data', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']), { x: 1 })
      checkpointer.updateState('wf-1', { y: 2 })

      const state = checkpointer.getState('wf-1')
      expect(state!.state).toEqual({ x: 1, y: 2 })
    })

    it('throws for unknown workflow', () => {
      expect(() => checkpointer.updateState('nonexistent', {})).toThrow('not found')
    })
  })

  describe('getState', () => {
    it('returns undefined for unknown workflow', () => {
      expect(checkpointer.getState('nonexistent')).toBeUndefined()
    })

    it('returns deep clone', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a']), { val: 'original' })
      const state = checkpointer.getState('wf-1')!
      state.state['val'] = 'mutated'

      const state2 = checkpointer.getState('wf-1')!
      expect(state2.state['val']).toBe('original')
    })
  })

  describe('listVersions', () => {
    it('returns persisted versions', async () => {
      await checkpointer.createWorkflow('wf-1', makeSteps(['a', 'b']))
      await checkpointer.completeStep('wf-1', 'a', {
        providerId: 'claude',
        result: 'done',
        success: true,
        durationMs: 10,
      })

      const versions = await checkpointer.listVersions('wf-1')
      expect(versions).toEqual([1, 2])
    })
  })
})
