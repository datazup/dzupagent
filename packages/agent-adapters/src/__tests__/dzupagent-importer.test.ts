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
  const dir = join(tmpdir(), `dzup-importer-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgentImporter', () => {
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

  // 1. planImport() detects CLAUDE.md as importable
  it('planImport() detects CLAUDE.md as importable', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Project\nSome instructions')

    const plan = await importer.planImport()

    expect(plan.toImport).toHaveLength(1)
    expect(plan.toImport[0]!.source.type).toBe('claude-md')
    expect(plan.toImport[0]!.targetPath).toContain('claude-project-context.md')
  })

  // 2. planImport() classifies existing target as toSkip
  it('planImport() classifies existing target as toSkip', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Project')
    // Pre-create the target
    const targetDir = join(paths.projectDir, 'memory')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'claude-project-context.md'), 'existing')

    const plan = await importer.planImport()

    expect(plan.toImport).toHaveLength(0)
    expect(plan.toSkip).toHaveLength(1)
    expect(plan.toSkip[0]!.reason).toBe('target already exists')
  })

  // 3. executeImport() writes CLAUDE.md with correct frontmatter transformation
  it('executeImport() writes CLAUDE.md with correct frontmatter', async () => {
    const originalContent = '# My Project\n\nDo this and that.'
    await writeFile(join(root, 'CLAUDE.md'), originalContent)

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const target = join(paths.projectDir, 'memory', 'claude-project-context.md')
    const written = await readFile(target, 'utf-8')

    expect(written).toContain('---')
    expect(written).toContain('name: claude-project-context')
    expect(written).toContain('type: project')
    expect(written).toContain('importedFrom: CLAUDE.md')
    expect(written).toContain(originalContent)
  })

  // 4. executeImport() writes .claude/commands/ file with importedFrom in frontmatter
  it('executeImport() writes .claude/commands/ file with importedFrom', async () => {
    const cmdDir = join(root, '.claude', 'commands')
    await mkdir(cmdDir, { recursive: true })
    await writeFile(join(cmdDir, 'deploy.md'), 'Run the deploy pipeline')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const target = join(paths.projectDir, 'skills', 'deploy.md')
    const written = await readFile(target, 'utf-8')

    expect(written).toContain('name: deploy')
    expect(written).toContain('importedFrom: .claude/commands/deploy.md')
    expect(written).toContain('Run the deploy pipeline')
  })

  // 5. .claude/commands/ file with existing frontmatter: importedFrom added, existing fields preserved
  it('preserves existing frontmatter and adds importedFrom', async () => {
    const cmdDir = join(root, '.claude', 'commands')
    await mkdir(cmdDir, { recursive: true })
    const content = `---\nname: custom-name\ndescription: My custom skill\nversion: 2\n---\n\nDo the thing.`
    await writeFile(join(cmdDir, 'my-skill.md'), content)

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const target = join(paths.projectDir, 'skills', 'my-skill.md')
    const written = await readFile(target, 'utf-8')

    // Existing fields preserved
    expect(written).toContain('name: custom-name')
    expect(written).toContain('description: My custom skill')
    expect(written).toContain('version: 2')
    // importedFrom added
    expect(written).toContain('importedFrom: .claude/commands/my-skill.md')
    // Body preserved
    expect(written).toContain('Do the thing.')
  })

  // 6. executeImport() creates .dzupagent/ subdirectories automatically
  it('executeImport() creates .dzupagent/ subdirectories automatically', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Readme')
    const agentsDir = join(root, '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'reviewer.md'), 'Review code')

    const plan = await importer.planImport()
    const results = await importer.executeImport(plan)

    // Both memory/ and agents/ dirs were created
    const writtenResults = results.filter((r) => r.written)
    expect(writtenResults).toHaveLength(2)

    // Verify files exist
    const memoryFile = join(paths.projectDir, 'memory', 'claude-project-context.md')
    const agentFile = join(paths.projectDir, 'agents', 'reviewer.md')
    const memContent = await readFile(memoryFile, 'utf-8')
    const agentContent = await readFile(agentFile, 'utf-8')
    expect(memContent).toContain('claude-project-context')
    expect(agentContent).toContain('importedFrom: .claude/agents/reviewer.md')
  })

  // 7. executeImport() updates state.json `files` key with source hash
  it('executeImport() updates state.json files key with source hash', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Project instructions')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { version: number; files: Record<string, { hash: string; importedAt: string }> }

    expect(state.version).toBe(1)
    const sourcePath = join(root, 'CLAUDE.md')
    expect(state.files[sourcePath]).toBeDefined()
    expect(state.files[sourcePath]!.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.files[sourcePath]!.importedAt).toBeTruthy()
  })

  // 8. detectDivergence() returns diverged: true after modifying source file
  it('detectDivergence() returns diverged: true after modifying source', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'original content')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    // Modify the source file
    await writeFile(join(root, 'CLAUDE.md'), 'modified content')

    const divergence = await importer.detectDivergence()

    expect(divergence).toHaveLength(1)
    expect(divergence[0]!.diverged).toBe(true)
    expect(divergence[0]!.source.type).toBe('claude-md')
  })

  // 9. Empty project: planImport() returns empty toImport and toSkip
  it('empty project returns empty plan', async () => {
    const plan = await importer.planImport()

    expect(plan.toImport).toHaveLength(0)
    expect(plan.toSkip).toHaveLength(0)
  })

  // 10. executeImport() preserves existing projections key in state.json
  it('executeImport() preserves existing projections key in state.json', async () => {
    // Pre-create state.json with projections data
    await mkdir(join(paths.projectDir), { recursive: true })
    const existingState = {
      version: 1,
      projections: { 'bundle-1::claude': [{ version: 1, hash: 'abc123' }] },
      files: {},
    }
    await writeFile(paths.stateFile, JSON.stringify(existingState, null, 2))

    await writeFile(join(root, 'CLAUDE.md'), '# Keep my projections')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { projections: Record<string, unknown>; files: Record<string, unknown> }

    // Projections preserved
    expect(state.projections['bundle-1::claude']).toBeDefined()
    // Files key populated
    const sourcePath = join(root, 'CLAUDE.md')
    expect(state.files[sourcePath]).toBeDefined()
  })

  // Bonus: .claude/memory/ files get proper frontmatter
  it('imports .claude/memory/ files with correct frontmatter', async () => {
    const memDir = join(root, '.claude', 'memory')
    await mkdir(memDir, { recursive: true })
    await writeFile(join(memDir, 'MEMORY.md'), 'Remember this')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const target = join(paths.projectDir, 'memory', 'MEMORY.md')
    const written = await readFile(target, 'utf-8')

    expect(written).toContain('name: MEMORY')
    expect(written).toContain('type: agent')
    expect(written).toContain('description: Claude agent-specific memory')
    expect(written).toContain('importedFrom: .claude/memory/MEMORY.md')
    expect(written).toContain('Remember this')
  })

  // P2-FIX-2: .gitignore tests
  it('executeImport() creates .gitignore with state.json entry when no .gitignore exists', async () => {
    await writeFile(join(root, 'CLAUDE.md'), '# Project')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const gitignore = await readFile(join(root, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.dzupagent/state.json')
  })

  it('executeImport() appends state.json entry to existing .gitignore without duplicating', async () => {
    // Pre-create .gitignore with existing content
    await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n')
    await writeFile(join(root, 'CLAUDE.md'), '# Project')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const gitignore = await readFile(join(root, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.dzupagent/state.json')
    expect(gitignore).toContain('node_modules/')

    // Run again — should not duplicate the entry
    const plan2 = await importer.planImport()
    await importer.executeImport(plan2)

    const gitignore2 = await readFile(join(root, '.gitignore'), 'utf-8')
    const matches = gitignore2.match(/\.dzupagent\/state\.json/g)
    expect(matches).toHaveLength(1)
  })

  // Bonus: AGENTS.md transformation
  it('imports AGENTS.md with codex frontmatter', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Codex agents config')

    const plan = await importer.planImport()
    await importer.executeImport(plan)

    const target = join(paths.projectDir, 'memory', 'codex-project-context.md')
    const written = await readFile(target, 'utf-8')

    expect(written).toContain('name: codex-project-context')
    expect(written).toContain('importedFrom: AGENTS.md')
    expect(written).toContain('type: project')
  })
})
