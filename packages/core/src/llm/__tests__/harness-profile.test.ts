import { describe, it, expect, beforeEach } from 'vitest'
import { HarnessProfileRegistry } from '../harness-profile.js'
import type { HarnessProfile } from '../harness-profile.js'

function makeProfile(overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return {
    id: 'default-profile',
    version: '1.0.0',
    registeredAt: Date.now(),
    ...overrides,
  }
}

describe('HarnessProfileRegistry', () => {
  let registry: HarnessProfileRegistry

  beforeEach(() => {
    registry = new HarnessProfileRegistry()
  })

  it('returns undefined when no profiles registered', () => {
    expect(registry.resolve({ provider: 'anthropic', modelName: 'claude-opus-4-7' })).toBeUndefined()
  })

  it('resolves a default profile (no selectors)', () => {
    registry.register(makeProfile({ id: 'default', systemPrompt: { prefix: 'You are helpful.' } }))
    const resolved = registry.resolve({ provider: 'anthropic', modelName: 'claude-opus-4-7' })
    expect(resolved?.systemPromptPrefix).toBe('You are helpful.')
  })

  it('provider-scoped profile takes priority over default', () => {
    registry.register(makeProfile({ id: 'default', systemPrompt: { prefix: 'default' } }))
    registry.register(makeProfile({
      id: 'anthropic-profile',
      provider: 'anthropic',
      systemPrompt: { prefix: 'anthropic-specific' },
    }))
    const resolved = registry.resolve({ provider: 'anthropic', modelName: 'claude-opus-4-7' })
    expect(resolved?.systemPromptPrefix).toBe('anthropic-specific')
  })

  it('exact provider + modelGlob takes priority over provider-only', () => {
    registry.register(makeProfile({ id: 'prov', provider: 'anthropic', systemPrompt: { prefix: 'prov' } }))
    registry.register(makeProfile({
      id: 'opus',
      provider: 'anthropic',
      modelGlob: 'claude-opus-*',
      systemPrompt: { prefix: 'opus-specific' },
    }))
    const resolved = registry.resolve({ provider: 'anthropic', modelName: 'claude-opus-4-7' })
    expect(resolved?.systemPromptPrefix).toBe('opus-specific')
  })

  it('glob matching works (wildcard)', () => {
    registry.register(makeProfile({ id: 'glob', modelGlob: 'gpt-4*', systemPrompt: { prefix: 'gpt4' } }))
    expect(registry.resolve({ provider: 'openai', modelName: 'gpt-4o' })?.systemPromptPrefix).toBe('gpt4')
    expect(registry.resolve({ provider: 'openai', modelName: 'gpt-3.5-turbo' })).toBeUndefined()
  })

  it('does not match profile with mismatched provider', () => {
    registry.register(makeProfile({ id: 'p', provider: 'openai', systemPrompt: { prefix: 'openai' } }))
    expect(registry.resolve({ provider: 'anthropic', modelName: 'claude-opus-4-7' })).toBeUndefined()
  })

  it('tier selector matches correctly', () => {
    registry.register(makeProfile({ id: 'reasoning', tier: 'reasoning', systemPrompt: { suffix: 'think step by step' } }))
    const resolved = registry.resolve({ provider: 'openai', modelName: 'o3', tier: 'reasoning' })
    expect(resolved?.systemPromptSuffix).toBe('think step by step')
  })

  it('resolves tool visibility overrides', () => {
    registry.register(makeProfile({
      id: 'tools',
      toolVisibility: { include: ['read_file', 'write_file'], exclude: ['bash'] },
    }))
    const r = registry.resolve({ provider: 'anthropic', modelName: 'any' })
    expect(r?.visibleToolNames).toEqual(['read_file', 'write_file'])
    expect(r?.excludedToolNames).toEqual(['bash'])
  })

  it('resolves middleware overrides', () => {
    registry.register(makeProfile({
      id: 'middleware',
      middleware: { include: ['cache'], exclude: ['logger'] },
    }))
    const r = registry.resolve({ provider: 'anthropic', modelName: 'any' })
    expect(r?.activeMiddlewareNames).toEqual(['cache'])
    expect(r?.excludedMiddlewareNames).toEqual(['logger'])
  })

  it('updates existing profile by id on re-register', () => {
    registry.register(makeProfile({ id: 'p', systemPrompt: { prefix: 'v1' } }))
    registry.register(makeProfile({ id: 'p', systemPrompt: { prefix: 'v2' } }))
    expect(registry.list()).toHaveLength(1)
    expect(registry.resolve({ provider: 'any', modelName: 'any' })?.systemPromptPrefix).toBe('v2')
  })

  it('remove() unregisters a profile', () => {
    registry.register(makeProfile({ id: 'p' }))
    expect(registry.remove('p')).toBe(true)
    expect(registry.list()).toHaveLength(0)
    expect(registry.remove('no-such')).toBe(false)
  })
})
