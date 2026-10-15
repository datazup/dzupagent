import { test, expect, vi } from 'vitest'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import { HumanMessage } from '@langchain/core/messages'
import { ObservationalMemory } from '../observational-memory.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

test('observation fallbacks isolate failed storage reads and preserve host extraction configuration', async () => {
  const store = await createStore({ type: 'memory' })
  const service = new MemoryService(store, [{ name: 'observations', scopeKeys: ['tenantId'], searchable: false }])
  const invoke = vi.fn(async () => ({ content: '[]' }))
  const memory = new ObservationalMemory({ model: { invoke } as unknown as BaseChatModel, memoryService: service, store, namespace: 'observations', scope: { tenantId: 'tenant' }, observerThreshold: 1, observationPrompt: 'fixture', observationPromptVersion: 'v1', observationRunId: 'run', observationMessageReferenceResolver: () => 'message', observationEvidenceExcerptMaxChars: 10 })
  expect(await memory.confirmObservation('missing')).toBe(false)
  expect(await memory.rejectObservation('missing')).toBe(false)
  expect(await memory.listPendingObservationCandidates()).toEqual([])
  expect(await memory.flushConfirmedObservations()).toEqual([])
  expect(await memory.observe([new HumanMessage('fixture')])).toMatchObject({ extracted: [], persisted: [] })
  expect(invoke).toHaveBeenCalledOnce()
  vi.spyOn(service, 'get').mockRejectedValue(new Error('storage unavailable'))
  vi.spyOn(service, 'search').mockRejectedValue(new Error('storage unavailable'))
  expect(await memory.getObservations()).toEqual([])
  expect(await memory.getRelevantObservations('fixture')).toBe('')
  memory.reset()
  expect(memory.getStats()).toMatchObject({ observerRuns: 0, totalObservations: 0 })
  vi.restoreAllMocks()
})

test('manual reflection of an empty observation namespace does not invoke a model', async () => {
  const store = await createStore({ type: 'memory' })
  const service = new MemoryService(store, [{ name: 'observations', scopeKeys: ['tenantId'], searchable: false }])
  const invoke = vi.fn(() => { throw new Error('unexpected model invocation') })
  const memory = new ObservationalMemory({ model: { invoke } as unknown as BaseChatModel, memoryService: service, store, namespace: 'observations', scope: { tenantId: 'tenant' } })
  await expect(memory.forceReflect()).resolves.toMatchObject({ merged: 0 })
  expect(invoke).not.toHaveBeenCalled()
})
