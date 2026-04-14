import { describe, it, expect, beforeEach } from 'vitest'
import type { SkillRegistryEntry } from '@dzupagent/core'

import { SkillProjector } from '../skills/skill-projector.js'
import type { SkillProjection, ProjectionOptions } from '../skills/skill-projector.js'
import type { AdapterProviderId, AgentInput } from '../types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A skill for testing',
    instructions: 'Follow these instructions carefully.',
    requiredTools: ['read_file', 'write_file'],
    ...overrides,
  }
}

function makeSkills(count: number): SkillRegistryEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeSkill({
      id: `skill-${i}`,
      name: `Skill ${i}`,
      description: `Description for skill ${i}`,
      instructions: `Instructions for skill ${i}.`,
      requiredTools: [`tool_${i}`],
    }),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillProjector', () => {
  let projector: SkillProjector

  beforeEach(() => {
    projector = new SkillProjector()
  })

  // -----------------------------------------------------------------------
  // Empty skills
  // -----------------------------------------------------------------------

  describe('empty skills', () => {
    it('returns empty projection for empty array', () => {
      const result = projector.project([], 'claude')
      expect(result).toEqual({
        systemPromptSection: '',
        requiredTools: [],
        skillCount: 0,
      })
    })

    it('returns empty projection for all providers', () => {
      const providers: AdapterProviderId[] = ['claude', 'codex', 'gemini', 'qwen', 'crush']
      for (const pid of providers) {
        const result = projector.project([], pid)
        expect(result.systemPromptSection).toBe('')
        expect(result.skillCount).toBe(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Claude formatting
  // -----------------------------------------------------------------------

  describe('claude provider', () => {
    it('formats detailed skill with markdown headers', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'claude')

      expect(result.systemPromptSection).toContain('# Active Skills')
      expect(result.systemPromptSection).toContain('## Test Skill')
      expect(result.systemPromptSection).toContain('A skill for testing')
      expect(result.systemPromptSection).toContain('Follow these instructions carefully.')
      expect(result.skillCount).toBe(1)
    })

    it('formats compact skill with truncated instructions', () => {
      const longInstructions = 'X'.repeat(500)
      const skill = makeSkill({ instructions: longInstructions })
      const result = projector.project([skill], 'claude', { format: 'compact' })

      expect(result.systemPromptSection).toContain('## Test Skill')
      // Compact truncates instructions to 200 chars
      expect(result.systemPromptSection).not.toContain(longInstructions)
      expect(result.systemPromptSection).toContain('...')
    })

    it('formats minimal skill as bullet point', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'claude', { format: 'minimal' })

      expect(result.systemPromptSection).toContain('- **Test Skill**: A skill for testing')
      expect(result.systemPromptSection).not.toContain('Follow these instructions')
    })
  })

  // -----------------------------------------------------------------------
  // Codex formatting
  // -----------------------------------------------------------------------

  describe('codex provider', () => {
    it('formats detailed skill with === delimiters', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'codex')

      expect(result.systemPromptSection).toContain('Active capabilities:')
      expect(result.systemPromptSection).toContain('=== Test Skill ===')
      expect(result.systemPromptSection).toContain('Follow these instructions carefully.')
    })

    it('formats compact skill', () => {
      const skill = makeSkill({ instructions: 'Y'.repeat(500) })
      const result = projector.project([skill], 'codex', { format: 'compact' })

      expect(result.systemPromptSection).toContain('=== Test Skill ===')
      expect(result.systemPromptSection).toContain('...')
    })

    it('formats minimal skill as bracketed name', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'codex', { format: 'minimal' })

      expect(result.systemPromptSection).toContain('[Test Skill] A skill for testing')
    })
  })

  // -----------------------------------------------------------------------
  // Gemini formatting
  // -----------------------------------------------------------------------

  describe('gemini provider', () => {
    it('formats detailed skill with XML tags', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'gemini')

      expect(result.systemPromptSection).toContain('<skills>')
      expect(result.systemPromptSection).toContain('</skills>')
      expect(result.systemPromptSection).toContain('<skill name="Test Skill">')
      expect(result.systemPromptSection).toContain('<description>A skill for testing</description>')
      expect(result.systemPromptSection).toContain('<instructions>')
      expect(result.systemPromptSection).toContain('Follow these instructions carefully.')
      expect(result.systemPromptSection).toContain('</instructions>')
    })

    it('formats compact skill with truncated instructions', () => {
      const skill = makeSkill({ instructions: 'Z'.repeat(500) })
      const result = projector.project([skill], 'gemini', { format: 'compact' })

      expect(result.systemPromptSection).toContain('<instructions>')
      expect(result.systemPromptSection).toContain('...')
    })

    it('formats minimal skill as self-closing XML', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'gemini', { format: 'minimal' })

      expect(result.systemPromptSection).toContain('<skill name="Test Skill">A skill for testing</skill>')
      expect(result.systemPromptSection).not.toContain('<instructions>')
    })
  })

  // -----------------------------------------------------------------------
  // Generic formatting (qwen, crush, goose, openrouter)
  // -----------------------------------------------------------------------

  describe('generic provider (qwen, crush, goose, openrouter)', () => {
    it('formats detailed skill with markdown for qwen', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'qwen')

      expect(result.systemPromptSection).toContain('# Skills')
      expect(result.systemPromptSection).toContain('## Test Skill')
      expect(result.systemPromptSection).toContain('Follow these instructions carefully.')
    })

    it('formats detailed skill with markdown for crush', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'crush')

      expect(result.systemPromptSection).toContain('# Skills')
      expect(result.systemPromptSection).toContain('## Test Skill')
    })

    it('formats detailed skill with markdown for goose', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'goose')

      expect(result.systemPromptSection).toContain('# Skills')
    })

    it('formats detailed skill with markdown for openrouter', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'openrouter')

      expect(result.systemPromptSection).toContain('# Skills')
    })

    it('formats minimal skill as dash-prefixed list', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'qwen', { format: 'minimal' })

      expect(result.systemPromptSection).toContain('- Test Skill: A skill for testing')
      expect(result.systemPromptSection).not.toContain('Follow these instructions')
    })
  })

  // -----------------------------------------------------------------------
  // Tool collection
  // -----------------------------------------------------------------------

  describe('tool collection', () => {
    it('collects required tools from all skills', () => {
      const skills = [
        makeSkill({ id: 'a', requiredTools: ['read_file', 'write_file'] }),
        makeSkill({ id: 'b', requiredTools: ['exec_command', 'read_file'] }),
      ]
      const result = projector.project(skills, 'claude')

      expect(result.requiredTools).toEqual(['read_file', 'write_file', 'exec_command'])
    })

    it('deduplicates tools across skills', () => {
      const skills = [
        makeSkill({ id: 'a', requiredTools: ['tool_a'] }),
        makeSkill({ id: 'b', requiredTools: ['tool_a'] }),
      ]
      const result = projector.project(skills, 'claude')

      expect(result.requiredTools).toEqual(['tool_a'])
    })

    it('handles skills with no requiredTools', () => {
      const skill = makeSkill({ requiredTools: undefined })
      const result = projector.project([skill], 'claude')

      expect(result.requiredTools).toEqual([])
    })

    it('omits tools when includeTools is false', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'claude', { includeTools: false })

      expect(result.requiredTools).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------

  describe('truncation', () => {
    it('truncates output to maxInstructionLength', () => {
      const skill = makeSkill({ instructions: 'A'.repeat(2000) })
      const result = projector.project([skill], 'claude', { maxInstructionLength: 100 })

      expect(result.systemPromptSection.length).toBe(100)
      expect(result.systemPromptSection).toMatch(/\.\.\.$/u)
    })

    it('does not truncate when within limit', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'claude', { maxInstructionLength: 50_000 })

      expect(result.systemPromptSection).not.toContain('...')
    })

    it('uses default maxInstructionLength of 10000', () => {
      const skills = makeSkills(50) // Many skills to exceed 10k
      // Give each skill long instructions
      for (const s of skills) {
        s.instructions = 'W'.repeat(500)
      }
      const result = projector.project(skills, 'claude')

      expect(result.systemPromptSection.length).toBeLessThanOrEqual(10_000)
    })
  })

  // -----------------------------------------------------------------------
  // applyToInput
  // -----------------------------------------------------------------------

  describe('applyToInput', () => {
    it('prepends projection to existing system prompt', () => {
      const input: AgentInput = {
        prompt: 'Do something',
        systemPrompt: 'Be helpful.',
      }
      const projection: SkillProjection = {
        systemPromptSection: '# Skills\n\nSome skills here.',
        requiredTools: [],
        skillCount: 1,
      }
      const result = projector.applyToInput(input, projection)

      expect(result.systemPrompt).toBe('# Skills\n\nSome skills here.\n\n---\n\nBe helpful.')
      expect(result.prompt).toBe('Do something')
    })

    it('sets system prompt when none exists', () => {
      const input: AgentInput = { prompt: 'Do something' }
      const projection: SkillProjection = {
        systemPromptSection: '# Skills\n\nContent.',
        requiredTools: [],
        skillCount: 1,
      }
      const result = projector.applyToInput(input, projection)

      expect(result.systemPrompt).toBe('# Skills\n\nContent.')
    })

    it('returns input unchanged when projection is empty', () => {
      const input: AgentInput = {
        prompt: 'Do something',
        systemPrompt: 'Original.',
      }
      const projection: SkillProjection = {
        systemPromptSection: '',
        requiredTools: [],
        skillCount: 0,
      }
      const result = projector.applyToInput(input, projection)

      expect(result).toBe(input) // Same reference
    })

    it('preserves all other AgentInput fields', () => {
      const signal = new AbortController().signal
      const input: AgentInput = {
        prompt: 'Do something',
        systemPrompt: 'Original.',
        workingDirectory: '/tmp',
        maxTurns: 5,
        maxBudgetUsd: 1.5,
        signal,
      }
      const projection: SkillProjection = {
        systemPromptSection: '# Skills',
        requiredTools: [],
        skillCount: 1,
      }
      const result = projector.applyToInput(input, projection)

      expect(result.workingDirectory).toBe('/tmp')
      expect(result.maxTurns).toBe(5)
      expect(result.maxBudgetUsd).toBe(1.5)
      expect(result.signal).toBe(signal)
    })
  })

  // -----------------------------------------------------------------------
  // Multiple skills
  // -----------------------------------------------------------------------

  describe('multiple skills', () => {
    it('includes all skills in projection', () => {
      const skills = makeSkills(3)
      const result = projector.project(skills, 'claude')

      expect(result.skillCount).toBe(3)
      expect(result.systemPromptSection).toContain('Skill 0')
      expect(result.systemPromptSection).toContain('Skill 1')
      expect(result.systemPromptSection).toContain('Skill 2')
    })

    it('collects all unique tools from multiple skills', () => {
      const skills = makeSkills(3)
      const result = projector.project(skills, 'codex')

      expect(result.requiredTools).toEqual(['tool_0', 'tool_1', 'tool_2'])
    })
  })

  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------

  describe('default options', () => {
    it('defaults to detailed format', () => {
      const skill = makeSkill()
      const result = projector.project([skill], 'claude')

      // Detailed claude format includes full instructions with double newline separators
      expect(result.systemPromptSection).toContain('## Test Skill\n\nA skill for testing\n\nFollow these instructions')
    })

    it('defaults to including tools', () => {
      const skill = makeSkill({ requiredTools: ['my_tool'] })
      const result = projector.project([skill], 'claude')

      expect(result.requiredTools).toEqual(['my_tool'])
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles skill with empty instructions', () => {
      const skill = makeSkill({ instructions: '' })
      const result = projector.project([skill], 'claude')

      expect(result.skillCount).toBe(1)
      expect(result.systemPromptSection).toContain('Test Skill')
    })

    it('handles readonly array input', () => {
      const skills: readonly SkillRegistryEntry[] = Object.freeze([makeSkill()])
      const result = projector.project(skills, 'claude')

      expect(result.skillCount).toBe(1)
    })

    it('handles maxInstructionLength exactly matching content', () => {
      const skill = makeSkill({ instructions: 'short' })
      const detailedResult = projector.project([skill], 'claude', {
        maxInstructionLength: 100_000,
      })
      const exactLen = detailedResult.systemPromptSection.length
      const result = projector.project([skill], 'claude', {
        maxInstructionLength: exactLen,
      })

      expect(result.systemPromptSection).toBe(detailedResult.systemPromptSection)
      expect(result.systemPromptSection).not.toContain('...')
    })
  })
})
