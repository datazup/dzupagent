import { describe, it, expect } from 'vitest'

import {
  AdapterProviderIdSchema,
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from '../http/request-schemas.js'
import {
  HTTP_ROUTABLE_PROVIDER_IDS,
  PROVIDER_CATALOG,
  getDefaultMonitorStatus,
  getProductProviders,
  getProviderCapabilities,
} from '../provider-catalog.js'
import { OpenAIAdapter } from '../openai/openai-adapter.js'
import type { AdapterProviderId } from '../types.js'

const PRESERVED_HTTP_ROUTABLE_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'crush',
  'goose',
  'openrouter',
] as const satisfies readonly AdapterProviderId[]

describe('RunRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello world',
      tags: ['test'],
      preferredProvider: 'claude',
      stream: true,
      policyConformanceMode: 'warn-only',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a minimal valid request', () => {
    const result = RunRequestSchema.safeParse({ prompt: 'Hi' })
    expect(result.success).toBe(true)
  })

  it('rejects missing prompt', () => {
    const result = RunRequestSchema.safeParse({ tags: ['test'] })
    expect(result.success).toBe(false)
  })

  it('rejects prompt of wrong type', () => {
    const result = RunRequestSchema.safeParse({ prompt: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects empty prompt', () => {
    const result = RunRequestSchema.safeParse({ prompt: '' })
    expect(result.success).toBe(false)
  })

  it('rejects prompt that is too long', () => {
    const result = RunRequestSchema.safeParse({ prompt: 'x'.repeat(100_001) })
    expect(result.success).toBe(false)
  })

  it('rejects invalid preferredProvider', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello',
      preferredProvider: 'invalid-provider',
    })
    expect(result.success).toBe(false)
  })

  it('rejects maxTurns exceeding limit', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello',
      maxTurns: 1001,
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid policyConformanceMode', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello',
      policyConformanceMode: 'relaxed',
    })
    expect(result.success).toBe(false)
  })
})

describe('HTTP provider policy', () => {
  it('derives request validation from the catalog HTTP routing policy', () => {
    for (const providerId of HTTP_ROUTABLE_PROVIDER_IDS) {
      const caps = getProviderCapabilities(providerId)

      expect(caps?.httpAdapterRouting).toBe(true)
      expect(AdapterProviderIdSchema.safeParse(providerId).success).toBe(true)
      expect(RunRequestSchema.safeParse({ prompt: 'Hello', preferredProvider: providerId }).success)
        .toBe(true)
      expect(SupervisorRequestSchema.safeParse({ goal: 'Build', preferredProviders: [providerId] }).success)
        .toBe(true)
      expect(ParallelRequestSchema.safeParse({ prompt: 'Hello', providers: [providerId] }).success)
        .toBe(true)
    }
  })

  it('keeps existing HTTP-routable providers accepted', () => {
    for (const providerId of PRESERVED_HTTP_ROUTABLE_PROVIDERS) {
      expect(HTTP_ROUTABLE_PROVIDER_IDS).toContain(providerId)
      expect(AdapterProviderIdSchema.safeParse(providerId).success).toBe(true)
    }
  })

  it('encodes OpenAI as product-integrated and HTTP-routable', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key' })
    const providerId = adapter.providerId
    const caps = getProviderCapabilities(providerId)

    expect(providerId).toBe('openai')
    expect(caps?.productIntegrated).toBe(true)
    expect(caps?.httpAdapterRouting).toBe(true)
    expect(getProductProviders()).toContain(providerId)
    expect(HTTP_ROUTABLE_PROVIDER_IDS).toContain(providerId)
    expect(AdapterProviderIdSchema.safeParse(providerId).success).toBe(true)
    expect(RunRequestSchema.safeParse({ prompt: 'Hello', preferredProvider: providerId }).success)
      .toBe(true)
    expect(SupervisorRequestSchema.safeParse({ goal: 'Build', preferredProviders: [providerId] }).success)
      .toBe(true)
    expect(ParallelRequestSchema.safeParse({ prompt: 'Hello', providers: [providerId] }).success)
      .toBe(true)
  })

  it('advertises OpenAI policy projection only where request-level controls exist', () => {
    expect(getProviderCapabilities('codex')?.toolControlSupport).toEqual({
      mode: 'native',
      allowlist: 'native',
      blocklist: 'native',
    })
    expect(getProviderCapabilities('openai')?.supportsPolicyProjection).toBe(true)
    expect(getProviderCapabilities('openai')?.toolControlSupport).toEqual({
      mode: 'native',
      allowlist: 'native',
      blocklist: 'native',
    })
    expect(getProviderCapabilities('openrouter')?.supportsPolicyProjection).toBe(false)
    expect(getProviderCapabilities('openrouter')?.toolControlSupport).toEqual({
      mode: 'none',
      allowlist: 'none',
      blocklist: 'none',
    })
  })

  it('distinguishes native, provider-config, and host-gated approval support', () => {
    expect(getProviderCapabilities('claude')?.approvalSupport).toBe('native')
    expect(getProviderCapabilities('codex')?.approvalSupport).toBe('native')

    for (const providerId of ['gemini', 'gemini-sdk', 'qwen', 'goose', 'crush'] as const) {
      expect(getProviderCapabilities(providerId)?.approvalSupport).toBe('provider-config')
    }

    expect(getProviderCapabilities('openai')?.approvalSupport).toBe('host-gated')
    expect(getProviderCapabilities('openrouter')?.approvalSupport).toBe('host-gated')
  })

  it('derives default monitor status from provider monitor introspection tier', () => {
    expect(getDefaultMonitorStatus('claude')).toEqual({
      state: 'not_configured',
      supported: true,
      monitorIntrospection: 'deep',
    })
    expect(getDefaultMonitorStatus('openai')).toEqual({
      state: 'unsupported',
      supported: false,
      monitorIntrospection: 'none',
    })
  })

  it('keeps native policy projection limited to providers with config projectors', () => {
    const nativeProjectionProviders = Object.entries(PROVIDER_CATALOG)
      .filter(([, caps]) => caps.supportsPolicyProjection)
      .map(([providerId]) => providerId)

    expect(nativeProjectionProviders).toEqual([
      'claude',
      'codex',
      'gemini',
      'qwen',
      'goose',
      'crush',
      'gemini-sdk',
      'openai',
      'ollama',
    ])
  })

  it('rejects providers not enabled for HTTP adapter routing', () => {
    const providerId = 'gemini-sdk'

    expect(getProviderCapabilities(providerId)?.httpAdapterRouting).toBe(false)
    expect(AdapterProviderIdSchema.safeParse(providerId).success).toBe(false)
    expect(RunRequestSchema.safeParse({ prompt: 'Hello', preferredProvider: providerId }).success)
      .toBe(false)
    expect(getProviderCapabilities('ollama')?.httpAdapterRouting).toBe(false)
    expect(AdapterProviderIdSchema.safeParse('ollama').success).toBe(false)
  })
})

