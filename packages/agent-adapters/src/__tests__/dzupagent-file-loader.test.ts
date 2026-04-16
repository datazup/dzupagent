import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import type { DzupAgentPaths } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePaths(base: string): DzupAgentPaths {
  return {
    globalDir: join(base, 'global'),
    workspaceDir: undefined,
    projectDir: join(base, 'project'),
    stateFile: join(base, 'project', '.dzupagent', 'state.json'),
    projectConfig: join(base, 'project', '.dzupagent', 'config.json'),
  }
}

async function makeTestDir(): Promise<string> {
  const dir = join(tmpdir(), `dzup-test-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const SKILL_CONTENT = `---
name: code-reviewer
description: Review code for quality
version: 1
owner: test-team
constraints:
  maxBudgetUsd: 0.5
  approvalMode: auto
tools:
  required: [read_file]
  blocked: [exec_command]
---

## Persona
You are a code reviewer.

## Task
Review the diff for correctness.
`

const SKILL_CONTENT_2 = `---
name: security-checker
description: Check for security issues
version: 1
owner: security-team
---

## Task
Scan for OWASP top 10.
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgentFileLoader', () => {
  let testDir: string
  let paths: DzupAgentPaths
  let loader: DzupAgentFileLoader

  beforeEach(async () => {
    testDir = await makeTestDir()
    paths = makePaths(testDir)
    loader = new DzupAgentFileLoader({ paths })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('returns empty array when skills directory does not exist', async () => {
    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(0)
  })

  it('loads skills from project directory', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.bundleId).toBe('code-reviewer')
    expect(bundles[0]!.constraints.maxBudgetUsd).toBe(0.5)
    expect(bundles[0]!.constraints.approvalMode).toBe('auto')
    expect(bundles[0]!.toolBindings).toContainEqual({ toolName: 'read_file', mode: 'required' })
    expect(bundles[0]!.toolBindings).toContainEqual({ toolName: 'exec_command', mode: 'blocked' })
  })

  it('loads skills from global directory', async () => {
    const globalSkillsDir = join(paths.globalDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await writeFile(join(globalSkillsDir, 'security-checker.md'), SKILL_CONTENT_2)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.bundleId).toBe('security-checker')
  })

  it('project skill overrides global skill with same name', async () => {
    const globalSkillsDir = join(paths.globalDir, 'skills')
    const projectSkillsDir = join(paths.projectDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await mkdir(projectSkillsDir, { recursive: true })

    const globalContent = SKILL_CONTENT.replace('owner: test-team', 'owner: global-team')
    const projectContent = SKILL_CONTENT.replace('owner: test-team', 'owner: project-team')

    await writeFile(join(globalSkillsDir, 'code-reviewer.md'), globalContent)
    await writeFile(join(projectSkillsDir, 'code-reviewer.md'), projectContent)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.metadata.owner).toBe('project-team')
  })

  it('loads multiple skills from both directories', async () => {
    const globalSkillsDir = join(paths.globalDir, 'skills')
    const projectSkillsDir = join(paths.projectDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await mkdir(projectSkillsDir, { recursive: true })

    await writeFile(join(globalSkillsDir, 'security-checker.md'), SKILL_CONTENT_2)
    await writeFile(join(projectSkillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(2)
    const ids = bundles.map((b) => b.bundleId).sort()
    expect(ids).toEqual(['code-reviewer', 'security-checker'])
  })

  it('caches results by mtime — no re-read on second call', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    const first = await loader.loadSkills()
    const second = await loader.loadSkills()

    // Same object identity proves cache hit (no re-parse)
    expect(first[0]).toBe(second[0])
  })

  it('invalidateCache() causes re-read on next call', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    await loader.loadSkills()
    loader.invalidateCache()

    const updated = SKILL_CONTENT.replace('version: 1', 'version: 2')
    await writeFile(join(skillsDir, 'code-reviewer.md'), updated)

    const bundles = await loader.loadSkills()
    expect(bundles[0]!.skillSetVersion).toBe('2')
  })

  it('loadSkill() returns undefined for unknown name', async () => {
    const result = await loader.loadSkill('does-not-exist')
    expect(result).toBeUndefined()
  })

  it('loads skill body as task section when no headings', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const content = `---
name: simple-skill
---

Just do this thing without any section headings.
`
    await writeFile(join(skillsDir, 'simple-skill.md'), content)
    const bundles = await loader.loadSkills()
    expect(bundles[0]!.promptSections).toHaveLength(1)
    expect(bundles[0]!.promptSections[0]!.purpose).toBe('task')
    expect(bundles[0]!.promptSections[0]!.content).toContain('Just do this thing')
  })

  it('loads skills from workspace directory (between global and project)', async () => {
    const workspaceDir = join(testDir, 'workspace')
    paths = { ...paths, workspaceDir }
    loader = new DzupAgentFileLoader({ paths })

    const wsSkillsDir = join(workspaceDir, 'skills')
    await mkdir(wsSkillsDir, { recursive: true })
    await writeFile(join(wsSkillsDir, 'security-checker.md'), SKILL_CONTENT_2)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.bundleId).toBe('security-checker')
  })

  it('project skill overrides workspace skill with same name', async () => {
    const workspaceDir = join(testDir, 'workspace')
    paths = { ...paths, workspaceDir }
    loader = new DzupAgentFileLoader({ paths })

    const wsSkillsDir = join(workspaceDir, 'skills')
    const projectSkillsDir = join(paths.projectDir, 'skills')
    await mkdir(wsSkillsDir, { recursive: true })
    await mkdir(projectSkillsDir, { recursive: true })

    const wsContent = SKILL_CONTENT.replace('owner: test-team', 'owner: workspace-team')
    const projectContent = SKILL_CONTENT.replace('owner: test-team', 'owner: project-team')

    await writeFile(join(wsSkillsDir, 'code-reviewer.md'), wsContent)
    await writeFile(join(projectSkillsDir, 'code-reviewer.md'), projectContent)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.metadata.owner).toBe('project-team')
  })

  it('workspace skill overrides global skill with same name', async () => {
    const workspaceDir = join(testDir, 'workspace')
    paths = { ...paths, workspaceDir }
    loader = new DzupAgentFileLoader({ paths })

    const globalSkillsDir = join(paths.globalDir, 'skills')
    const wsSkillsDir = join(workspaceDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await mkdir(wsSkillsDir, { recursive: true })

    const globalContent = SKILL_CONTENT.replace('owner: test-team', 'owner: global-team')
    const wsContent = SKILL_CONTENT.replace('owner: test-team', 'owner: workspace-team')

    await writeFile(join(globalSkillsDir, 'code-reviewer.md'), globalContent)
    await writeFile(join(wsSkillsDir, 'code-reviewer.md'), wsContent)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.metadata.owner).toBe('workspace-team')
  })

  it('merges skills from all three tiers', async () => {
    const workspaceDir = join(testDir, 'workspace')
    paths = { ...paths, workspaceDir }
    loader = new DzupAgentFileLoader({ paths })

    const globalSkillsDir = join(paths.globalDir, 'skills')
    const wsSkillsDir = join(workspaceDir, 'skills')
    const projectSkillsDir = join(paths.projectDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await mkdir(wsSkillsDir, { recursive: true })
    await mkdir(projectSkillsDir, { recursive: true })

    // Each tier has a unique skill
    await writeFile(join(globalSkillsDir, 'security-checker.md'), SKILL_CONTENT_2)
    const wsSkill = `---\nname: ws-lint\n---\n\n## Task\nLint workspace.\n`
    await writeFile(join(wsSkillsDir, 'ws-lint.md'), wsSkill)
    await writeFile(join(projectSkillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    const bundles = await loader.loadSkills()
    const ids = bundles.map((b) => b.bundleId).sort()
    expect(ids).toEqual(['code-reviewer', 'security-checker', 'ws-lint'])
  })

  it('skips workspace tier when workspaceDir is undefined', async () => {
    // Default paths have workspaceDir: undefined — existing behavior
    const globalSkillsDir = join(paths.globalDir, 'skills')
    const projectSkillsDir = join(paths.projectDir, 'skills')
    await mkdir(globalSkillsDir, { recursive: true })
    await mkdir(projectSkillsDir, { recursive: true })

    await writeFile(join(globalSkillsDir, 'security-checker.md'), SKILL_CONTENT_2)
    await writeFile(join(projectSkillsDir, 'code-reviewer.md'), SKILL_CONTENT)

    const bundles = await loader.loadSkills()
    expect(bundles).toHaveLength(2)
  })

  it('parses all prompt section purposes correctly', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const content = `---
name: full-skill
---

## Persona
I am the persona.

## Style
This is the style.

## Safety
Safety rules here.

## Task
The main task.

## Review
How to review.

## Output
The output format.
`
    await writeFile(join(skillsDir, 'full-skill.md'), content)
    const bundles = await loader.loadSkills()
    const sections = bundles[0]!.promptSections

    const purposes = sections.map((s) => s.purpose)
    expect(purposes).toContain('persona')
    expect(purposes).toContain('style')
    expect(purposes).toContain('safety')
    expect(purposes).toContain('task')
    expect(purposes).toContain('review')
    expect(purposes).toContain('output')

    // Priorities should be sorted ascending
    const priorities = sections.map((s) => s.priority)
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  })
})
