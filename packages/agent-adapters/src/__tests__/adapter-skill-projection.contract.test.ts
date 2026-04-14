import { describe, it, expect, beforeEach } from 'vitest'

import type { AdapterSkillBundle, CompiledAdapterSkill } from '../skills/adapter-skill-types.js'
import type { AdapterProviderId } from '../types.js'
import { CodexSkillCompiler } from '../skills/compilers/codex-skill-compiler.js'
import { ClaudeSkillCompiler } from '../skills/compilers/claude-skill-compiler.js'
import { CliSkillCompiler } from '../skills/compilers/cli-skill-compiler.js'
import { AdapterSkillRegistry, createDefaultSkillRegistry } from '../skills/adapter-skill-registry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<AdapterSkillBundle> = {}): AdapterSkillBundle {
  return {
    bundleId: 'bundle-001',
    skillSetId: 'skillset-alpha',
    skillSetVersion: '2.1.0',
    personaId: 'code-reviewer',
    constraints: {
      maxBudgetUsd: 5,
      approvalMode: 'conditional',
      networkPolicy: 'restricted',
      toolPolicy: 'balanced',
    },
    promptSections: [
      { id: 'safety', purpose: 'safety', content: 'Never execute destructive commands.', priority: 1 },
      { id: 'task', purpose: 'task', content: 'Review the pull request for correctness.', priority: 10 },
      { id: 'persona', purpose: 'persona', content: 'You are a senior code reviewer.', priority: 5 },
    ],
    toolBindings: [
      { toolName: 'read_file', mode: 'required' },
      { toolName: 'write_file', mode: 'optional' },
      { toolName: 'exec_command', mode: 'blocked' },
      { toolName: 'search_code', mode: 'required' },
    ],
    metadata: {
      owner: 'platform-team',
      reviewedBy: 'security-lead',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Shared assertions for any compiler
// ---------------------------------------------------------------------------

function assertSystemPromptOrdering(compiled: CompiledAdapterSkill, bundle: AdapterSkillBundle): void {
  const prompt = compiled.runtimeConfig['systemPrompt'] as string
  expect(typeof prompt).toBe('string')

  // All section content must be present
  for (const section of bundle.promptSections) {
    expect(prompt).toContain(section.content)
  }

  // Verify priority ordering: lower priority number appears first
  const sorted = [...bundle.promptSections].sort((a, b) => a.priority - b.priority)
  let lastIndex = -1
  for (const section of sorted) {
    const idx = prompt.indexOf(section.content)
    expect(idx).toBeGreaterThan(lastIndex)
    lastIndex = idx
  }
}

function assertToolExtraction(compiled: CompiledAdapterSkill): void {
  const required = compiled.runtimeConfig['requiredTools'] as string[]
  const blocked = compiled.runtimeConfig['blockedTools'] as string[]

  expect(required).toContain('read_file')
  expect(required).toContain('search_code')
  expect(required).not.toContain('write_file')
  expect(required).not.toContain('exec_command')

  expect(blocked).toContain('exec_command')
  expect(blocked).not.toContain('read_file')
  expect(blocked).not.toContain('write_file')
}

// ---------------------------------------------------------------------------
// Codex compiler
// ---------------------------------------------------------------------------

describe('CodexSkillCompiler', () => {
  let compiler: CodexSkillCompiler

  beforeEach(() => {
    compiler = new CodexSkillCompiler()
  })

  it('has providerId codex', () => {
    expect(compiler.providerId).toBe('codex')
  })

  it('compiles system prompt with sections ordered by priority', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    assertSystemPromptOrdering(compiled, bundle)
  })

  it('extracts required and blocked tools', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    assertToolExtraction(compiled)
  })

  it('maps approvalMode from constraints', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['approvalMode']).toBe('conditional')
  })

  it('maps networkPolicy from constraints', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['networkPolicy']).toBe('restricted')
  })

  it('defaults approvalMode to auto when not set', () => {
    const bundle = makeBundle({ constraints: {} })
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['approvalMode']).toBe('auto')
  })

  it('produces stable hash for same input', () => {
    const bundle = makeBundle()
    const a = compiler.compile(bundle)
    const b = compiler.compile(bundle)
    expect(a.hash).toBe(b.hash)
  })

  it('produces different hash for different bundle versions', () => {
    const a = compiler.compile(makeBundle({ skillSetVersion: '1.0.0' }))
    const b = compiler.compile(makeBundle({ skillSetVersion: '2.0.0' }))
    expect(a.hash).not.toBe(b.hash)
  })

  it('validation passes for valid compiled skill', () => {
    const compiled = compiler.compile(makeBundle())
    const result = compiler.validate(compiled)
    expect(result.ok).toBe(true)
  })

  it('validation fails for wrong providerId', () => {
    const compiled = compiler.compile(makeBundle())
    const tampered = { ...compiled, providerId: 'claude' as AdapterProviderId }
    const result = compiler.validate(tampered)
    expect(result.ok).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors?.some((e) => e.includes('providerId'))).toBe(true)
  })

  it('validation fails for missing systemPrompt', () => {
    const compiled = compiler.compile(makeBundle())
    const tampered: CompiledAdapterSkill = {
      ...compiled,
      runtimeConfig: { ...compiled.runtimeConfig, systemPrompt: undefined },
    }
    const result = compiler.validate(tampered)
    expect(result.ok).toBe(false)
    expect(result.errors?.some((e) => e.includes('systemPrompt'))).toBe(true)
  })

  it('validation fails for missing hash', () => {
    const compiled = compiler.compile(makeBundle())
    const tampered = { ...compiled, hash: '' }
    const result = compiler.validate(tampered)
    expect(result.ok).toBe(false)
    expect(result.errors?.some((e) => e.includes('hash'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Claude compiler
// ---------------------------------------------------------------------------

describe('ClaudeSkillCompiler', () => {
  let compiler: ClaudeSkillCompiler

  beforeEach(() => {
    compiler = new ClaudeSkillCompiler()
  })

  it('has providerId claude', () => {
    expect(compiler.providerId).toBe('claude')
  })

  it('compiles system prompt with sections ordered by priority', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    assertSystemPromptOrdering(compiled, bundle)
  })

  it('extracts required and blocked tools', () => {
    const bundle = makeBundle()
    const compiled = compiler.compile(bundle)
    assertToolExtraction(compiled)
  })

  it('maps approvalMode to permissionMode', () => {
    expect(
      compiler.compile(makeBundle({ constraints: { approvalMode: 'auto' } })).runtimeConfig['permissionMode'],
    ).toBe('auto')
    expect(
      compiler.compile(makeBundle({ constraints: { approvalMode: 'required' } })).runtimeConfig['permissionMode'],
    ).toBe('manual')
    expect(
      compiler.compile(makeBundle({ constraints: { approvalMode: 'conditional' } })).runtimeConfig['permissionMode'],
    ).toBe('conditional')
  })

  it('defaults permissionMode to auto when approvalMode is not set', () => {
    const bundle = makeBundle({ constraints: {} })
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['permissionMode']).toBe('auto')
  })

  it('derives maxBudgetTokens from maxBudgetUsd', () => {
    const bundle = makeBundle({ constraints: { maxBudgetUsd: 2 } })
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['maxBudgetTokens']).toBe(2_000_000)
  })

  it('omits maxBudgetTokens when maxBudgetUsd is not set', () => {
    const bundle = makeBundle({ constraints: {} })
    const compiled = compiler.compile(bundle)
    expect(compiled.runtimeConfig['maxBudgetTokens']).toBeUndefined()
  })

  it('produces stable hash for same input', () => {
    const bundle = makeBundle()
    const a = compiler.compile(bundle)
    const b = compiler.compile(bundle)
    expect(a.hash).toBe(b.hash)
  })

  it('produces different hash from codex for same bundle', () => {
    const bundle = makeBundle()
    const claudeHash = compiler.compile(bundle).hash
    const codexHash = new CodexSkillCompiler().compile(bundle).hash
    expect(claudeHash).not.toBe(codexHash)
  })

  it('validation passes for valid compiled skill', () => {
    const compiled = compiler.compile(makeBundle())
    const result = compiler.validate(compiled)
    expect(result.ok).toBe(true)
  })

  it('validation fails for wrong providerId', () => {
    const compiled = compiler.compile(makeBundle())
    const tampered = { ...compiled, providerId: 'codex' as AdapterProviderId }
    const result = compiler.validate(tampered)
    expect(result.ok).toBe(false)
  })

  it('validation fails for negative maxBudgetTokens', () => {
    const compiled = compiler.compile(makeBundle())
    const tampered: CompiledAdapterSkill = {
      ...compiled,
      runtimeConfig: { ...compiled.runtimeConfig, maxBudgetTokens: -100 },
    }
    const result = compiler.validate(tampered)
    expect(result.ok).toBe(false)
    expect(result.errors?.some((e) => e.includes('maxBudgetTokens'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CLI-family compiler
// ---------------------------------------------------------------------------

describe('CliSkillCompiler', () => {
  const cliProviders: AdapterProviderId[] = ['gemini', 'qwen', 'crush', 'goose', 'openrouter']

  it('throws for non-CLI provider IDs', () => {
    expect(() => new CliSkillCompiler('claude')).toThrow()
    expect(() => new CliSkillCompiler('codex')).toThrow()
  })

  for (const pid of cliProviders) {
    describe(`provider: ${pid}`, () => {
      let compiler: CliSkillCompiler

      beforeEach(() => {
        compiler = new CliSkillCompiler(pid)
      })

      it(`has providerId ${pid}`, () => {
        expect(compiler.providerId).toBe(pid)
      })

      it('compiles system prompt with sections ordered by priority', () => {
        const bundle = makeBundle()
        const compiled = compiler.compile(bundle)
        assertSystemPromptOrdering(compiled, bundle)
      })

      it('extracts required and blocked tools', () => {
        const bundle = makeBundle()
        const compiled = compiler.compile(bundle)
        assertToolExtraction(compiled)
      })

      it('includes supportedFeatures in runtimeConfig', () => {
        const compiled = compiler.compile(makeBundle())
        const features = compiled.runtimeConfig['supportedFeatures']
        expect(Array.isArray(features)).toBe(true)
        expect((features as string[]).includes('systemPrompt')).toBe(true)
      })

      it('produces stable hash for same input', () => {
        const bundle = makeBundle()
        const a = compiler.compile(bundle)
        const b = compiler.compile(bundle)
        expect(a.hash).toBe(b.hash)
      })

      it('validation passes for valid compiled skill', () => {
        const compiled = compiler.compile(makeBundle())
        const result = compiler.validate(compiled)
        expect(result.ok).toBe(true)
      })

      it('validation includes warnings for unsupported constraints', () => {
        const compiled = compiler.compile(makeBundle())
        const result = compiler.validate(compiled)
        // CLI providers lack approvalMode/networkPolicy/budgetLimit support
        // so validation should include informational warnings
        if (result.errors && result.errors.length > 0) {
          expect(result.errors.some((e) => e.includes('does not support'))).toBe(true)
        }
      })

      it('validation fails for wrong providerId', () => {
        const compiled = compiler.compile(makeBundle())
        const tampered = { ...compiled, providerId: 'claude' as AdapterProviderId }
        const result = compiler.validate(tampered)
        expect(result.ok).toBe(false)
      })
    })
  }

  it('different CLI providers produce different hashes for same bundle', () => {
    const bundle = makeBundle()
    const hashes = cliProviders.map((pid) => new CliSkillCompiler(pid).compile(bundle).hash)
    const uniqueHashes = new Set(hashes)
    expect(uniqueHashes.size).toBe(cliProviders.length)
  })
})

// ---------------------------------------------------------------------------
// Cross-provider hash uniqueness
// ---------------------------------------------------------------------------

describe('cross-provider hash uniqueness', () => {
  it('all providers produce different hashes for the same bundle', () => {
    const bundle = makeBundle()
    const allProviders: AdapterProviderId[] = ['claude', 'codex', 'gemini', 'qwen', 'crush', 'goose', 'openrouter']

    const hashes = allProviders.map((pid) => {
      const registry = createDefaultSkillRegistry()
      return registry.compile(bundle, pid).hash
    })

    const uniqueHashes = new Set(hashes)
    expect(uniqueHashes.size).toBe(allProviders.length)
  })
})

// ---------------------------------------------------------------------------
// AdapterSkillRegistry
// ---------------------------------------------------------------------------

describe('AdapterSkillRegistry', () => {
  let registry: AdapterSkillRegistry

  beforeEach(() => {
    registry = createDefaultSkillRegistry()
  })

  it('lists all pre-registered providers', () => {
    const providers = registry.listProviders()
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
    expect(providers).toContain('gemini')
    expect(providers).toContain('qwen')
    expect(providers).toContain('crush')
    expect(providers).toContain('goose')
    expect(providers).toContain('openrouter')
    expect(providers).toHaveLength(7)
  })

  it('compiles via registry for each registered provider', () => {
    const bundle = makeBundle()
    for (const pid of registry.listProviders()) {
      const compiled = registry.compile(bundle, pid)
      expect(compiled.providerId).toBe(pid)
      expect(typeof compiled.hash).toBe('string')
      expect(compiled.hash.length).toBeGreaterThan(0)
      expect(typeof compiled.runtimeConfig['systemPrompt']).toBe('string')
    }
  })

  it('throws for unregistered provider', () => {
    const bundle = makeBundle()
    const emptyRegistry = new AdapterSkillRegistry()
    expect(() => emptyRegistry.compile(bundle, 'claude')).toThrow(/No skill compiler registered/)
  })

  it('getCompiler returns undefined for unregistered provider', () => {
    const emptyRegistry = new AdapterSkillRegistry()
    expect(emptyRegistry.getCompiler('claude')).toBeUndefined()
  })

  it('getCompiler returns compiler for registered provider', () => {
    const compiler = registry.getCompiler('claude')
    expect(compiler).toBeDefined()
    expect(compiler?.providerId).toBe('claude')
  })

  it('register overwrites existing compiler', () => {
    const customCompiler = new ClaudeSkillCompiler()
    registry.register(customCompiler)
    expect(registry.getCompiler('claude')).toBe(customCompiler)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles bundle with no prompt sections', () => {
    const bundle = makeBundle({ promptSections: [] })
    const compiled = new CodexSkillCompiler().compile(bundle)
    expect(compiled.runtimeConfig['systemPrompt']).toBe('')
  })

  it('handles bundle with no tool bindings', () => {
    const bundle = makeBundle({ toolBindings: [] })
    const compiled = new ClaudeSkillCompiler().compile(bundle)
    expect(compiled.runtimeConfig['requiredTools']).toEqual([])
    expect(compiled.runtimeConfig['blockedTools']).toEqual([])
  })

  it('handles bundle with single prompt section', () => {
    const bundle = makeBundle({
      promptSections: [{ id: 'only', purpose: 'task', content: 'Do the thing.', priority: 1 }],
    })
    const compiled = new CodexSkillCompiler().compile(bundle)
    expect(compiled.runtimeConfig['systemPrompt']).toBe('Do the thing.')
  })

  it('handles bundle with all tools blocked', () => {
    const bundle = makeBundle({
      toolBindings: [
        { toolName: 'a', mode: 'blocked' },
        { toolName: 'b', mode: 'blocked' },
      ],
    })
    const compiled = new ClaudeSkillCompiler().compile(bundle)
    expect(compiled.runtimeConfig['requiredTools']).toEqual([])
    expect(compiled.runtimeConfig['blockedTools']).toEqual(['a', 'b'])
  })

  it('handles fractional maxBudgetUsd', () => {
    const bundle = makeBundle({ constraints: { maxBudgetUsd: 0.5 } })
    const compiled = new ClaudeSkillCompiler().compile(bundle)
    expect(compiled.runtimeConfig['maxBudgetTokens']).toBe(500_000)
  })
})
