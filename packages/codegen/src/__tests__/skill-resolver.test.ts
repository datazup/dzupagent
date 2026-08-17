import { describe, it, expect, vi } from 'vitest'
import { SkillLoader, SkillRegistry } from '@dzupagent/core'
import type { SkillResolutionContext } from '@dzupagent/core'
import {
  resolveSkills,
  formatResolvedSkillsPrompt,
  injectSkillsIntoState,
  resolveAndInjectSkills,
} from '../pipeline/skill-resolver.js'
import type {
  ResolvedSkill,
  SkillContentLoader,
  SkillInstructionSource,
  SkillResolverConfig,
} from '../pipeline/skill-resolver.js'

describe('resolveSkills', () => {
  it('resolves from registry first', async () => {
    const get = vi
      .fn<SkillInstructionSource['get']>()
      .mockReturnValue({ instructions: 'registry content' })
    const config: SkillResolverConfig = { registry: { get } }

    const result = await resolveSkills(['my-skill'], config)

    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe('registry')
    expect(result[0]!.content).toBe('registry content')
    // The name the caller asked for is the name looked up. Unasserted before,
    // and unfalsifiable while `get` was a zero-parameter `vi.fn()` — that types
    // `mock.calls[0]` as the empty tuple, so the argument is `never`.
    expect(get).toHaveBeenCalledWith('my-skill')
  })

  it('falls back to loader when not in registry', async () => {
    const get = vi.fn<SkillInstructionSource['get']>().mockReturnValue(undefined)
    const loadSkillContent = vi
      .fn<SkillContentLoader['loadSkillContent']>()
      .mockResolvedValue('loader content')
    const config: SkillResolverConfig = { registry: { get }, loader: { loadSkillContent } }

    const result = await resolveSkills(['my-skill'], config)

    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe('loader')
    expect(result[0]!.content).toBe('loader content')
    expect(get).toHaveBeenCalledWith('my-skill')
    expect(loadSkillContent).toHaveBeenCalledWith('my-skill')
  })

  it('skips unresolved skills with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      registry: { get: vi.fn<SkillInstructionSource['get']>().mockReturnValue(undefined) },
    }
    const result = await resolveSkills(['missing-skill'], config)
    expect(result).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing-skill'))
    warnSpy.mockRestore()
  })

  it('handles loader that returns null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      loader: {
        loadSkillContent: vi.fn<SkillContentLoader['loadSkillContent']>().mockResolvedValue(null),
      },
    }
    const result = await resolveSkills(['missing'], config)
    expect(result).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('handles loader that throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      loader: {
        loadSkillContent: vi
          .fn<SkillContentLoader['loadSkillContent']>()
          .mockRejectedValue(new Error('boom')),
      },
    }
    const result = await resolveSkills(['error-skill'], config)
    expect(result).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('resolves multiple skills', async () => {
    const config: SkillResolverConfig = {
      registry: {
        get: vi.fn<SkillInstructionSource['get']>().mockImplementation((name) => {
          if (name === 'a') return { instructions: 'A content' }
          return undefined
        }),
      },
      loader: {
        loadSkillContent: vi
          .fn<SkillContentLoader['loadSkillContent']>()
          .mockImplementation(async (name) => (name === 'b' ? 'B content' : null)),
      },
    }
    const result = await resolveSkills(['a', 'b'], config)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('a')
    expect(result[1]!.name).toBe('b')
  })
})

describe('formatResolvedSkillsPrompt', () => {
  it('returns empty for no skills', () => {
    expect(formatResolvedSkillsPrompt([])).toBe('')
  })

  it('formats skills as markdown sections', () => {
    const skills: ResolvedSkill[] = [
      { name: 'coding', content: 'Write clean code', source: 'registry' },
      { name: 'testing', content: 'Test thoroughly', source: 'loader' },
    ]
    const prompt = formatResolvedSkillsPrompt(skills)
    expect(prompt).toContain('## Active Skills')
    expect(prompt).toContain('### coding')
    expect(prompt).toContain('Write clean code')
    expect(prompt).toContain('### testing')
  })
})

describe('injectSkillsIntoState', () => {
  it('injects skills and prompt into state', () => {
    const state: Record<string, unknown> = {}
    const skills: ResolvedSkill[] = [
      { name: 'coding', content: 'Write clean code', source: 'registry' },
    ]
    injectSkillsIntoState(state, 'generate', skills)
    expect(state['__skills_generate']).toBe(skills)
    expect(state['__skills_prompt_generate']).toContain('coding')
  })

  it('sanitizes phase name for key', () => {
    const state: Record<string, unknown> = {}
    injectSkillsIntoState(state, 'gen-backend.v2', [])
    expect(state['__skills_gen_backend_v2']).toEqual([])
  })

  it('injects skill context when provided', () => {
    const state: Record<string, unknown> = {}
    // `SkillResolutionContext` has no `taskType`, and `phase` is required — the
    // cast this replaces was hiding both.
    const context: SkillResolutionContext = { phase: 'gen' }
    injectSkillsIntoState(state, 'gen', [], context)
    expect(state['__skill_context']).toBe(context)
  })
})

describe('resolveAndInjectSkills', () => {
  it('returns empty for no skill names', async () => {
    const state: Record<string, unknown> = {}
    const result = await resolveAndInjectSkills([], 'gen', state, {})
    expect(result).toHaveLength(0)
  })

  it('resolves and injects in one call', async () => {
    const state: Record<string, unknown> = {}
    const config: SkillResolverConfig = {
      registry: {
        get: vi.fn<SkillInstructionSource['get']>().mockReturnValue({ instructions: 'content' }),
      },
    }
    const result = await resolveAndInjectSkills(['skill1'], 'gen', state, config)
    expect(result).toHaveLength(1)
    expect(state['__skills_gen']).toBeDefined()
  })
})

describe('SkillResolverConfig accepts the real core implementations', () => {
  // The ports in skill-resolver.ts are narrower than core's classes on purpose.
  // Narrowing is only safe while the real classes still fit them, so assert
  // that against live instances — a hand-copied shape is exactly what the
  // `as unknown as` casts used to be, and it can drift without anyone noticing.

  it('resolves through a real SkillRegistry with no cast', async () => {
    const registry = new SkillRegistry()
    registry.register({
      id: 'real-skill',
      name: 'Real Skill',
      description: 'Registered through the real registry',
      instructions: 'real instructions',
    })

    const result = await resolveSkills(['real-skill'], { registry })

    expect(result).toEqual([
      { name: 'real-skill', content: 'real instructions', source: 'registry' },
    ])
  })

  it('falls through a real SkillLoader with no cast', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // No source paths, so loadSkillContent returns null without touching disk.
    const result = await resolveSkills(['absent-skill'], { loader: new SkillLoader([]) })

    expect(result).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('absent-skill'))

    warnSpy.mockRestore()
  })
})
