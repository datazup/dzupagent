import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SkillManager } from '../skills/skill-manager.js'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn(async () => undefined)
const mockWriteFile = vi.fn(async () => undefined)
const mockRename = vi.fn(async () => undefined)
const mockReadFile = vi.fn(async (): Promise<string> => { throw new Error('ENOENT') })
const mockUnlink = vi.fn(async () => undefined)

vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}))

// ---------------------------------------------------------------------------
// Mock core content-sanitizer (replaces the previous @dzupagent/memory mock).
// ---------------------------------------------------------------------------

vi.mock('../security/content-sanitizer.js', () => ({
  scanContent: vi.fn((content: string) => {
    // Simple mock: content containing "INJECTION" is unsafe
    if (content.includes('INJECTION')) {
      return { safe: false, content, threats: ['injection_detected'] }
    }
    return { safe: true, content, threats: [] }
  }),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SKILLS_DIR = '/tmp/test-skills'

describe('SkillManager', () => {
  let manager: SkillManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SkillManager({ skillsDir: SKILLS_DIR })
  })

  // ---------------------------------------------------------------------------
  // shouldCreateSkill
  // ---------------------------------------------------------------------------

  describe('shouldCreateSkill', () => {
    it('returns true for novel patterns', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 1,
        fixIterations: 0,
        llmCalls: 1,
        novelPattern: true,
      })).toBe(true)
    })

    it('returns true for complex multi-phase tasks with fix iterations', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 4,
        fixIterations: 1,
        llmCalls: 5,
      })).toBe(true)
    })

    it('returns true for tasks with many LLM calls', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 1,
        fixIterations: 0,
        llmCalls: 8,
      })).toBe(true)
    })

    it('returns false for simple tasks', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 1,
        fixIterations: 0,
        llmCalls: 2,
      })).toBe(false)
    })

    it('returns false for moderate tasks below thresholds', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 3,
        fixIterations: 1,
        llmCalls: 5,
      })).toBe(false)
    })

    it('returns false when phases are high but no fix iterations', () => {
      expect(manager.shouldCreateSkill({
        phasesExecuted: 5,
        fixIterations: 0,
        llmCalls: 4,
      })).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('rejects invalid skill names', async () => {
      const result = await manager.create({
        name: 'INVALID NAME',
        description: 'test',
        body: 'content',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('must match')
    })

    it('rejects empty name', async () => {
      const result = await manager.create({
        name: '',
        description: 'test',
        body: 'content',
      })
      expect(result.ok).toBe(false)
    })

    it('rejects name exceeding 64 characters', async () => {
      const result = await manager.create({
        name: 'a'.repeat(65),
        description: 'test',
        body: 'content',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('1-64')
    })

    it('rejects content exceeding max length', async () => {
      const smallManager = new SkillManager({ skillsDir: SKILLS_DIR, maxContentLength: 50 })

      const result = await smallManager.create({
        name: 'big-skill',
        description: 'test',
        body: 'x'.repeat(100),
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('character limit')
    })

    it('rejects content that fails security scan', async () => {
      const result = await manager.create({
        name: 'bad-skill',
        description: 'test',
        body: 'This has INJECTION content',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Security scan failed')
    })

    it('rejects when skill already exists', async () => {
      // readFile succeeds = skill file exists
      mockReadFile.mockResolvedValueOnce('existing content')

      const result = await manager.create({
        name: 'existing-skill',
        description: 'test',
        body: 'content',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already exists')
    })

    it('creates skill with atomic write on success', async () => {
      const result = await manager.create({
        name: 'new-skill',
        description: 'A new skill',
        body: 'Do the thing.',
      })

      expect(result.ok).toBe(true)
      expect(result.path).toContain('new-skill')
      expect(result.path).toContain('SKILL.md')
      expect(mockMkdir).toHaveBeenCalled()
      expect(mockWriteFile).toHaveBeenCalled()
      expect(mockRename).toHaveBeenCalled()
    })

    it('includes frontmatter with optional fields', async () => {
      await manager.create({
        name: 'full-skill',
        description: 'Full description',
        compatibility: 'react,typescript',
        allowedTools: ['read_file', 'write_file'],
        body: 'Instructions here.',
      })

      // Check the written content includes frontmatter
      const writtenContent = mockWriteFile.mock.calls[0]?.[1] as string
      expect(writtenContent).toContain('name: full-skill')
      expect(writtenContent).toContain('description: Full description')
      expect(writtenContent).toContain('compatibility: react,typescript')
      expect(writtenContent).toContain('allowedTools: read_file write_file')
    })
  })

  // ---------------------------------------------------------------------------
  // edit
  // ---------------------------------------------------------------------------

  describe('edit', () => {
    it('rejects when skill does not exist', async () => {
      // readFile default throws ENOENT = skill does not exist
      const result = await manager.edit({
        name: 'missing-skill',
        description: 'test',
        body: 'new content',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('does not exist')
    })

    it('rewrites skill on success', async () => {
      mockReadFile.mockResolvedValueOnce('---\nname: existing\n---\n\nold content')

      const result = await manager.edit({
        name: 'existing',
        description: 'Updated',
        body: 'new content',
      })

      expect(result.ok).toBe(true)
      expect(mockWriteFile).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // patch
  // ---------------------------------------------------------------------------

  describe('patch', () => {
    it('replaces a unique substring', async () => {
      mockReadFile.mockResolvedValueOnce('---\nname: skill\n---\n\nHello world.')

      const result = await manager.patch('skill', {
        find: 'Hello',
        replace: 'Goodbye',
      })

      expect(result.ok).toBe(true)
      const writtenContent = mockWriteFile.mock.calls[0]?.[1] as string
      expect(writtenContent).toContain('Goodbye world.')
    })

    it('rejects when find string is not found', async () => {
      mockReadFile.mockResolvedValueOnce('---\nname: skill\n---\n\nOriginal content')

      const result = await manager.patch('skill', {
        find: 'nonexistent text',
        replace: 'replacement',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('rejects when find string matches multiple times', async () => {
      mockReadFile.mockResolvedValueOnce('aaa bbb aaa')

      const result = await manager.patch('skill', {
        find: 'aaa',
        replace: 'ccc',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('matched 2 times')
    })

    it('rejects when skill does not exist', async () => {
      // readFile default throws ENOENT
      const result = await manager.patch('missing', {
        find: 'x',
        replace: 'y',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('does not exist')
    })
  })

  // ---------------------------------------------------------------------------
  // readSkill
  // ---------------------------------------------------------------------------

  describe('readSkill', () => {
    it('parses a valid SKILL.md file', async () => {
      mockReadFile.mockResolvedValueOnce(
        '---\nname: my-skill\ndescription: Does things\ncompatibility: typescript\nallowedTools: read_file write_file\n---\n\nBody here',
      )

      const skill = await manager.readSkill('my-skill')

      expect(skill).toBeDefined()
      expect(skill!.name).toBe('my-skill')
      expect(skill!.description).toBe('Does things')
      expect(skill!.compatibility).toBe('typescript')
      expect(skill!.allowedTools).toEqual(['read_file', 'write_file'])
      expect(skill!.path).toContain(join(SKILLS_DIR, 'my-skill', 'SKILL.md'))
    })

    it('returns null when file does not exist', async () => {
      // readFile default throws ENOENT
      const skill = await manager.readSkill('missing')
      expect(skill).toBeNull()
    })

    it('returns null when content does not start with frontmatter', async () => {
      mockReadFile.mockResolvedValueOnce('No frontmatter here')

      const skill = await manager.readSkill('bad')
      expect(skill).toBeNull()
    })

    it('returns null when frontmatter is missing closing ---', async () => {
      mockReadFile.mockResolvedValueOnce('---\nname: test\nno closing marker')

      const skill = await manager.readSkill('bad2')
      expect(skill).toBeNull()
    })

    it('returns null when name is missing from frontmatter', async () => {
      mockReadFile.mockResolvedValueOnce('---\ndescription: test\n---\nbody')

      const skill = await manager.readSkill('no-name')
      expect(skill).toBeNull()
    })

    it('returns null when description is missing from frontmatter', async () => {
      mockReadFile.mockResolvedValueOnce('---\nname: test\n---\nbody')

      const skill = await manager.readSkill('no-desc')
      expect(skill).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // atomicWrite failure handling
  // ---------------------------------------------------------------------------

  describe('atomic write failure', () => {
    it('returns error when rename fails and cleans up temp file', async () => {
      // readFile default throws ENOENT = skill does not exist (good for create)
      mockRename.mockRejectedValueOnce(new Error('EXDEV'))

      const result = await manager.create({
        name: 'fail-rename',
        description: 'test',
        body: 'content',
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Atomic rename failed')
      expect(mockUnlink).toHaveBeenCalled()
    })
  })
})
