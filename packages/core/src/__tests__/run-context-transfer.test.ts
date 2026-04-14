/**
 * Tests for RunContextTransfer — persistent cross-intent context sharing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RunContextTransfer, INTENT_CONTEXT_CHAINS } from '../context/run-context-transfer.js'
import type { PersistedIntentContext } from '../context/run-context-transfer.js'
import { InMemoryStore } from '@langchain/langgraph'

function makeContext(intent: string, overrides?: Partial<PersistedIntentContext>): PersistedIntentContext {
  return {
    fromIntent: intent,
    summary: `Summary for ${intent}`,
    decisions: ['use JWT', 'PostgreSQL'],
    relevantFiles: ['src/auth/login.ts'],
    workingState: { featureName: 'auth' },
    transferredAt: Date.now(),
    tokenEstimate: 150,
    ...overrides,
  }
}

describe('RunContextTransfer', () => {
  let store: InstanceType<typeof InMemoryStore>
  let transfer: RunContextTransfer

  beforeEach(() => {
    store = new InMemoryStore()
    transfer = new RunContextTransfer({ store })
  })

  it('saves and loads context for a session + intent', async () => {
    const ctx = makeContext('generate_feature')
    await transfer.save('session-1', ctx)

    const loaded = await transfer.load('session-1', 'generate_feature')
    expect(loaded).not.toBeNull()
    expect(loaded!.fromIntent).toBe('generate_feature')
    expect(loaded!.decisions).toEqual(['use JWT', 'PostgreSQL'])
  })

  it('returns null for missing context', async () => {
    const loaded = await transfer.load('session-1', 'generate_feature')
    expect(loaded).toBeNull()
  })

  it('returns null for stale context', async () => {
    const staleTransfer = new RunContextTransfer({ store, maxAgeMs: 1 })
    const ctx = makeContext('generate_feature', { transferredAt: Date.now() - 100 })
    await staleTransfer.save('session-1', ctx)

    const loaded = await staleTransfer.load('session-1', 'generate_feature')
    expect(loaded).toBeNull()
  })

  it('loadForIntent follows the context chain', async () => {
    await transfer.save('session-1', makeContext('generate_feature'))

    // edit_feature should find generate_feature via chain
    const loaded = await transfer.loadForIntent('session-1', 'edit_feature')
    expect(loaded).not.toBeNull()
    expect(loaded!.fromIntent).toBe('generate_feature')
  })

  it('loadForIntent returns null when chain has no matches', async () => {
    await transfer.save('session-1', makeContext('configure'))

    // edit_feature chain is [generate_feature, create_feature] — configure not in it
    const loaded = await transfer.loadForIntent('session-1', 'edit_feature')
    expect(loaded).toBeNull()
  })

  it('loadForIntent returns null for unknown intents', async () => {
    const loaded = await transfer.loadForIntent('session-1', 'unknown_intent')
    expect(loaded).toBeNull()
  })

  it('listContexts returns all saved contexts for a session', async () => {
    await transfer.save('session-1', makeContext('generate_feature'))
    await transfer.save('session-1', makeContext('configure'))

    const contexts = await transfer.listContexts('session-1')
    expect(contexts.length).toBe(2)
    const intents = contexts.map(c => c.fromIntent).sort()
    expect(intents).toEqual(['configure', 'generate_feature'])
  })

  it('clear removes all contexts for a session', async () => {
    await transfer.save('session-1', makeContext('generate_feature'))
    await transfer.save('session-1', makeContext('configure'))

    await transfer.clear('session-1')

    const contexts = await transfer.listContexts('session-1')
    expect(contexts.length).toBe(0)
  })

  it('paginates through more than 100 contexts for load/list/clear', async () => {
    const totalContexts = 120

    for (let i = 0; i < totalContexts; i++) {
      await transfer.save('session-1', makeContext(`intent-${i}`))
    }

    const loaded = await transfer.load('session-1', 'intent-119')
    expect(loaded).not.toBeNull()
    expect(loaded!.fromIntent).toBe('intent-119')

    const contexts = await transfer.listContexts('session-1')
    expect(contexts).toHaveLength(totalContexts)
    expect(contexts.map((context) => context.fromIntent)).toContain('intent-119')

    await transfer.clear('session-1')
    expect(await transfer.listContexts('session-1')).toHaveLength(0)
  })

  it('sessions are isolated', async () => {
    await transfer.save('session-1', makeContext('generate_feature'))
    await transfer.save('session-2', makeContext('configure'))

    const s1 = await transfer.load('session-1', 'generate_feature')
    const s2 = await transfer.load('session-2', 'generate_feature')

    expect(s1).not.toBeNull()
    expect(s2).toBeNull()
  })

  it('INTENT_CONTEXT_CHAINS has expected entries', () => {
    expect(INTENT_CONTEXT_CHAINS['edit_feature']).toContain('generate_feature')
    expect(INTENT_CONTEXT_CHAINS['configure']).toContain('edit_feature')
    expect(INTENT_CONTEXT_CHAINS['create_template']).toContain('generate_feature')
  })
})