describe('SupervisorRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = SupervisorRequestSchema.safeParse({
      goal: 'Build a feature',
      maxConcurrency: 5,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing goal', () => {
    const result = SupervisorRequestSchema.safeParse({ maxConcurrency: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects empty goal', () => {
    const result = SupervisorRequestSchema.safeParse({ goal: '' })
    expect(result.success).toBe(false)
  })
})

describe('ParallelRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: ['claude', 'gemini'],
      strategy: 'first-wins',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty providers array', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing providers', () => {
    const result = ParallelRequestSchema.safeParse({ prompt: 'Hello' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid strategy', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: ['claude'],
      strategy: 'invalid-strategy',
    })
    expect(result.success).toBe(false)
  })

  it('rejects too many providers', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: [
        'claude', 'codex', 'gemini', 'qwen', 'crush',
        'claude', 'codex', 'gemini', 'qwen', 'crush',
        'claude',
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('BidRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = BidRequestSchema.safeParse({ prompt: 'Hello' })
    expect(result.success).toBe(true)
  })

  it('accepts a request with criteria', () => {
    const result = BidRequestSchema.safeParse({
      prompt: 'Hello',
      criteria: 'lowest-cost',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing prompt', () => {
    const result = BidRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects invalid criteria', () => {
    const result = BidRequestSchema.safeParse({
      prompt: 'Hello',
      criteria: 'invalid',
    })
    expect(result.success).toBe(false)
  })
})

describe('ApproveRequestSchema', () => {
  it('accepts a valid approval', () => {
    const result = ApproveRequestSchema.safeParse({
      approved: true,
      reason: 'Looks good',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid rejection', () => {
    const result = ApproveRequestSchema.safeParse({ approved: false })
    expect(result.success).toBe(true)
  })

  it('rejects missing approved field', () => {
    const result = ApproveRequestSchema.safeParse({ reason: 'No reason' })
    expect(result.success).toBe(false)
  })

  it('rejects wrong type for approved', () => {
    const result = ApproveRequestSchema.safeParse({ approved: 'yes' })
    expect(result.success).toBe(false)
  })

  it('rejects reason that is too long', () => {
    const result = ApproveRequestSchema.safeParse({
      approved: true,
      reason: 'x'.repeat(10_001),
    })
    expect(result.success).toBe(false)
  })
})
