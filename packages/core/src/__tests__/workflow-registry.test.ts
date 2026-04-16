import { describe, it, expect } from 'vitest'
import { WorkflowRegistry } from '../skills/workflow-registry.js'
import { createSkillChain } from '../skills/skill-chain.js'
import type { SkillChain } from '../skills/skill-chain.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chain(name: string): SkillChain {
  return createSkillChain(name, [{ skillName: 'step' }])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRegistry', () => {
  describe('register / get', () => {
    it('stores and retrieves a chain case-insensitively', () => {
      const registry = new WorkflowRegistry()
      const c = chain('MyFlow')
      registry.register('MyFlow', c)

      expect(registry.get('myflow')).toBe(c)
      expect(registry.get('MYFLOW')).toBe(c)
    })

    it('throws on duplicate registration without overwrite', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow', chain('flow'))
      expect(() => registry.register('flow', chain('flow2'))).toThrow(/already registered/)
    })

    it('overwrites when overwrite option is set', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow', chain('flow-v1'))
      const v2 = chain('flow-v2')
      registry.register('flow', v2, { overwrite: true })

      expect(registry.get('flow')).toBe(v2)
    })
  })

  describe('unregister', () => {
    it('returns true when entry existed', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow', chain('flow'))
      expect(registry.unregister('flow')).toBe(true)
      expect(registry.get('flow')).toBeUndefined()
    })

    it('returns false for non-existent entry', () => {
      const registry = new WorkflowRegistry()
      expect(registry.unregister('nope')).toBe(false)
    })
  })

  describe('find', () => {
    it('matches by name with confidence 1.0', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow-name', chain('flow-name'))

      const results = registry.find('flow')
      expect(results).toHaveLength(1)
      expect(results[0]!.confidence).toBe(1.0)
      expect(results[0]!.matchReason).toBe('name match')
    })

    it('matches by tag with confidence 0.7', () => {
      const registry = new WorkflowRegistry()
      registry.register('workflow', chain('workflow'), { tags: ['tag1', 'tag2'] })

      const results = registry.find('tag1')
      expect(results).toHaveLength(1)
      expect(results[0]!.confidence).toBe(0.7)
    })

    it('matches by description with confidence 0.4', () => {
      const registry = new WorkflowRegistry()
      registry.register('workflow', chain('workflow'), {
        description: 'automate things',
      })

      const results = registry.find('automate')
      expect(results).toHaveLength(1)
      expect(results[0]!.confidence).toBe(0.4)
      expect(results[0]!.matchReason).toBe('description match')
    })

    it('returns multiple matches sorted descending by confidence', () => {
      const registry = new WorkflowRegistry()
      registry.register('build-flow', chain('build-flow'), {
        description: 'deploys code',
      })
      registry.register('deploy-flow', chain('deploy-flow'), {
        tags: ['deploy'],
      })

      // "deploy" matches build-flow by description (0.4) and deploy-flow by name (1.0) + tag (0.7)
      const results = registry.find('deploy')
      expect(results.length).toBeGreaterThanOrEqual(2)
      // First result should have highest confidence
      expect(results[0]!.confidence).toBeGreaterThanOrEqual(results[1]!.confidence)
    })

    it('returns empty array for empty query', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow', chain('flow'))
      expect(registry.find('')).toEqual([])
    })
  })

  describe('list', () => {
    it('returns entries sorted alphabetically with stepCount', () => {
      const registry = new WorkflowRegistry()
      registry.register('Zebra', chain('Zebra'))
      registry.register('Alpha', chain('Alpha'))

      const items = registry.list()
      expect(items).toHaveLength(2)
      expect(items[0]!.name).toBe('Alpha')
      expect(items[1]!.name).toBe('Zebra')
      expect(items[0]!.stepCount).toBe(1)
    })
  })

  describe('serialization', () => {
    it('round-trips through toJSON / fromJSON', () => {
      const registry = new WorkflowRegistry()
      registry.register('flow-a', chain('flow-a'), {
        description: 'desc',
        tags: ['t1'],
      })
      registry.register('flow-b', chain('flow-b'))

      const snapshot = registry.toJSON()
      const restored = WorkflowRegistry.fromJSON(snapshot)

      expect(restored.size).toBe(2)
      expect(restored.get('flow-a')).toBeDefined()
      expect(restored.get('flow-b')).toBeDefined()
      expect(restored.get('flow-a')!.name).toBe('flow-a')
    })

    it('fromJSON throws on wrong schemaVersion', () => {
      const bad = {
        schemaVersion: '2.0.0' as const,
        exportedAt: new Date().toISOString(),
        entries: [],
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => WorkflowRegistry.fromJSON(bad as any)).toThrow(/Unsupported schema version/)
    })
  })

  describe('fromJSON() validation', () => {
    it('throws when an entry has no name', () => {
      const snapshot = {
        schemaVersion: '1.0.0' as const,
        exportedAt: new Date().toISOString(),
        entries: [{ name: '', chain: { name: 'flow', steps: [{ skillName: 'a' }] }, registeredAt: new Date().toISOString() }],
      }
      expect(() => WorkflowRegistry.fromJSON(snapshot)).toThrow(/invalid or missing name/)
    })

    it('throws when an entry chain has empty steps', () => {
      const snapshot = {
        schemaVersion: '1.0.0' as const,
        exportedAt: new Date().toISOString(),
        entries: [{ name: 'bad-flow', chain: { name: 'bad-flow', steps: [] }, registeredAt: new Date().toISOString() }],
      }
      expect(() => WorkflowRegistry.fromJSON(snapshot)).toThrow(/no steps/)
    })

    it('throws when a step has invalid skillName', () => {
      const snapshot = {
        schemaVersion: '1.0.0' as const,
        exportedAt: new Date().toISOString(),
        entries: [{ name: 'bad', chain: { name: 'bad', steps: [{ skillName: '' }] }, registeredAt: new Date().toISOString() }],
      }
      expect(() => WorkflowRegistry.fromJSON(snapshot)).toThrow(/invalid skillName/)
    })
  })

  describe('size and clear', () => {
    it('size returns count', () => {
      const registry = new WorkflowRegistry()
      expect(registry.size).toBe(0)
      registry.register('flow', chain('flow'))
      expect(registry.size).toBe(1)
    })

    it('clear resets to 0', () => {
      const registry = new WorkflowRegistry()
      registry.register('a', chain('a'))
      registry.register('b', chain('b'))
      registry.clear()
      expect(registry.size).toBe(0)
    })
  })
})
