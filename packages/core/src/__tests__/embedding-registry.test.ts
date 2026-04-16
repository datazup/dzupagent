import { describe, it, expect, beforeEach } from 'vitest'
import {
  EmbeddingRegistry,
  createDefaultEmbeddingRegistry,
  COMMON_EMBEDDING_MODELS,
} from '../llm/embedding-registry.js'
import type { EmbeddingModelEntry } from '../llm/embedding-registry.js'

function makeEntry(overrides?: Partial<EmbeddingModelEntry>): EmbeddingModelEntry {
  return {
    id: overrides?.id ?? 'test/model-1',
    provider: overrides?.provider ?? 'test',
    model: overrides?.model ?? 'model-1',
    dimensions: overrides?.dimensions ?? 768,
    maxBatchSize: overrides?.maxBatchSize ?? 100,
    costPer1kTokens: overrides?.costPer1kTokens ?? 0.0001,
    description: overrides?.description,
  }
}

describe('EmbeddingRegistry', () => {
  let registry: EmbeddingRegistry

  beforeEach(() => {
    registry = new EmbeddingRegistry()
  })

  describe('register and get', () => {
    it('registers and retrieves a model entry', () => {
      const entry = makeEntry()
      registry.register(entry)

      const retrieved = registry.get('test/model-1')
      expect(retrieved).toEqual(entry)
    })

    it('returns undefined for non-existent model', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })

    it('overwrites existing entry with same id', () => {
      registry.register(makeEntry({ dimensions: 768 }))
      registry.register(makeEntry({ dimensions: 1536 }))

      const retrieved = registry.get('test/model-1')
      expect(retrieved!.dimensions).toBe(1536)
    })
  })

  describe('list', () => {
    it('returns empty array when no models registered', () => {
      expect(registry.list()).toEqual([])
    })

    it('returns all registered models', () => {
      registry.register(makeEntry({ id: 'a/1' }))
      registry.register(makeEntry({ id: 'b/2' }))

      expect(registry.list()).toHaveLength(2)
    })
  })

  describe('getByProvider', () => {
    it('filters models by provider', () => {
      registry.register(makeEntry({ id: 'openai/1', provider: 'openai' }))
      registry.register(makeEntry({ id: 'openai/2', provider: 'openai' }))
      registry.register(makeEntry({ id: 'voyage/1', provider: 'voyage' }))

      const openaiModels = registry.getByProvider('openai')
      expect(openaiModels).toHaveLength(2)
      expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true)
    })

    it('returns empty array for unknown provider', () => {
      registry.register(makeEntry({ id: 'a/1', provider: 'openai' }))
      expect(registry.getByProvider('unknown')).toEqual([])
    })
  })

  describe('getDefault', () => {
    it('returns first registered model', () => {
      registry.register(makeEntry({ id: 'first' }))
      registry.register(makeEntry({ id: 'second' }))

      const def = registry.getDefault()
      expect(def!.id).toBe('first')
    })

    it('returns first model for specific provider', () => {
      registry.register(makeEntry({ id: 'openai/small', provider: 'openai' }))
      registry.register(makeEntry({ id: 'voyage/v3', provider: 'voyage' }))
      registry.register(makeEntry({ id: 'openai/large', provider: 'openai' }))

      const def = registry.getDefault('voyage')
      expect(def!.id).toBe('voyage/v3')
    })

    it('returns undefined when no models registered', () => {
      expect(registry.getDefault()).toBeUndefined()
    })

    it('returns undefined for non-existent provider', () => {
      registry.register(makeEntry({ id: 'a/1', provider: 'openai' }))
      expect(registry.getDefault('nonexistent')).toBeUndefined()
    })
  })

  describe('has', () => {
    it('returns true for registered model', () => {
      registry.register(makeEntry({ id: 'exists' }))
      expect(registry.has('exists')).toBe(true)
    })

    it('returns false for non-existent model', () => {
      expect(registry.has('nope')).toBe(false)
    })
  })

  describe('remove', () => {
    it('removes a registered model', () => {
      registry.register(makeEntry({ id: 'removable' }))
      expect(registry.remove('removable')).toBe(true)
      expect(registry.get('removable')).toBeUndefined()
    })

    it('returns false when removing non-existent model', () => {
      expect(registry.remove('nope')).toBe(false)
    })
  })
})

describe('COMMON_EMBEDDING_MODELS', () => {
  it('has at least 3 pre-configured models', () => {
    expect(COMMON_EMBEDDING_MODELS.length).toBeGreaterThanOrEqual(3)
  })

  it('includes OpenAI models', () => {
    const openai = COMMON_EMBEDDING_MODELS.filter((m) => m.provider === 'openai')
    expect(openai.length).toBeGreaterThanOrEqual(1)
  })

  it('each model has required fields', () => {
    for (const model of COMMON_EMBEDDING_MODELS) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBeTruthy()
      expect(model.model).toBeTruthy()
      expect(model.dimensions).toBeGreaterThan(0)
      expect(model.maxBatchSize).toBeGreaterThan(0)
      expect(model.costPer1kTokens).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('createDefaultEmbeddingRegistry', () => {
  it('returns a registry pre-loaded with common models', () => {
    const reg = createDefaultEmbeddingRegistry()
    expect(reg.list().length).toBe(COMMON_EMBEDDING_MODELS.length)
  })

  it('contains all common model IDs', () => {
    const reg = createDefaultEmbeddingRegistry()
    for (const model of COMMON_EMBEDDING_MODELS) {
      expect(reg.has(model.id)).toBe(true)
    }
  })
})
