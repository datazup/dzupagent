import { describe, expect, it } from 'vitest'

import { createPersonaStoreResolver } from '../personas/persona-resolver.js'
import { InMemoryPersonaStore } from '../personas/persona-store.js'

describe('createPersonaStoreResolver', () => {
  it('resolves a known persona id and refreshes the suggestion cache', async () => {
    const store = new InMemoryPersonaStore()
    await store.save({
      id: 'pm.lead',
      name: 'PM Lead',
      instructions: 'Own the product plan.',
    })

    const resolver = createPersonaStoreResolver(store)

    await expect(resolver.resolve('pm.lead')).resolves.toBe(true)
    expect(resolver.list()).toEqual(['pm.lead'])
  })

  it('returns false for an unknown persona and still exposes cached ids for suggestions', async () => {
    const store = new InMemoryPersonaStore()
    await store.save({
      id: 'designer',
      name: 'Designer',
      instructions: 'Own the design direction.',
    })
    await store.save({
      id: 'developer',
      name: 'Developer',
      instructions: 'Implement the plan.',
    })

    const resolver = createPersonaStoreResolver(store)

    await expect(resolver.resolve('designr')).resolves.toBe(false)
    expect(resolver.list().sort()).toEqual(['designer', 'developer'])
  })
})
