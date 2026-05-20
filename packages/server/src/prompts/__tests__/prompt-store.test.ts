import { describe, expect, it } from 'vitest'
import { InMemoryPromptStore } from '../prompt-store.js'

describe('InMemoryPromptStore.save invariants', () => {
  it('throws when id is empty', async () => {
    const store = new InMemoryPromptStore()
    await expect(
      store.save({ id: '', promptId: 'p1', name: 'N', type: 'system', content: 'c', version: 1, status: 'draft' }),
    ).rejects.toThrow('prompt.id must be a non-empty string')
  })

  it('throws when promptId is empty', async () => {
    const store = new InMemoryPromptStore()
    await expect(
      store.save({ id: 'v1', promptId: '', name: 'N', type: 'system', content: 'c', version: 1, status: 'draft' }),
    ).rejects.toThrow('prompt.promptId must be a non-empty string')
  })

  it('throws when promptId is whitespace-only', async () => {
    const store = new InMemoryPromptStore()
    await expect(
      store.save({ id: 'v1', promptId: '   ', name: 'N', type: 'system', content: 'c', version: 1, status: 'draft' }),
    ).rejects.toThrow('prompt.promptId must be a non-empty string')
  })
})

describe('InMemoryPromptStore.rollback invariants', () => {
  it('throws when promptId is empty', async () => {
    const store = new InMemoryPromptStore()
    await expect(store.rollback('', 'v1')).rejects.toThrow('promptId must be a non-empty string')
  })

  it('throws when targetId is empty', async () => {
    const store = new InMemoryPromptStore()
    await expect(store.rollback('prompt-a', '')).rejects.toThrow('targetId must be a non-empty string')
  })

  it('throws when targetId is whitespace-only', async () => {
    const store = new InMemoryPromptStore()
    await expect(store.rollback('prompt-a', '   ')).rejects.toThrow('targetId must be a non-empty string')
  })
})

describe('InMemoryPromptStore.rollback', () => {
  it('returns null when targetId does not belong to the provided promptId', async () => {
    const store = new InMemoryPromptStore()

    await store.save({
      id: 'v1',
      promptId: 'prompt-a',
      name: 'Prompt A',
      type: 'system',
      content: 'A',
      version: 1,
      status: 'published',
      tenantId: 'tenant-a',
    })

    const result = await store.rollback('prompt-b', 'v1', 'tenant-a')
    expect(result).toBeNull()

    const unchanged = await store.get('v1', 'tenant-a')
    expect(unchanged?.status).toBe('published')
  })

  it('publishes the target version when promptId matches', async () => {
    const store = new InMemoryPromptStore()

    await store.save({
      id: 'v1',
      promptId: 'prompt-a',
      name: 'Prompt A',
      type: 'system',
      content: 'v1',
      version: 1,
      status: 'archived',
      tenantId: 'tenant-a',
    })
    await store.save({
      id: 'v2',
      promptId: 'prompt-a',
      name: 'Prompt A',
      type: 'system',
      content: 'v2',
      version: 2,
      status: 'published',
      tenantId: 'tenant-a',
    })

    const result = await store.rollback('prompt-a', 'v1', 'tenant-a')
    expect(result?.id).toBe('v1')
    expect(result?.status).toBe('published')

    const previous = await store.get('v2', 'tenant-a')
    expect(previous?.status).toBe('archived')
  })
})
