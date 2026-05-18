import { describe, expect, it } from 'vitest'
import { InMemoryPromptStore } from '../prompt-store.js'

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
