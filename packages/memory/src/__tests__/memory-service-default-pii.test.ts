/**
 * DZM-P2b — PII redaction is on by default.
 *
 * Before this, `piiRedactionEnabled` defaulted to true but did nothing unless
 * a `detectPII` was injected, so stored `text` kept raw emails and card
 * numbers for every caller that did not wire one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import type { NamespaceConfig } from '../memory-types.js'

const nsConfigs: NamespaceConfig[] = [
  { name: 'observations', scopeKeys: ['tenantId'], searchable: false },
]
const scope = { tenantId: 't1' }

function makeStore(): { store: BaseStore; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(async () => {})
  const store = {
    put,
    get: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
  } as unknown as BaseStore
  return { store, put }
}

function storedValue(put: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return put.mock.calls[0]?.[2] as Record<string, unknown>
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
    const text = storedValue(put)['text'] as string
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
    expect(storedValue(put)['text']).toBe('the build uses yarn 4')
  })

  it('keeps raw text when piiRedactionEnabled is false', async () => {
    const { store, put } = makeStore()
    const svc = new MemoryService(store, nsConfigs, { piiRedactionEnabled: false })
    const result = await svc.put('observations', scope, 'k', { text: 'mail jane.doe@example.com' })
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    expect(storedValue(put)['text']).toBe('mail jane.doe@example.com')
  })

  it('gives an injected detector priority over the default', async () => {
    const { store, put } = makeStore()
    const detectPII = vi.fn((text: string) => ({ hasPII: false, redacted: text }))
    const svc = new MemoryService(store, nsConfigs, { detectPII })
    const result = await svc.put('observations', scope, 'k', { text: 'mail jane.doe@example.com' })
    expect(detectPII).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    expect(storedValue(put)['text']).toBe('mail jane.doe@example.com')
  })

  it('does not graft a text field onto a structured value', async () => {
    const { store, put } = makeStore()
    const svc = new MemoryService(store, nsConfigs)
    const value = { kind: 'run', createdAt: 1696687200000, owner: 'ops@example.com' }
    const result = await svc.put('observations', scope, 'k', value)
    expect(result).toEqual({ status: 'written', piiRedacted: false })
    const stored = storedValue(put)
    expect(stored).toMatchObject(value)
    expect(stored).not.toHaveProperty('text')
  })
})
