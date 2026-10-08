import { describe, expect, it } from 'vitest'

import type { AdapterProviderId } from '../types.js'
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from '../provider-catalog/catalog.js'
import {
  ProviderNotRunnableError,
  assertProviderCatalogEntry,
  assertProviderRunnable,
} from '../provider-catalog/runtime-validation.js'
import {
  getProductProviders,
  getRunnableProviders,
  selectProviderForExecution,
} from '../provider-catalog/selectors.js'

// UD-MVP-12 / D17: only adapters with a citable qualification receipt are runnable.
const QUALIFIED: Partial<Record<AdapterProviderId, string>> = {
  codex: 'AAI-B002b1d',
  claude: 'AAI-B002b2/E001c2b3',
}

describe('provider catalog runnability (UD-MVP-12)', () => {
  it('marks only receipt-backed providers runnable', () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG) as Array<
      [AdapterProviderId, ProviderCatalogEntry]
    >) {
      const receipt = QUALIFIED[id]
      expect(entry.runnable, id).toBe(receipt !== undefined)
      expect(entry.qualificationReceiptId, id).toBe(receipt ?? null)
    }
    expect(getRunnableProviders().sort()).toEqual(['claude', 'codex'])
  })

  it.each(['qwen', 'crush', 'goose'] as const)('keeps %s non-runnable', (id) => {
    expect(PROVIDER_CATALOG[id].runnable).toBe(false)
    expect(PROVIDER_CATALOG[id].qualificationReceiptId).toBeNull()
  })

  it('leaves productIntegrated untouched', () => {
    expect(getProductProviders()).toEqual(['claude', 'codex', 'gemini', 'qwen', 'crush', 'openrouter', 'openai'])
  })

  it.each(['qwen', 'crush', 'goose'] as const)(
    'refuses %s for product execution with a typed error naming adapter and receipt',
    (id) => {
      let caught: unknown
      try {
        selectProviderForExecution(id)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ProviderNotRunnableError)
      const error = caught as ProviderNotRunnableError
      expect(error.code).toBe('PROVIDER_NOT_RUNNABLE')
      expect(error.providerId).toBe(id)
      expect(error.message).toContain(id)
      expect(error.message).toContain('qualification receipt')
      expect(() => assertProviderRunnable(id)).toThrow(ProviderNotRunnableError)
    },
  )

  it('refuses an unknown provider for execution', () => {
    expect(() => selectProviderForExecution('not-a-provider')).toThrow(ProviderNotRunnableError)
  })

  it('selects qualified providers for execution', () => {
    expect(selectProviderForExecution('codex')).toBe(PROVIDER_CATALOG.codex)
    expect(selectProviderForExecution('claude')).toBe(PROVIDER_CATALOG.claude)
  })

  it('flips to runnable once a qualification receipt id is present', () => {
    const catalog = {
      ...PROVIDER_CATALOG,
      qwen: { ...PROVIDER_CATALOG.qwen, runnable: true, qualificationReceiptId: 'QWEN-QUAL-1' },
    }
    expect(selectProviderForExecution('qwen', catalog)).toBe(catalog.qwen)
    expect(() => selectProviderForExecution('crush', catalog)).toThrow(ProviderNotRunnableError)
  })

  it('rejects runnable entries without a receipt and receipts on non-runnable entries', () => {
    const noReceipt = { ...structuredClone(PROVIDER_CATALOG.qwen), runnable: true }
    expect(() => assertProviderCatalogEntry(noReceipt, 'qwen')).toThrow(/qualificationReceiptId/)
    expect(() => assertProviderRunnable('qwen', noReceipt as ProviderCatalogEntry)).toThrow(
      ProviderNotRunnableError,
    )

    const strayReceipt = { ...structuredClone(PROVIDER_CATALOG.qwen), qualificationReceiptId: 'X' }
    expect(() => assertProviderCatalogEntry(strayReceipt, 'qwen')).toThrow(/qualificationReceiptId/)

    const missing: Record<string, unknown> = structuredClone(PROVIDER_CATALOG.claude)
    delete missing.runnable
    expect(() => assertProviderCatalogEntry(missing, 'claude')).toThrow(/runnable/)
  })
})
