import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { DzupAgentSyncer } from '../dzupagent/syncer.js'
import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import { DzupAgentAgentLoader } from '../dzupagent/agent-loader.js'
import { AdapterSkillRegistry, createDefaultSkillRegistry } from '../skills/adapter-skill-registry.js'
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
  const dir = join(tmpdir(), `dzup-syncer-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

async function setupSyncer(root: string, paths: DzupAgentPaths): Promise<DzupAgentSyncer> {
  const fileLoader = new DzupAgentFileLoader({ paths })
  const registry: AdapterSkillRegistry = createDefaultSkillRegistry()
  const agentLoader = new DzupAgentAgentLoader({
    paths,
    skillLoader: fileLoader,
    skillRegistry: registry,
  })
  return new DzupAgentSyncer({
    paths,
    projectRoot: root,
    fileLoader,
    agentLoader,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgentSyncer', () => {
  let root: string
  let paths: DzupAgentPaths
  let syncer: DzupAgentSyncer

  beforeEach(async () => {
    root = await makeTestDir()
    paths = makePaths(root)
    syncer = await setupSyncer(root, paths)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // 1. planSync('claude') produces correct target paths for skills and agents
  it('planSync produces correct target paths for skills and agents', async () => {
    // Create a skill definition
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // Create an agent definition
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'reviewer.md'), '---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Persona\nYou review code.')

    const plan = await syncer.planSync('claude')

    expect(plan.target).toBe('claude')
    expect(plan.toWrite.length).toBeGreaterThanOrEqual(2)

    const targetPaths = plan.toWrite.map((e) => e.targetPath)
    expect(targetPaths).toContain(join(root, '.claude', 'commands', 'deploy.md'))
    expect(targetPaths).toContain(join(root, '.claude', 'agents', 'reviewer.md'))
  })

  // 2. executeSync() writes .claude/commands/<name>.md with correct content
  it('executeSync writes command file with correct content', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun the linter')

    const plan = await syncer.planSync('claude')
    await syncer.executeSync(plan)

    const written = await readFile(join(root, '.claude', 'commands', 'lint.md'), 'utf-8')
    expect(written).toContain('---')
    expect(written).toContain('description: lint')
    expect(written).toContain('Run the linter')
  })

  // 3. renderClaudeCommand produces YAML frontmatter + body format
  it('renderClaudeCommand produces frontmatter + body', () => {
    const rendered = syncer.renderClaudeCommand({
      bundleId: 'test-skill',
      skillSetId: 'test-skill',
      skillSetVersion: '1',
      constraints: {},
      promptSections: [
        { id: 'task', purpose: 'task', content: 'Do the task.', priority: 4 },
        { id: 'persona', purpose: 'persona', content: 'You are an expert.', priority: 1 },
      ],
      toolBindings: [],
      metadata: { owner: 'alice', createdAt: '', updatedAt: '' },
    })

    expect(rendered).toMatch(/^---\n/)
    expect(rendered).toContain('description: test-skill (by alice)')
    // Persona (priority 1) should come before task (priority 4)
    const personaIdx = rendered.indexOf('You are an expert.')
    const taskIdx = rendered.indexOf('Do the task.')
    expect(personaIdx).toBeLessThan(taskIdx)
  })

  // 4. renderClaudeAgent produces correct agent format
  it('renderClaudeAgent produces correct format', () => {
    const rendered = syncer.renderClaudeAgent({
      name: 'reviewer',
      description: 'Code reviewer agent',
      version: 1,
      skillNames: [],
      memoryScope: 'project',
      constraints: {},
      personaPrompt: 'You carefully review code for bugs.',
      filePath: '/fake/path',
    })

    expect(rendered).toMatch(/^---\n/)
    expect(rendered).toContain('description: Code reviewer agent')
    expect(rendered).toContain('You carefully review code for bugs.')
  })

  // 5. Divergence detection: modify native file after sync, next planSync reports diverged
  it('detects divergence after user edits native file', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // First sync
    const plan1 = await syncer.planSync('claude')
    await syncer.executeSync(plan1)

    // User edits the native file
    const nativePath = join(root, '.claude', 'commands', 'deploy.md')
    await writeFile(nativePath, 'User edited this file manually.')

    // Need fresh syncer to avoid loader cache
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('claude')

    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(nativePath)
    expect(plan2.toWrite).toHaveLength(0)
  })

  // 6. executeSync skips diverged files
  it('executeSync skips diverged files', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // First sync
    const plan1 = await syncer.planSync('claude')
    await syncer.executeSync(plan1)

    // User edits the native file
    const nativePath = join(root, '.claude', 'commands', 'deploy.md')
    const userContent = 'User edited this file manually.'
    await writeFile(nativePath, userContent)

    // Second sync
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('claude')
    const result = await syncer.executeSync(plan2)

    // Diverged files are reported, not written
    expect(result.diverged).toHaveLength(1)
    expect(result.diverged[0]!.targetPath).toBe(nativePath)
    expect(result.diverged[0]!.divergenceType).toBe('content')
    expect(result.written).toHaveLength(0)

    // User's content is preserved
    const afterSync = await readFile(nativePath, 'utf-8')
    expect(afterSync).toBe(userContent)
  })

  // 7. state.json updated with hashes after executeSync
  it('state.json updated with sync hashes', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'build.md'), '---\nname: build\n---\n\n## Task\nRun build')

    const plan = await syncer.planSync('claude')
    await syncer.executeSync(plan)

    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { sync: Record<string, { lastSyncHash: string; syncedAt: string }> }

    const targetPath = join(root, '.claude', 'commands', 'build.md')
    expect(state.sync[targetPath]).toBeDefined()
    expect(state.sync[targetPath]!.lastSyncHash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.sync[targetPath]!.syncedAt).toBeTruthy()

    // Verify hash matches actual file content
    const fileContent = await readFile(targetPath, 'utf-8')
    expect(state.sync[targetPath]!.lastSyncHash).toBe(sha256(fileContent))
  })

  // 8. Empty .dzupagent/skills/: sync produces empty toWrite
  it('empty skills directory produces empty plan', async () => {
    // Don't create any skill or agent files
    const plan = await syncer.planSync('claude')

    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
  })

  // 9. planSync('codex') returns empty plan with warnings
  it("planSync('codex') returns empty plan with warnings", async () => {
    const plan = await syncer.planSync('codex')

    expect(plan.target).toBe('codex')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
    expect(plan.warnings).toBeDefined()
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings![0]).toContain('Codex sync is not yet implemented')
  })

  // 10. state.json preserves existing projections and files keys
  it('executeSync preserves existing projections and files in state.json', async () => {
    // Pre-create state.json with projections and files data
    await mkdir(paths.projectDir, { recursive: true })
    const existingState = {
      version: 1,
      projections: { 'bundle-1::claude': [{ version: 1, hash: 'abc123' }] },
      files: { '/some/file': { hash: 'def456', importedAt: '2025-01-01' } },
      sync: {},
    }
    await writeFile(paths.stateFile, JSON.stringify(existingState, null, 2))

    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'test.md'), '---\nname: test\n---\n\n## Task\nTest task')

    const plan = await syncer.planSync('claude')
    await syncer.executeSync(plan)

    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as {
      projections: Record<string, unknown>
      files: Record<string, unknown>
      sync: Record<string, unknown>
    }

    // Projections preserved
    expect(state.projections['bundle-1::claude']).toBeDefined()
    // Files preserved
    expect(state.files['/some/file']).toBeDefined()
    // Sync key populated
    const targetPath = join(root, '.claude', 'commands', 'test.md')
    expect(state.sync[targetPath]).toBeDefined()
  })
})
