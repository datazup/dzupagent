/**
 * Multi-provider importer tests: Gemini, Qwen, Goose, Crush
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DzupAgentImporter } from '../dzupagent/importer.js'
import type { DzupAgentPaths } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaths(projectRoot: string): DzupAgentPaths {
  const projectDir = join(projectRoot, '.dzupagent')
  return {
    globalDir: join(projectRoot, '..', '.dzupagent-global'),
    workspaceDir: undefined,
    projectDir,
    stateFile: join(projectDir, 'state.json'),
    projectConfig: join(projectDir, 'config.json'),
  }
}

async function makeTestDir(): Promise<string> {
  const dir = join(tmpdir(), `dzup-importer-mp-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgentImporter — multi-provider', () => {
  let root: string
  let paths: DzupAgentPaths
  let importer: DzupAgentImporter

  beforeEach(async () => {
    root = await makeTestDir()
    paths = makePaths(root)
    importer = new DzupAgentImporter({ paths, projectRoot: root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Gemini
  // ---------------------------------------------------------------------------

  describe('Gemini', () => {
    it('discovers and imports GEMINI.md as gemini-project-context.md', async () => {
      await writeFile(join(root, 'GEMINI.md'), '# Gemini project context')

      const plan = await importer.planImport()

      expect(plan.toImport).toHaveLength(1)
      expect(plan.toImport[0]!.source.type).toBe('gemini-md')
      expect(plan.toImport[0]!.targetPath).toContain('gemini-project-context.md')
    })

    it('imports GEMINI.md with correct frontmatter', async () => {
      await writeFile(join(root, 'GEMINI.md'), '# Gemini project\n\nSome context.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'memory', 'gemini-project-context.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: gemini-project-context')
      expect(written).toContain('type: project')
      expect(written).toContain('importedFrom: GEMINI.md')
      expect(written).toContain('# Gemini project')
    })

    it('imports .gemini/settings.json wrapped in a JSON code block', async () => {
      const geminiDir = join(root, '.gemini')
      await mkdir(geminiDir, { recursive: true })
      const settings = JSON.stringify({ model: 'gemini-2.0-flash', temperature: 0.7 }, null, 2)
      await writeFile(join(geminiDir, 'settings.json'), settings)

      const plan = await importer.planImport()
      const geminiPlan = plan.toImport.find((e) => e.source.type === 'gemini-settings')

      expect(geminiPlan).toBeDefined()
      expect(geminiPlan!.targetPath).toContain('gemini-settings.json')

      await importer.executeImport(plan)

      const written = await readFile(geminiPlan!.targetPath, 'utf-8')
      expect(written).toContain('name: gemini-settings')
      expect(written).toContain('type: config')
      expect(written).toContain('importedFrom: .gemini/settings.json')
      expect(written).toContain('```json')
      expect(written).toContain('"model"')
    })
  })

  // ---------------------------------------------------------------------------
  // Qwen
  // ---------------------------------------------------------------------------

  describe('Qwen', () => {
    it('discovers and imports QWEN.md as qwen-project-context.md', async () => {
      await writeFile(join(root, 'QWEN.md'), '# Qwen project context')

      const plan = await importer.planImport()

      expect(plan.toImport).toHaveLength(1)
      expect(plan.toImport[0]!.source.type).toBe('qwen-md')
      expect(plan.toImport[0]!.targetPath).toContain('qwen-project-context.md')
    })

    it('imports QWEN.md with correct frontmatter', async () => {
      await writeFile(join(root, 'QWEN.md'), '# Qwen instructions\n\nDo things.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'memory', 'qwen-project-context.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: qwen-project-context')
      expect(written).toContain('type: project')
      expect(written).toContain('importedFrom: QWEN.md')
    })

    it('discovers and imports .qwen/skills/*.md as skills', async () => {
      const skillsDir = join(root, '.qwen', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'translate.md'), 'Translate text between languages.')
      await writeFile(join(skillsDir, 'summarise.md'), 'Summarise long documents.')

      const plan = await importer.planImport()

      const skillEntries = plan.toImport.filter((e) => e.source.type === 'qwen-skills')
      expect(skillEntries).toHaveLength(2)

      const names = skillEntries.map((e) => e.targetPath)
      expect(names.some((p) => p.endsWith('translate.md'))).toBe(true)
      expect(names.some((p) => p.endsWith('summarise.md'))).toBe(true)
    })

    it('imports .qwen/skills/ files with correct frontmatter', async () => {
      const skillsDir = join(root, '.qwen', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'translate.md'), 'Translate text.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'skills', 'translate.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: translate')
      expect(written).toContain('importedFrom: .qwen/skills/translate.md')
      expect(written).toContain('Translate text.')
    })

    it('discovers and imports .qwen/agents/*.md as agents', async () => {
      const agentsDir = join(root, '.qwen', 'agents')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(join(agentsDir, 'reviewer.md'), 'Review code carefully.')

      const plan = await importer.planImport()

      const agentEntries = plan.toImport.filter((e) => e.source.type === 'qwen-agents')
      expect(agentEntries).toHaveLength(1)
      expect(agentEntries[0]!.targetPath).toContain('agents/reviewer.md')
    })

    it('imports .qwen/agents/ files with correct frontmatter', async () => {
      const agentsDir = join(root, '.qwen', 'agents')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(join(agentsDir, 'reviewer.md'), 'Review code carefully.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'agents', 'reviewer.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: reviewer')
      expect(written).toContain('importedFrom: .qwen/agents/reviewer.md')
    })
  })

  // ---------------------------------------------------------------------------
  // Goose
  // ---------------------------------------------------------------------------

  describe('Goose', () => {
    it('discovers .goosehints and imports it as a memory file', async () => {
      await writeFile(join(root, '.goosehints'), 'Always check test coverage before merging.')

      const plan = await importer.planImport()

      expect(plan.toImport).toHaveLength(1)
      expect(plan.toImport[0]!.source.type).toBe('goose-hints')
      expect(plan.toImport[0]!.targetPath).toContain('goose-hints.md')
    })

    it('imports .goosehints with correct frontmatter', async () => {
      await writeFile(join(root, '.goosehints'), 'Always check test coverage.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'memory', 'goose-hints.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: goose-hints')
      expect(written).toContain('type: project')
      expect(written).toContain('importedFrom: .goosehints')
      expect(written).toContain('Always check test coverage.')
    })
  })

  // ---------------------------------------------------------------------------
  // Crush
  // ---------------------------------------------------------------------------

  describe('Crush', () => {
    it('discovers and imports .crush/skills/*.md as skills', async () => {
      const skillsDir = join(root, '.crush', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'deploy.md'), 'Run the deployment pipeline.')

      const plan = await importer.planImport()

      const skillEntries = plan.toImport.filter((e) => e.source.type === 'crush-skills')
      expect(skillEntries).toHaveLength(1)
      expect(skillEntries[0]!.targetPath).toContain('skills/deploy.md')
    })

    it('imports .crush/skills/ files with correct frontmatter', async () => {
      const skillsDir = join(root, '.crush', 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'deploy.md'), 'Run the deployment pipeline.')

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'skills', 'deploy.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: deploy')
      expect(written).toContain('importedFrom: .crush/skills/deploy.md')
      expect(written).toContain('Run the deployment pipeline.')
    })

    it('preserves existing frontmatter in .crush/skills/ files', async () => {
      const skillsDir = join(root, '.crush', 'skills')
      await mkdir(skillsDir, { recursive: true })
      const content = '---\nname: my-deploy\ndescription: Custom deploy skill\n---\n\nRun it.'
      await writeFile(join(skillsDir, 'deploy.md'), content)

      const plan = await importer.planImport()
      await importer.executeImport(plan)

      const target = join(paths.projectDir, 'skills', 'deploy.md')
      const written = await readFile(target, 'utf-8')

      expect(written).toContain('name: my-deploy')
      expect(written).toContain('description: Custom deploy skill')
      expect(written).toContain('importedFrom: .crush/skills/deploy.md')
    })
  })

  // ---------------------------------------------------------------------------
  // Mixed-provider project
  // ---------------------------------------------------------------------------

  describe('Mixed-provider project', () => {
    it('discovers candidates from all 6 providers in one project', async () => {
      // Claude
      await writeFile(join(root, 'CLAUDE.md'), '# Claude context')
      // Codex
      await writeFile(join(root, 'AGENTS.md'), '# Agents context')
      // Gemini
      await writeFile(join(root, 'GEMINI.md'), '# Gemini context')
      // Qwen
      await writeFile(join(root, 'QWEN.md'), '# Qwen context')
      // Goose
      await writeFile(join(root, '.goosehints'), 'Goose hints')
      // Crush skill
      const crushDir = join(root, '.crush', 'skills')
      await mkdir(crushDir, { recursive: true })
      await writeFile(join(crushDir, 'lint.md'), 'Run linter')

      const plan = await importer.planImport()

      const types = plan.toImport.map((e) => e.source.type)
      expect(types).toContain('claude-md')
      expect(types).toContain('codex-agents-md')
      expect(types).toContain('gemini-md')
      expect(types).toContain('qwen-md')
      expect(types).toContain('goose-hints')
      expect(types).toContain('crush-skills')
      expect(plan.toImport.length).toBeGreaterThanOrEqual(6)
    })
  })
})
