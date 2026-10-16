import { test, expect } from 'vitest'
import { createStore } from '../../store-factory.js'
import { PersistentEntityGraph } from '../../retrieval/persistent-graph.js'
import { RelationshipStore } from '../../retrieval/relationship-store.js'

test('relationship recovery ignores malformed persisted edges, cycles, tombstones and missing target records', async () => {
  const store = await createStore({ type: 'memory' })
  const graph = new RelationshipStore(store, ['notes'])
  await graph.addEdge({ fromKey: 'one', toKey: 'two', type: 'causes', createdAt: 1 })
  await graph.addEdge({ fromKey: 'two', toKey: 'one', type: 'causes', createdAt: 2 })
  await graph.addEdge({ fromKey: 'one', toKey: 'three', type: 'blocks', createdAt: 3, metadata: { confidence: 1 } })
  for (const [index, change] of [{ fromKey: 1 }, { toKey: false }, { type: null }, { createdAt: 'yesterday' }].entries()) await store.put(['notes', '__edges'], `bad-${index}`, { fromKey: 'one', toKey: 'two', type: 'causes', createdAt: 1, _direction: 'outgoing', ...change })
  await store.put(['notes', '__edges'], 'tombstone', { fromKey: 'one', _direction: 'outgoing', _tombstone: true })
  await store.put(['notes', '__edges'], 'bad-metadata', { fromKey: 'one', toKey: 'four', type: 'causes', createdAt: 1, metadata: [], _direction: 'outgoing' })
  expect((await graph.traverse('one', ['causes'], 3)).map(item => item.key)).toEqual(['two', 'four'])
  expect(await graph.traverse('one', ['causes'], -1)).toEqual([])
  expect((await graph.traverse('one', ['causes'], 3, 1)).map(item => item.key)).toEqual(['two'])
  expect(await graph.findCausalChain('one', 'missing', 1)).toBeNull()
  expect((await graph.findCausalChain('one', 'two'))?.map(edge => edge.toKey)).toEqual(['two'])
  const retainedEdges = await graph.getAllEdges()
  expect(retainedEdges).toHaveLength(4)
  expect(retainedEdges.filter(edge => typeof edge.createdAt === 'number')).toHaveLength(4)
  expect((await graph.buildAdjacency(['blocks'])).get('one')).toEqual(['three'])
  await graph.removeAllEdges('one')
  // Recovery exposes valid edge payloads but cannot infer the physical key of
  // a corrupt index entry. Remove that deliberately noncanonical fixture.
  await store.delete(['notes', '__edges'], 'bad-metadata')
  expect(await graph.getEdges('one')).toEqual([])
})

test('entity traversal tolerates corrupt or dangling indexes without inventing memory records', async () => {
  const store = await createStore({ type: 'memory' })
  const graph = new PersistentEntityGraph(store, ['notes'])
  const entities = ['notes', '__entities']
  const reverse = ['notes', '__record_entities']
  await store.put(entities, 'alpha', { memoryKeys: ['missing', 'one'] })
  await store.put(['notes'], 'one', { content: 'AlphaBeta uses `alpha`' })
  await store.put(reverse, 'one', { entities: ['alpha', 'dangling', 'malformed'] })
  await store.put(entities, 'malformed', { memoryKeys: 'invalid' })
  expect((await graph.search('`alpha`', 3, 10)).map(item => item.key)).toEqual(['one'])
  expect(await graph.getRelatedEntities('alpha')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dangling' })]))
  expect(await graph.getRelatedEntities('malformed')).toEqual([])
  expect(await graph.getEntities()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'malformed', degree: 0 })]))
  await store.put(reverse, 'one', { entities: 'invalid' })
  expect((await graph.search('`alpha`', 3, 10)).map(item => item.key)).toEqual(['one'])
  await graph.removeRecord('one')
  await store.put(reverse, 'one', { entities: ['malformed', 'dangling'] })
  await graph.removeRecord('one')
  await store.put(['notes'], 'two', { arbitrary: '`beta`' })
  expect((await graph.reindexAll()).recordsProcessed).toBe(2)
  const broken = new PersistentEntityGraph({ ...store, search: async () => { throw new Error('backend unavailable') } } as unknown as typeof store, ['notes'])
  expect(await broken.reindexAll()).toEqual({ entitiesIndexed: 0, recordsProcessed: 0 })
})
