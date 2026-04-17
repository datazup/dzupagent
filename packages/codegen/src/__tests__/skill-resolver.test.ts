import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveSkills,
  formatResolvedSkillsPrompt,
  injectSkillsIntoState,
  resolveAndInjectSkills,
} from '../pipeline/skill-resolver.js'
import type { ResolvedSkill, SkillResolverConfig } from '../pipeline/skill-resolver.js'

describe('resolveSkills', () => {
  it('resolves from registry first', async () => {
    const config: SkillResolverConfig = {
      registry: {
        get: vi.fn().mockReturnValue({ instructions: 'registry content' }),
      } as never,
    }
    const result = await resolveSkills(['my-skill'], config)
    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe('registry')
    expect(result[0]!.content).toBe('registry content')
  })

  it('falls back to loader when not in registry', async () => {
    const config: SkillResolverConfig = {
      registry: { get: vi.fn().mockReturnValue(undefined) } as never,
      loader: {
        loadSkillContent: vi.fn().mockResolvedValue('loader content'),
      } as never,
    }
    const result = await resolveSkills(['my-skill'], config)
    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe('loader')
  })

  it('skips unresolved skills with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      registry: { get: vi.fn().mockReturnValue(undefined) } as never,
    }
    const result = await resolveSkills(['missing-skill'], config)
    expect(result).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing-skill'))
    warnSpy.mockRestore()
  })

  it('handles loader that returns null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      loader: { loadSkillContent: vi.fn().mockResolvedValue(null) } as never,
    }
    const result = await resolveSkills(['missing'], config)
    expect(result).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('handles loader that throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config: SkillResolverConfig = {
      loader: { loadSkillContent: vi.fn().mockRejectedValue(new Error('boom')) } as never,
    }
    const result = await resolveSkills(['error-skill'], config)
    expect(result).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('resolves multiple skills', async () => {
    const config: SkillResolverConfig = {
      registry: {
        get: vi.fn().mockImplementation((name: string) => {
          if (name === 'a') return { instructions: 'A content' }
          return undefined
        }),
      } as never,
      loader: {
        loadSkillContent: vi.fn().mockImplementation(async (name: string) => {
          if (name === 'b') return 'B content'
          return null
        }),
      } as never,
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
    const context = { taskType: 'generation' } as never
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
        get: vi.fn().mockReturnValue({ instructions: 'content' }),
      } as never,
    }
    const result = await resolveAndInjectSkills(['skill1'], 'gen', state, config)
    expect(result).toHaveLength(1)
    expect(state['__skills_gen']).toBeDefined()
  })
})
