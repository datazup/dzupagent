import { describe, it, expect } from 'vitest'
import { injectSkills } from '../skills/skill-injector.js'
import type { SkillDefinition } from '../skills/skill-types.js'

describe('injectSkills', () => {
  const basePrompt = 'You are a helpful assistant.'

  it('returns original prompt when no skills provided', () => {
    const result = injectSkills(basePrompt, [])
    expect(result).toBe(basePrompt)
  })

  it('appends skills section with a single skill', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'code-review',
        description: 'Reviews code for quality issues',
        path: '/skills/code-review/SKILL.md',
        metadata: {},
      },
    ]

    const result = injectSkills(basePrompt, skills)

    expect(result).toContain(basePrompt)
    expect(result).toContain('## Skills Available')
    expect(result).toContain('**code-review**')
    expect(result).toContain('Reviews code for quality issues')
    expect(result).toContain('/skills/code-review/SKILL.md')
  })

  it('appends multiple skills as a list', () => {
    const skills: SkillDefinition[] = [
      { name: 'skill-a', description: 'Does A', path: '/a/SKILL.md', metadata: {} },
      { name: 'skill-b', description: 'Does B', path: '/b/SKILL.md', metadata: {} },
      { name: 'skill-c', description: 'Does C', path: '/c/SKILL.md', metadata: {} },
    ]

    const result = injectSkills(basePrompt, skills)

    expect(result).toContain('**skill-a**')
    expect(result).toContain('**skill-b**')
    expect(result).toContain('**skill-c**')
    expect(result).toContain('Does A')
    expect(result).toContain('Does B')
    expect(result).toContain('Does C')
  })

  it('includes instruction to read SKILL.md for details', () => {
    const skills: SkillDefinition[] = [
      { name: 'test', description: 'Test skill', path: '/test/SKILL.md', metadata: {} },
    ]

    const result = injectSkills(basePrompt, skills)
    expect(result).toContain('read its SKILL.md file')
  })

  it('preserves the original prompt exactly at the start', () => {
    const skills: SkillDefinition[] = [
      { name: 'test', description: 'Test', path: '/test/SKILL.md', metadata: {} },
    ]

    const result = injectSkills(basePrompt, skills)
    expect(result.startsWith(basePrompt)).toBe(true)
  })

  it('handles empty prompt string', () => {
    const skills: SkillDefinition[] = [
      { name: 'test', description: 'Test', path: '/test/SKILL.md', metadata: {} },
    ]

    const result = injectSkills('', skills)
    expect(result).toContain('## Skills Available')
    expect(result).toContain('**test**')
  })
})
