import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SkillRegistry } from '../skills/skill-registry.js'
import {
  SkillDirectoryLoader,
  parseMarkdownSkill,
  parseJsonSkill,
} from '../skills/skill-directory-loader.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `skill-loader-test-${randomBytes(6).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeSkillMd(dir: string, name: string, content: string): string {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  const filePath = join(skillDir, 'SKILL.md')
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function writeSkillJson(dir: string, filename: string, obj: Record<string, unknown>): string {
  const filePath = join(dir, filename)
  writeFileSync(filePath, JSON.stringify(obj), 'utf-8')
  return filePath
}

// ---------------------------------------------------------------------------
// parseMarkdownSkill (unit)
// ---------------------------------------------------------------------------

describe('parseMarkdownSkill', () => {
  it('parses full frontmatter with all fields', () => {
    const md = [
      '---',
      'id: prisma-migration',
      'name: Prisma Migrations',
      'description: Run Prisma schema migrations',
      'category: database',
      'version: 1.2.0',
      'priority: 10',
      'tags: prisma, database, migration',
      'requiredTools: prisma_migrate prisma_generate',
      '---',
      '',
      '## Steps',
      '1. Run prisma migrate dev',
      '2. Verify schema',
    ].join('\n')

    const skill = parseMarkdownSkill(md)
    expect(skill).toBeDefined()
    expect(skill!.id).toBe('prisma-migration')
    expect(skill!.name).toBe('Prisma Migrations')
    expect(skill!.description).toBe('Run Prisma schema migrations')
    expect(skill!.category).toBe('database')
    expect(skill!.version).toBe('1.2.0')
    expect(skill!.priority).toBe(10)
    expect(skill!.tags).toEqual(['prisma', 'database', 'migration'])
    expect(skill!.requiredTools).toEqual(['prisma_migrate', 'prisma_generate'])
    expect(skill!.instructions).toContain('## Steps')
    expect(skill!.instructions).toContain('1. Run prisma migrate dev')
  })

  it('derives id from name when id is not provided', () => {
    const md = '---\nname: My Cool Skill\ndescription: Does stuff\n---\nInstructions here'
    const skill = parseMarkdownSkill(md)
    expect(skill!.id).toBe('my-cool-skill')
  })

  it('uses first heading as name when name is not in frontmatter', () => {
    const md = '---\nid: custom-id\n---\n# Auto Name\nSome instructions'
    const skill = parseMarkdownSkill(md)
    expect(skill!.name).toBe('Auto Name')
  })

  it('uses name as description when description is not provided', () => {
    const md = '---\nname: Simple Skill\n---\nInstructions'
    const skill = parseMarkdownSkill(md)
    expect(skill!.description).toBe('Simple Skill')
  })

  it('returns undefined when no name or heading is found', () => {
    const md = '---\nid: orphan\n---\nNo heading here'
    const skill = parseMarkdownSkill(md)
    expect(skill).toBeUndefined()
  })

  it('handles content without frontmatter (no --- delimiters)', () => {
    const md = '# Implicit Skill\n\nSome instructions here.'
    const skill = parseMarkdownSkill(md)
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('Implicit Skill')
    expect(skill!.instructions).toContain('# Implicit Skill')
  })

  it('handles empty content', () => {
    expect(parseMarkdownSkill('')).toBeUndefined()
  })

  it('handles tags with extra whitespace', () => {
    const md = '---\nname: X\ntags:  a ,  b  , c  \n---\nBody'
    const skill = parseMarkdownSkill(md)
    expect(skill!.tags).toEqual(['a', 'b', 'c'])
  })

  it('handles requiredTools with commas', () => {
    const md = '---\nname: X\nrequiredTools: tool_a, tool_b, tool_c\n---\nBody'
    const skill = parseMarkdownSkill(md)
    expect(skill!.requiredTools).toEqual(['tool_a', 'tool_b', 'tool_c'])
  })

  it('handles colons in values', () => {
    const md = '---\nname: X\ndescription: A tool: does things: well\n---\nBody'
    const skill = parseMarkdownSkill(md)
    expect(skill!.description).toBe('A tool: does things: well')
  })

  it('strips special chars from derived id', () => {
    const md = '---\nname: My (Cool) Skill!!\n---\nBody'
    const skill = parseMarkdownSkill(md)
    expect(skill!.id).toBe('my-cool-skill')
  })

  it('handles NaN priority gracefully', () => {
    const md = '---\nname: X\npriority: not-a-number\n---\nBody'
    const skill = parseMarkdownSkill(md)
    expect(skill!.priority).toBeUndefined()
  })

  it('omits optional fields when not provided', () => {
    const md = '---\nname: Minimal\n---\nJust instructions'
    const skill = parseMarkdownSkill(md)
    expect(skill!.category).toBeUndefined()
    expect(skill!.version).toBeUndefined()
    expect(skill!.tags).toBeUndefined()
    expect(skill!.requiredTools).toBeUndefined()
    expect(skill!.priority).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseJsonSkill (unit)
// ---------------------------------------------------------------------------

describe('parseJsonSkill', () => {
  it('parses valid JSON with all fields', () => {
    const json = JSON.stringify({
      id: 'json-skill',
      name: 'JSON Skill',
      description: 'Loaded from JSON',
      instructions: 'Follow these steps.',
      category: 'testing',
      version: '2.0.0',
      priority: 5,
      tags: ['json', 'test'],
      requiredTools: ['tool_x'],
    })

    const skill = parseJsonSkill(json)
    expect(skill).toBeDefined()
    expect(skill!.id).toBe('json-skill')
    expect(skill!.name).toBe('JSON Skill')
    expect(skill!.description).toBe('Loaded from JSON')
    expect(skill!.instructions).toBe('Follow these steps.')
    expect(skill!.category).toBe('testing')
    expect(skill!.version).toBe('2.0.0')
    expect(skill!.priority).toBe(5)
    expect(skill!.tags).toEqual(['json', 'test'])
    expect(skill!.requiredTools).toEqual(['tool_x'])
  })

  it('returns undefined when id is missing', () => {
    const json = JSON.stringify({ name: 'No ID', instructions: 'x' })
    expect(parseJsonSkill(json)).toBeUndefined()
  })

  it('returns undefined when name is missing', () => {
    const json = JSON.stringify({ id: 'no-name', instructions: 'x' })
    expect(parseJsonSkill(json)).toBeUndefined()
  })

  it('returns undefined when instructions is missing', () => {
    const json = JSON.stringify({ id: 'no-instr', name: 'No Instr' })
    expect(parseJsonSkill(json)).toBeUndefined()
  })

  it('returns undefined for invalid JSON', () => {
    expect(parseJsonSkill('not json at all')).toBeUndefined()
  })

  it('uses name as description when description is missing', () => {
    const json = JSON.stringify({ id: 'x', name: 'X', instructions: 'body' })
    const skill = parseJsonSkill(json)
    expect(skill!.description).toBe('X')
  })

  it('filters non-string entries from tags array', () => {
    const json = JSON.stringify({ id: 'x', name: 'X', instructions: 'body', tags: ['valid', 42, null] })
    const skill = parseJsonSkill(json)
    expect(skill!.tags).toEqual(['valid'])
  })

  it('filters non-string entries from requiredTools array', () => {
    const json = JSON.stringify({
      id: 'x', name: 'X', instructions: 'body',
      requiredTools: ['tool_a', true, 'tool_b'],
    })
    const skill = parseJsonSkill(json)
    expect(skill!.requiredTools).toEqual(['tool_a', 'tool_b'])
  })

  it('ignores non-array tags', () => {
    const json = JSON.stringify({ id: 'x', name: 'X', instructions: 'body', tags: 'not-array' })
    const skill = parseJsonSkill(json)
    expect(skill!.tags).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SkillDirectoryLoader (integration with real filesystem)
// ---------------------------------------------------------------------------

describe('SkillDirectoryLoader', () => {
  let tmpDir: string
  let registry: SkillRegistry
  let loader: SkillDirectoryLoader

  beforeEach(() => {
    tmpDir = makeTmpDir()
    registry = new SkillRegistry()
    loader = new SkillDirectoryLoader(registry)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // loadFromDirectory
  // -----------------------------------------------------------------------

  describe('loadFromDirectory', () => {
    it('loads SKILL.md files from subdirectories', () => {
      writeSkillMd(tmpDir, 'prisma', [
        '---',
        'id: prisma',
        'name: Prisma',
        'description: ORM skill',
        '---',
        'Use prisma migrate dev.',
      ].join('\n'))

      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(1)
      expect(registry.size).toBe(1)
      expect(registry.get('prisma')!.name).toBe('Prisma')
    })

    it('loads .skill.json files', () => {
      writeSkillJson(tmpDir, 'vue.skill.json', {
        id: 'vue',
        name: 'Vue',
        description: 'Vue components',
        instructions: 'Build with Vue 3.',
      })

      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(1)
      expect(registry.get('vue')!.name).toBe('Vue')
    })

    it('loads both SKILL.md and .skill.json from same directory tree', () => {
      writeSkillMd(tmpDir, 'md-skill', '---\nname: MD Skill\n---\nBody')
      writeSkillJson(tmpDir, 'json.skill.json', {
        id: 'json-skill', name: 'JSON Skill', instructions: 'x',
      })

      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(2)
      expect(registry.size).toBe(2)
    })

    it('recursively scans nested directories', () => {
      const nested = join(tmpDir, 'level1', 'level2')
      mkdirSync(nested, { recursive: true })
      writeSkillMd(join(tmpDir, 'level1', 'level2'), 'deep', '---\nname: Deep Skill\n---\nDeep')

      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(1)
      expect(registry.has('deep-skill')).toBe(true)
    })

    it('returns 0 for non-existent directory', () => {
      expect(loader.loadFromDirectory('/non/existent/path')).toBe(0)
    })

    it('returns 0 for empty directory', () => {
      expect(loader.loadFromDirectory(tmpDir)).toBe(0)
    })

    it('skips invalid SKILL.md files', () => {
      writeSkillMd(tmpDir, 'bad', 'No frontmatter, no heading, nothing useful')
      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(0)
    })

    it('skips invalid .skill.json files', () => {
      writeSkillJson(tmpDir, 'bad.skill.json', { notValid: true } as Record<string, unknown>)
      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(0)
    })

    it('respects maxDepth option', () => {
      const deep = join(tmpDir, 'a', 'b', 'c', 'd')
      mkdirSync(deep, { recursive: true })
      writeSkillMd(deep, 'deep', '---\nname: Deep\n---\nBody')

      const shallowLoader = new SkillDirectoryLoader(registry, { maxDepth: 2 })
      const count = shallowLoader.loadFromDirectory(tmpDir)
      expect(count).toBe(0) // too deep
    })

    it('ignores non-.skill.json JSON files', () => {
      writeFileSync(join(tmpDir, 'other.json'), JSON.stringify({
        id: 'other', name: 'Other', instructions: 'x',
      }))
      const count = loader.loadFromDirectory(tmpDir)
      expect(count).toBe(0)
    })

    it('stores sourcePath for loaded skills', () => {
      const mdPath = writeSkillMd(tmpDir, 'sourced', '---\nname: Sourced\nid: sourced\n---\nBody')
      loader.loadFromDirectory(tmpDir)
      expect(registry.get('sourced')!.sourcePath).toBe(mdPath)
    })
  })

  // -----------------------------------------------------------------------
  // loadFromDirectories
  // -----------------------------------------------------------------------

  describe('loadFromDirectories', () => {
    it('loads from multiple directories', () => {
      const dir2 = makeTmpDir()
      try {
        writeSkillMd(tmpDir, 'skill-a', '---\nname: A\nid: a\n---\nBody')
        writeSkillMd(dir2, 'skill-b', '---\nname: B\nid: b\n---\nBody')

        const count = loader.loadFromDirectories([tmpDir, dir2])
        expect(count).toBe(2)
        expect(registry.size).toBe(2)
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    })

    it('handles mix of valid and invalid directories', () => {
      writeSkillMd(tmpDir, 'skill-x', '---\nname: X\nid: x\n---\nBody')
      const count = loader.loadFromDirectories([tmpDir, '/non/existent'])
      expect(count).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // loadMarkdownFile / loadJsonFile
  // -----------------------------------------------------------------------

  describe('loadMarkdownFile', () => {
    it('loads a single SKILL.md into registry', () => {
      const path = writeSkillMd(tmpDir, 'single', '---\nname: Single\nid: single\n---\nBody')
      expect(loader.loadMarkdownFile(path)).toBe(true)
      expect(registry.get('single')).toBeDefined()
    })

    it('returns false for non-existent file', () => {
      expect(loader.loadMarkdownFile('/nope/SKILL.md')).toBe(false)
    })

    it('returns false for unparseable file', () => {
      writeFileSync(join(tmpDir, 'bad.md'), '')
      expect(loader.loadMarkdownFile(join(tmpDir, 'bad.md'))).toBe(false)
    })
  })

  describe('loadJsonFile', () => {
    it('loads a single .skill.json into registry', () => {
      const path = writeSkillJson(tmpDir, 'test.skill.json', {
        id: 'json-test', name: 'JSON Test', instructions: 'x',
      })
      expect(loader.loadJsonFile(path)).toBe(true)
      expect(registry.get('json-test')).toBeDefined()
    })

    it('returns false for non-existent file', () => {
      expect(loader.loadJsonFile('/nope/test.skill.json')).toBe(false)
    })

    it('returns false for invalid JSON', () => {
      writeFileSync(join(tmpDir, 'broken.skill.json'), 'not json')
      expect(loader.loadJsonFile(join(tmpDir, 'broken.skill.json'))).toBe(false)
    })
  })
})
