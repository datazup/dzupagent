import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  SpecialistRegistry,
  type SpecialistConfig,
  type SpecialistRegistryConfig,
} from '../self-correction/specialist-registry.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()

  function nsKey(namespace: string[]): string {
    return namespace.join('/')
  }

  return {
    async get(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      return ns?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(namespace)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      if (ns) ns.delete(key)
    },
    async search(namespace: string[], _options?: { limit?: number }) {
      const ns = data.get(nsKey(namespace))
      if (!ns) return []
      return Array.from(ns.values())
    },
    async batch(_ops: unknown[]) { return [] },
    async list(_prefix: string[]) { return [] },
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpecialistRegistry', () => {
  let store: BaseStore
  let registry: SpecialistRegistry

  beforeEach(() => {
    store = createMemoryStore()
    registry = new SpecialistRegistry({ store })
  })

  // -------------------------------------------------------------------------
  // Default configs
  // -------------------------------------------------------------------------

  describe('built-in defaults', () => {
    it('returns auth config with powerful model tier', async () => {
      const config = await registry.getConfig('auth')
      expect(config.category).toBe('auth')
      expect(config.modelTier).toBe('powerful')
      expect(config.reflectionDepth).toBe(3)
      expect(config.verificationStrategy).toBe('consensus')
      expect(config.maxFixAttempts).toBe(5)
      expect(config.qualityThreshold).toBe(0.9)
    })

    it('returns payments config matching auth complexity', async () => {
      const config = await registry.getConfig('payments')
      expect(config.modelTier).toBe('powerful')
      expect(config.verificationStrategy).toBe('consensus')
      expect(config.qualityThreshold).toBe(0.9)
    })

    it('returns crud config with balanced tier', async () => {
      const config = await registry.getConfig('crud')
      expect(config.modelTier).toBe('balanced')
      expect(config.reflectionDepth).toBe(1)
      expect(config.verificationStrategy).toBe('single')
      expect(config.qualityThreshold).toBe(0.7)
    })

    it('returns dashboard config with moderate reflection', async () => {
      const config = await registry.getConfig('dashboard')
      expect(config.reflectionDepth).toBe(2)
      expect(config.qualityThreshold).toBe(0.75)
    })

    it('returns realtime config with vote verification', async () => {
      const config = await registry.getConfig('realtime')
      expect(config.modelTier).toBe('powerful')
      expect(config.verificationStrategy).toBe('vote')
      expect(config.qualityThreshold).toBe(0.85)
    })

    it('returns analytics config with balanced settings', async () => {
      const config = await registry.getConfig('analytics')
      expect(config.modelTier).toBe('balanced')
      expect(config.reflectionDepth).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Unknown category fallback
  // -------------------------------------------------------------------------

  describe('unknown category fallback', () => {
    it('falls back to default config for unknown categories', async () => {
      const config = await registry.getConfig('unknown_feature')
      expect(config.category).toBe('unknown_feature')
      expect(config.modelTier).toBe('balanced')
      expect(config.reflectionDepth).toBe(1)
      expect(config.verificationStrategy).toBe('single')
      expect(config.maxFixAttempts).toBe(3)
      expect(config.qualityThreshold).toBe(0.7)
    })
  })

  // -------------------------------------------------------------------------
  // Risk class adjustments
  // -------------------------------------------------------------------------

  describe('risk class adjustments', () => {
    it('critical: upgrades to powerful, consensus, +2 reflection', async () => {
      const config = await registry.getConfig('crud', 'critical')
      expect(config.modelTier).toBe('powerful')
      expect(config.verificationStrategy).toBe('consensus')
      expect(config.reflectionDepth).toBe(3) // 1 + 2
    })

    it('critical: caps reflectionDepth at 5', async () => {
      const config = await registry.getConfig('auth', 'critical')
      // auth base is 3, +2 = 5 (capped)
      expect(config.reflectionDepth).toBe(5)
    })

    it('sensitive: +1 reflection, +0.1 quality threshold', async () => {
      const config = await registry.getConfig('crud', 'sensitive')
      expect(config.reflectionDepth).toBe(2) // 1 + 1
      expect(config.qualityThreshold).toBeCloseTo(0.8) // 0.7 + 0.1
    })

    it('sensitive: caps quality threshold at 1.0', async () => {
      const config = await registry.getConfig('auth', 'sensitive')
      // auth base is 0.9, +0.1 = 1.0 (capped)
      expect(config.qualityThreshold).toBe(1.0)
    })

    it('standard: no adjustment', async () => {
      const config = await registry.getConfig('crud', 'standard')
      expect(config.modelTier).toBe('balanced')
      expect(config.reflectionDepth).toBe(1)
      expect(config.qualityThreshold).toBe(0.7)
    })

    it('cosmetic: zero reflection, single verification', async () => {
      const config = await registry.getConfig('auth', 'cosmetic')
      expect(config.reflectionDepth).toBe(0)
      expect(config.verificationStrategy).toBe('single')
      // modelTier and qualityThreshold remain from auth base
      expect(config.modelTier).toBe('powerful')
    })
  })

  // -------------------------------------------------------------------------
  // Node overrides
  // -------------------------------------------------------------------------

  describe('node overrides', () => {
    it('applies node-level overrides from custom defaults', async () => {
      const reg = new SpecialistRegistry({
        customDefaults: {
          auth: {
            nodeOverrides: {
              gen_backend: {
                reflectionDepth: 5,
                qualityThreshold: 0.95,
              },
            },
          },
        },
      })

      const nodeConfig = await reg.getNodeConfig('auth', 'gen_backend')
      expect(nodeConfig.reflectionDepth).toBe(5)
      expect(nodeConfig.qualityThreshold).toBe(0.95)
      expect(nodeConfig.modelTier).toBe('powerful') // from base auth
    })

    it('returns base config when no node override exists', async () => {
      const nodeConfig = await registry.getNodeConfig('auth', 'gen_frontend')
      expect(nodeConfig.modelTier).toBe('powerful')
      expect(nodeConfig.reflectionDepth).toBe(3)
      expect(nodeConfig.qualityThreshold).toBe(0.9)
    })

    it('applies risk class before node overrides', async () => {
      const reg = new SpecialistRegistry({
        customDefaults: {
          crud: {
            nodeOverrides: {
              gen_backend: { modelTier: 'fast' },
            },
          },
        },
      })

      // critical risk sets modelTier to 'powerful', but node override overrides it
      const nodeConfig = await reg.getNodeConfig('crud', 'gen_backend', 'critical')
      expect(nodeConfig.modelTier).toBe('fast') // node override wins
      expect(nodeConfig.reflectionDepth).toBe(3) // crud(1) + critical(+2)
    })
  })

  // -------------------------------------------------------------------------
  // Dynamic overrides
  // -------------------------------------------------------------------------

  describe('dynamic overrides via store', () => {
    it('applies dynamic override from store', async () => {
      await registry.setOverride('crud', {
        modelTier: 'powerful',
        reflectionDepth: 4,
      })

      const config = await registry.getConfig('crud')
      expect(config.modelTier).toBe('powerful')
      expect(config.reflectionDepth).toBe(4)
      // Unchanged fields stay at built-in defaults
      expect(config.verificationStrategy).toBe('single')
    })

    it('throws when setting override without a store', async () => {
      const noStoreRegistry = new SpecialistRegistry()
      await expect(
        noStoreRegistry.setOverride('crud', { modelTier: 'powerful' }),
      ).rejects.toThrow('cannot set override without a configured store')
    })

    it('dynamic override is merged with custom defaults', async () => {
      const reg = new SpecialistRegistry({
        store,
        customDefaults: {
          crud: { qualityThreshold: 0.8 },
        },
      })

      await reg.setOverride('crud', { reflectionDepth: 3 })

      const config = await reg.getConfig('crud')
      expect(config.qualityThreshold).toBe(0.8) // from custom default
      expect(config.reflectionDepth).toBe(3)    // from dynamic override
      expect(config.modelTier).toBe('balanced') // from built-in
    })
  })

  // -------------------------------------------------------------------------
  // Custom defaults
  // -------------------------------------------------------------------------

  describe('custom defaults', () => {
    it('merges custom defaults with built-in defaults', async () => {
      const reg = new SpecialistRegistry({
        customDefaults: {
          auth: { maxFixAttempts: 10 },
        },
      })

      const config = await reg.getConfig('auth')
      expect(config.maxFixAttempts).toBe(10)
      expect(config.modelTier).toBe('powerful') // unchanged
    })

    it('supports entirely new categories via custom defaults', async () => {
      const reg = new SpecialistRegistry({
        customDefaults: {
          notifications: {
            modelTier: 'fast',
            reflectionDepth: 0,
            qualityThreshold: 0.6,
          },
        },
      })

      const config = await reg.getConfig('notifications')
      expect(config.modelTier).toBe('fast')
      expect(config.reflectionDepth).toBe(0)
      expect(config.qualityThreshold).toBe(0.6)
      // Falls back to 'default' built-in for unspecified fields
      expect(config.verificationStrategy).toBe('single')
    })
  })

  // -------------------------------------------------------------------------
  // Category listing
  // -------------------------------------------------------------------------

  describe('getCategories', () => {
    it('returns all built-in categories sorted', () => {
      const categories = registry.getCategories()
      expect(categories).toEqual([
        'analytics',
        'auth',
        'crud',
        'dashboard',
        'default',
        'payments',
        'realtime',
      ])
    })

    it('includes custom default categories', () => {
      const reg = new SpecialistRegistry({
        customDefaults: { notifications: { modelTier: 'fast' } },
      })
      const categories = reg.getCategories()
      expect(categories).toContain('notifications')
    })
  })

  // -------------------------------------------------------------------------
  // getDefaultConfig (synchronous, no store)
  // -------------------------------------------------------------------------

  describe('getDefaultConfig', () => {
    it('returns built-in default without store/custom layers', () => {
      const config = registry.getDefaultConfig('auth')
      expect(config.modelTier).toBe('powerful')
      expect(config.category).toBe('auth')
    })

    it('returns default category for unknown types', () => {
      const config = registry.getDefaultConfig('unknown')
      expect(config.category).toBe('unknown')
      expect(config.modelTier).toBe('balanced')
    })

    it('returns a clone (mutations do not affect registry)', () => {
      const config1 = registry.getDefaultConfig('auth')
      config1.modelTier = 'fast'
      const config2 = registry.getDefaultConfig('auth')
      expect(config2.modelTier).toBe('powerful')
    })
  })

  // -------------------------------------------------------------------------
  // Store-less mode
  // -------------------------------------------------------------------------

  describe('store-less mode', () => {
    it('works without a store configured', async () => {
      const reg = new SpecialistRegistry()
      const config = await reg.getConfig('auth')
      expect(config.modelTier).toBe('powerful')
    })

    it('works with custom defaults but no store', async () => {
      const reg = new SpecialistRegistry({
        customDefaults: { auth: { maxFixAttempts: 7 } },
      })
      const config = await reg.getConfig('auth')
      expect(config.maxFixAttempts).toBe(7)
    })
  })

  // -------------------------------------------------------------------------
  // Merge order
  // -------------------------------------------------------------------------

  describe('merge precedence', () => {
    it('dynamic override wins over custom default wins over built-in', async () => {
      const reg = new SpecialistRegistry({
        store,
        customDefaults: {
          crud: { reflectionDepth: 2, qualityThreshold: 0.8 },
        },
      })

      // Dynamic override for reflectionDepth only
      await reg.setOverride('crud', { reflectionDepth: 4 })

      const config = await reg.getConfig('crud')
      expect(config.reflectionDepth).toBe(4)        // dynamic override
      expect(config.qualityThreshold).toBe(0.8)      // custom default
      expect(config.verificationStrategy).toBe('single') // built-in
    })
  })
})
