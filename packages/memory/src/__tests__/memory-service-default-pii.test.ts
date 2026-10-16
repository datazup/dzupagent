/**
 * DZM-P2b — PII redaction is on by default.
 *
 * Before this, `piiRedactionEnabled` defaulted to true but did nothing unless
 * a `detectPII` was injected, so stored `text` kept raw emails and card
 * numbers for every caller that did not wire one.
 */
import { describe, it, expect, vi } from 'vitest'
import { InMemoryStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import type { NamespaceConfig } from '../memory-types.js'

const nsConfigs: NamespaceConfig[] = [
  { name: 'observations', scopeKeys: ['tenantId'], searchable: false },
]
const scope = { tenantId: 't1' }

function makeStore() {
  const store = new InMemoryStore()
  const put = vi.spyOn(store, 'put')
  return { store, put }
}

async function storedValue(store: InMemoryStore, put: ReturnType<typeof makeStore>['put']): Promise<Record<string, unknown>> {
  const namespace = put.mock.calls[0]![0]
  const item = await store.get(namespace, 'k')
  expect(item).toBeDefined()
  if (!item) throw new Error('Expected a persisted record')
  return item.value
}

describe('MemoryService default PII redaction (DZM-P2b)', () => {
  it('redacts an email and a card number in text without an injected detector', async () => {
    const { store, put } = makeStore()
    const emit = vi.fn()
    const svc = new MemoryService(store, nsConfigs, { eventBus: { emit } })
    const result = await svc.put('observations', scope, 'k', {
      text: 'customer jane.doe@example.com paid with 4111 1111 1111 1111',
    })
    expect(result).toEqual({ status: 'written', piiRedacted: true })
    const text = (await storedValue(store, put))['text'] as string
    expect(text).not.toContain('jane.doe@example.com')
    expect(text).not.toContain('4111 1111 1111 1111')
    expect(text).toContain('[REDACTED-EMAIL]')
    expect(text).toContain('[REDACTED-CC]')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory:pii_redacted' }))
  })

  it('stores PII-free text unchanged', async () => {
    const { store, put } = makeStore()
    const svc = new MemoryService(store, nsConfigs)
    const result = await svc.put('observations', scope, 'k', { text: 'the build uses yarn 4' })
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    expect((await storedValue(store, put))['text']).toBe('the build uses yarn 4')
  })

  it('keeps raw text when piiRedactionEnabled is false', async () => {
    const { store, put } = makeStore()
    const svc = new MemoryService(store, nsConfigs, { piiRedactionEnabled: false })
    const result = await svc.put('observations', scope, 'k', { text: 'mail jane.doe@example.com' })
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    expect((await storedValue(store, put))['text']).toBe('mail jane.doe@example.com')
  })

  it('gives an injected detector priority over the default', async () => {
    const { store, put } = makeStore()
    const detectPII = vi.fn((text: string) => ({ hasPII: false, redacted: text }))
    const svc = new MemoryService(store, nsConfigs, { detectPII })
    const result = await svc.put('observations', scope, 'k', { text: 'mail jane.doe@example.com' })
    expect(detectPII).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    expect((await storedValue(store, put))['text']).toBe('mail jane.doe@example.com')
  })

  it('does not graft a text field onto a structured value', async () => {
    const { store, put } = makeStore()
    const svc = new MemoryService(store, nsConfigs)
    const value = { kind: 'run', createdAt: 1696687200000, owner: 'ops@example.com' }
    const result = await svc.put('observations', scope, 'k', value)
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    const stored = await storedValue(store, put)
    expect(stored).toMatchObject(value)
    expect(stored).not.toHaveProperty('text')
  })

  it('redacts nested leaves and the indexed text of a structured value in a searchable namespace (AGENT-M-51)', async () => {
    const { store, put } = makeStore()
    const upsert = vi.fn(async () => {})
    const semanticStore = { ensureCollection: vi.fn(async () => {}), upsert }
    const svc = new MemoryService(
      store,
      [{ name: 'facts', scopeKeys: ['tenantId'], searchable: true }],
      { semanticStore: semanticStore as never },
    )
    const digest = 'a1b2c3d4'.repeat(8)
    const runId = '550e8400-e29b-41d4-a716-446655440000'
    const result = await svc.put('facts', scope, 'k', {
      contact: { email: 'jane.doe@example.com' },
      notes: ['call jane.doe@example.com'],
      createdAt: 1696687200000,
      runId,
      evidence: [{ contentDigest: digest, ref: `message:${runId}`, label: `sha256:${digest}` }],
    })
    expect(result).toEqual({ status: 'written', piiRedacted: true })
    const stored = await storedValue(store, put)
    expect(JSON.stringify(stored)).not.toContain('jane.doe@example.com')
    // numbers, ids, digests and references are never rewritten
    expect(stored).toMatchObject({
      createdAt: 1696687200000,
      runId,
      evidence: [{ contentDigest: digest, ref: `message:${runId}`, label: `sha256:${digest}` }],
    })
    expect(stored['text']).toEqual(expect.stringContaining('[REDACTED-EMAIL]'))
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    const indexed = JSON.stringify(upsert.mock.calls[0])
    expect(indexed).not.toContain('jane.doe@example.com')
    expect(indexed).toContain('[REDACTED-EMAIL]')
  })

  it('refuses the write and emits memory:pii_redaction_failed when the detector throws (ERR-H-50)', async () => {
    const { store, put } = makeStore()
    const emit = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detectPII = vi.fn(() => {
      throw new TypeError('scanner crashed on jane.doe@example.com')
    })
    const svc = new MemoryService(store, nsConfigs, { detectPII, eventBus: { emit } })
    const result = await svc.put('observations', scope, 'k', { text: 'mail jane.doe@example.com' })
    errorSpy.mockRestore()

    expect(result).toEqual({ status: 'rejected', reason: 'pii_detection_failed', threats: [] })
    expect(put).not.toHaveBeenCalled()
    expect(await store.search(['observations'])).toEqual([])
    expect(emit).toHaveBeenCalledWith({
      type: 'memory:pii_redaction_failed',
      namespace: 'observations',
      key: 'k',
      errorClass: 'TypeError',
      agentId: 'unknown',
    })
    // the event never carries the raw message (it may echo the scanned text)
    expect(JSON.stringify(emit.mock.calls)).not.toContain('jane.doe@example.com')
  })
})
