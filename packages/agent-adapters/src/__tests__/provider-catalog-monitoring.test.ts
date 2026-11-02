import { describe, expect, it } from 'vitest'

import {
  PROVIDER_CATALOG,
  assertProviderCatalogEntry,
  getProviderCapabilities,
  type ProviderCatalogEntry,
} from '../provider-catalog.js'

const EXPECTED_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'goose',
  'crush',
  'gemini-sdk',
  'openrouter',
  'openai',
  'ollama',
] as const

describe('monitoring provider catalog contract (WP-M1.2)', () => {
  it.each(['pi', 'opencode', 'cline'] as const)('keeps reserved %s SDK support unqualified', (id) => {
    const entry = PROVIDER_CATALOG[id]
    expect(() => assertProviderCatalogEntry(entry, id)).not.toThrow()
    expect(entry.coordinates).toEqual({ providerId: id, backend: 'sdk' })
    expect(entry.monitorTier).toBe('none')
    expect(entry.monitorIntrospection).toBe('none')
    expect(entry.eventFidelity).toEqual({ raw: false, normalized: false, artifact: false, governance: false, usage: 'none' })
    expect(entry.capabilityProfile).toEqual({
      supportsResume: false, supportsFork: false, supportsToolCalls: false,
      emitsToolCalls: false, executesToolLoop: false, supportsStreaming: false, supportsCostUsage: false,
      supportsZeroToolDispatch: false,
      nativeToolControls: { mode: false, allowlist: false, blocklist: false },
      providerRequestCorrelation: {
        idempotencyKey: { accepted: false, enforcement: 'none' },
        restartLookup: { supported: false, lookupBy: [] },
      },
    })
    for (const field of ['runtimeExecution', 'productIntegrated', 'httpAdapterRouting', 'supportsReplay', 'supportsPolicyProjection', 'supportsSkillProjection'] as const) {
      expect(entry[field], field).toBe(false)
    }
    expect(entry.approvalSupport).toBe('host-gated')
    expect(entry.toolControlSupport).toEqual({ mode: 'none', allowlist: 'none', blocklist: 'none' })
  })

  it('carries a complete CatalogEntry for all ten existing adapters', () => {
    expect(Object.keys(PROVIDER_CATALOG)).toEqual([...EXPECTED_PROVIDERS, 'pi', 'opencode', 'cline'])

    for (const providerId of EXPECTED_PROVIDERS) {
      const entry = PROVIDER_CATALOG[providerId]

      expect(() => assertProviderCatalogEntry(entry, providerId)).not.toThrow()
      expect(entry.coordinates.providerId).toBe(providerId)
      expect(entry.monitorTier).toBe(entry.monitorIntrospection)
      expect(entry.displayName.length).toBeGreaterThan(0)
      expect(Object.keys(entry.posture).sort()).toEqual(['postureId', 'version'])
      expect(entry.eventFidelity.normalized).toBe(true)
      expect(entry.upstream.repo).toContain('/')
      expect(entry.upstream.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it.each([
    'coordinates',
    'displayName',
    'capabilityProfile',
    'monitorTier',
    'productIntegrated',
    'posture',
    'eventFidelity',
    'upstream',
  ] as const)('rejects an entry missing required field %s', (field) => {
    const incomplete: Record<string, unknown> = structuredClone(PROVIDER_CATALOG.claude)
    delete incomplete[field]

    expect(() => assertProviderCatalogEntry(incomplete, 'claude')).toThrow(TypeError)
  })

  it('rejects key/coordinate drift and monitor-tier alias drift', () => {
    const wrongProvider = structuredClone(PROVIDER_CATALOG.claude) as ProviderCatalogEntry
    wrongProvider.coordinates.providerId = 'codex'
    expect(() => assertProviderCatalogEntry(wrongProvider, 'claude')).toThrow(
      /disagrees with coordinates\.providerId/,
    )

    const wrongTier = structuredClone(PROVIDER_CATALOG.claude) as ProviderCatalogEntry
    wrongTier.monitorIntrospection = 'none'
    expect(() => assertProviderCatalogEntry(wrongTier, 'claude')).toThrow(
      /monitorIntrospection alias disagrees/,
    )
  })

  it('keeps lifecycle recipe references on CLI coordinates only', () => {
    for (const providerId of ['claude', 'codex', 'gemini', 'qwen', 'goose', 'crush'] as const) {
      const entry = PROVIDER_CATALOG[providerId]
      expect(entry.coordinates.backend).toBe('cli')
      expect(entry.lifecycleRecipeRef).toBe(`lifecycle/${providerId}-cli`)
    }

    for (const providerId of ['gemini-sdk', 'openrouter', 'openai', 'ollama'] as const) {
      expect(PROVIDER_CATALOG[providerId].coordinates.backend).not.toBe('cli')
      expect('lifecycleRecipeRef' in PROVIDER_CATALOG[providerId]).toBe(false)
    }
  })

  it('records the Qwen streaming capability from the runtime instead of the stale legacy claim', () => {
    expect(getProviderCapabilities('qwen')?.capabilityProfile.supportsStreaming).toBe(true)
  })

  it('keeps Goose discovery-only while admitting Crush to the product runtime', () => {
    expect(PROVIDER_CATALOG.goose.productIntegrated).toBe(false)
    expect(PROVIDER_CATALOG.crush.productIntegrated).toBe(true)
  })
})
