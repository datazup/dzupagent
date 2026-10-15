/**
 * Pins the shared memory-spec store double to LangGraph `InMemoryStore`
 * semantics (DZUPAGENT-TEST-H-09). The doubles it replaced ignored the
 * namespace and returned every record when no limit was passed; each case
 * below runs the double and a fresh `InMemoryStore` through the same calls and
 * requires identical results, so a hand-written replacement that drifts on
 * namespace isolation or the default limit fails here first.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@langchain/langgraph'
import type { BaseStore } from '@langchain/langgraph'
import { createStoreDouble } from './helpers/store-double.js'

type Scenario = (store: BaseStore) => Promise<unknown>

function shape(items: Array<{ namespace: string[]; key: string; value: unknown }>) {
  return items.map(item => ({ namespace: item.namespace, key: item.key, value: item.value }))
}

async function seedTwoTenants(store: BaseStore): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await store.put(['lessons', 't1'], `t1-${String(i).padStart(2, '0')}`, { text: `t1 lesson ${i}` })
  }
  for (let i = 0; i < 3; i++) {
    await store.put(['lessons', 't2'], `t2-${i}`, { text: `t2 lesson ${i}` })
  }
  await store.put(['decisions', 't1'], 'd-1', { text: 'a decision' })
}

async function expectParity(scenario: Scenario): Promise<unknown> {
  const reference = await scenario(new InMemoryStore())
  const double = await scenario(createStoreDouble().store)
  expect(double).toEqual(reference)
  return double
}

describe('shared store double parity with InMemoryStore', () => {
  it('isolates namespaces: a search never returns another tenant\'s records', async () => {
    const result = await expectParity(async store => {
      await seedTwoTenants(store)
      return shape(await store.search(['lessons', 't2']))
    }) as Array<{ namespace: string[] }>
    expect(result).toHaveLength(3)
    expect(result.filter(item => item.namespace.join('/') === 'lessons/t2')).toHaveLength(3)
  })

  it('applies the default limit of 10 when the caller passes none', async () => {
    const result = await expectParity(async store => {
      await seedTwoTenants(store)
      return shape(await store.search(['lessons', 't1']))
    }) as unknown[]
    expect(result).toHaveLength(10)
  })

  it('pages with explicit limit and offset', async () => {
    const result = await expectParity(async store => {
      await seedTwoTenants(store)
      const first = await store.search(['lessons', 't1'], { limit: 10, offset: 0 })
      const second = await store.search(['lessons', 't1'], { limit: 10, offset: 10 })
      return [shape(first), shape(second)]
    }) as unknown[][]
    expect(result[0]).toHaveLength(10)
    expect(result[1]).toHaveLength(5)
  })

  it('matches a namespace prefix across nested namespaces', async () => {
    const result = await expectParity(async store => {
      await seedTwoTenants(store)
      return shape(await store.search(['lessons'], { limit: 100 }))
    }) as unknown[]
    expect(result).toHaveLength(18)
  })

  it('searching a namespace with no records returns nothing, not every record', async () => {
    const result = await expectParity(async store => {
      await seedTwoTenants(store)
      return shape(await store.search(['t1']))
    }) as unknown[]
    expect(result).toEqual([])
  })

  it('get and delete are scoped to the exact namespace', async () => {
    await expectParity(async store => {
      await seedTwoTenants(store)
      const wrongNamespace = await store.get(['lessons', 't2'], 't1-00')
      const rightNamespace = await store.get(['lessons', 't1'], 't1-00')
      await store.delete(['lessons', 't2'], 't1-00')
      const survivesWrongDelete = await store.get(['lessons', 't1'], 't1-00')
      await store.delete(['lessons', 't1'], 't1-00')
      const afterDelete = await store.get(['lessons', 't1'], 't1-00')
      return {
        wrongNamespace,
        rightNamespace: rightNamespace?.value,
        survivesWrongDelete: survivesWrongDelete?.value,
        afterDelete,
      }
    })
  })

  it('seed and records bypass the spies and see every namespace', async () => {
    const double = createStoreDouble()
    await double.seed(['a', 't1'], 'k1', { text: 'one' })
    await double.seed(['b', 't1'], 'k2', { text: 'two' })
    expect(double.put).not.toHaveBeenCalled()
    expect(await double.records()).toHaveLength(2)
    expect(await double.records(['a'])).toEqual([{ namespace: ['a', 't1'], key: 'k1', value: { text: 'one' } }])
    expect(double.search).not.toHaveBeenCalled()
  })

  it('seed can backdate createdAt, and the stamp survives a later put', async () => {
    const double = createStoreDouble()
    const createdAt = new Date(Date.UTC(2020, 0, 1))
    await double.seed(['a'], 'k', { text: 'old' }, { createdAt })
    await double.update('k', { text: 'edited' })
    const [item] = await double.store.search(['a'])
    expect(item?.createdAt).toEqual(createdAt)
    expect(item?.value).toEqual({ text: 'edited' })
  })
})
