import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import * as facade from '../provider-catalog.js'
import { PROVIDER_CATALOG as catalogData } from '../provider-catalog/catalog.js'
import { assertProviderCatalogEntry as internalAssert } from '../provider-catalog/runtime-validation.js'
import * as selectors from '../provider-catalog/selectors.js'

const CATALOG_SOURCE_URLS = [
  new URL('../provider-catalog.ts', import.meta.url),
  new URL('../provider-catalog/catalog.ts', import.meta.url),
  new URL('../provider-catalog/runtime-validation.ts', import.meta.url),
  new URL('../provider-catalog/selectors.ts', import.meta.url),
]

function sourceLineCount(url: URL): number {
  const source = readFileSync(url, 'utf8').replace(/\n$/, '')
  return source === '' ? 0 : source.split('\n').length
}

describe('provider catalog compatibility architecture', () => {
  it('re-exports the internal catalog, validator, and selectors by reference', () => {
    expect(facade.PROVIDER_CATALOG).toBe(catalogData)
    expect(facade.assertProviderCatalogEntry).toBe(internalAssert)
    expect(facade.HTTP_ROUTABLE_PROVIDER_IDS).toBe(selectors.HTTP_ROUTABLE_PROVIDER_IDS)
    expect(facade.getDefaultMonitorStatus).toBe(selectors.getDefaultMonitorStatus)
    expect(facade.getMonitorableProviders).toBe(selectors.getMonitorableProviders)
    expect(facade.getProductProviders).toBe(selectors.getProductProviders)
    expect(facade.getProviderCapabilities).toBe(selectors.getProviderCapabilities)
    expect(Object.keys(facade).sort()).toEqual([
      'HTTP_ROUTABLE_PROVIDER_IDS',
      'PROVIDER_CATALOG',
      'assertProviderCatalogEntry',
      'getDefaultMonitorStatus',
      'getMonitorableProviders',
      'getProductProviders',
      'getProviderCapabilities',
    ])
  })

  it('keeps every catalog module within the governed package file-size budget', () => {
    const budgetConfig = JSON.parse(
      readFileSync(new URL('../../../../config/barrel-budgets.json', import.meta.url), 'utf8'),
    ) as { packages: Record<string, { maxFileLines?: number }> }
    const maxFileLines = budgetConfig.packages['@dzupagent/agent-adapters']?.maxFileLines

    expect(maxFileLines).toBe(500)
    for (const sourceUrl of CATALOG_SOURCE_URLS) {
      expect(sourceLineCount(sourceUrl), sourceUrl.pathname).toBeLessThanOrEqual(maxFileLines ?? 0)
    }
  })
})
