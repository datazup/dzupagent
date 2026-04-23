import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, readFile, rm, chmod, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { DzupAgentSyncer } from '../dzupagent/syncer.js'
import { DzupAgentImporter } from '../dzupagent/importer.js'
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

  // 9. planSync('qwen') produces correct target paths for skills and agents
  it("planSync('qwen') produces correct target paths for skills and agents", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'reviewer.md'), '---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Persona\nYou review code.')

    const plan = await syncer.planSync('qwen')

    expect(plan.target).toBe('qwen')
    expect(plan.toWrite.length).toBeGreaterThanOrEqual(2)

    const targetPaths = plan.toWrite.map((e) => e.targetPath)
    expect(targetPaths).toContain(join(root, '.qwen', 'skills', 'deploy.md'))
    expect(targetPaths).toContain(join(root, '.qwen', 'agents', 'reviewer.md'))
  })

  // 10. planSync('qwen') executeSync writes .qwen/skills/<name>.md with correct content
  it("planSync('qwen') executeSync writes skill file with correct content", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun the linter')

    const plan = await syncer.planSync('qwen')
    await syncer.executeSync(plan)

    const written = await readFile(join(root, '.qwen', 'skills', 'lint.md'), 'utf-8')
    expect(written).toContain('---')
    expect(written).toContain('description: lint')
    expect(written).toContain('Run the linter')
  })

  // 11. planSync('qwen') detects divergence after user edits native skill file
  it("planSync('qwen') detects divergence after user edits native file", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // First sync
    const plan1 = await syncer.planSync('qwen')
    await syncer.executeSync(plan1)

    // User edits the native file
    const nativePath = join(root, '.qwen', 'skills', 'deploy.md')
    await writeFile(nativePath, 'User edited this Qwen skill manually.')

    // Need fresh syncer to avoid loader cache
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('qwen')

    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(nativePath)
    expect(plan2.toWrite).toHaveLength(0)
  })

  // 12. planSync('qwen') state.json updated with hashes after executeSync
  it("planSync('qwen') state.json updated with sync hashes", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'build.md'), '---\nname: build\n---\n\n## Task\nRun build')

    const plan = await syncer.planSync('qwen')
    await syncer.executeSync(plan)

    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { sync: Record<string, { lastSyncHash: string; syncedAt: string }> }

    const targetPath = join(root, '.qwen', 'skills', 'build.md')
    expect(state.sync[targetPath]).toBeDefined()
    expect(state.sync[targetPath]!.lastSyncHash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.sync[targetPath]!.syncedAt).toBeTruthy()

    // Verify hash matches actual file content
    const fileContent = await readFile(targetPath, 'utf-8')
    expect(state.sync[targetPath]!.lastSyncHash).toBe(sha256(fileContent))
  })

  // 13. planSync('codex') no memory → empty plan
  it("planSync('codex') no memory files → empty plan", async () => {
    const plan = await syncer.planSync('codex')

    expect(plan.target).toBe('codex')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
    expect(plan.warnings).toBeUndefined()
  })

  // 14. planSync('codex') with memory → toWrite has AGENTS.md entry
  it("planSync('codex') memory files → writes AGENTS.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'context.md'), '---\nname: context\ntype: project\n---\n\nCodex project context here.')

    const plan = await syncer.planSync('codex')
    expect(plan.target).toBe('codex')
    expect(plan.toWrite).toHaveLength(1)
    expect(plan.toWrite[0]!.targetPath).toBe(join(root, 'AGENTS.md'))
    expect(plan.toWrite[0]!.content).toContain('Codex project context here.')
  })

  // 15. planSync('codex') executeSync writes AGENTS.md with correct content
  it("planSync('codex') executeSync writes AGENTS.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'rules.md'), '---\nname: rules\ntype: project\n---\n\nFollow these rules.')

    const plan = await syncer.planSync('codex')
    await syncer.executeSync(plan)

    const written = await readFile(join(root, 'AGENTS.md'), 'utf-8')
    expect(written).toContain('Follow these rules.')
  })

  // 16. planSync('codex') divergence after user edits AGENTS.md
  it("planSync('codex') detects divergence after user edits AGENTS.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'context.md'), '---\nname: context\ntype: project\n---\n\nInitial context.')

    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    await writeFile(join(root, 'AGENTS.md'), 'User manually edited AGENTS.md.')

    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('codex')
    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(join(root, 'AGENTS.md'))
    expect(plan2.toWrite).toHaveLength(0)
  })

  // 16b. planSync('codex') with skills → toWrite has .codex/skills/<id>/SKILL.md
  it("planSync('codex') skills → writes .codex/skills/<id>/SKILL.md", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'search.md'), '---\nname: search\n---\n\n## Task\nSearch the codebase')

    const plan = await syncer.planSync('codex')

    expect(plan.target).toBe('codex')
    const skillEntry = plan.toWrite.find((e) =>
      e.targetPath === join(root, '.codex', 'skills', 'search', 'SKILL.md'),
    )
    expect(skillEntry).toBeDefined()
    expect(skillEntry!.content).toContain('description: search')
    expect(skillEntry!.content).toContain('Search the codebase')
  })

  // 16c. planSync('codex') with both memory and skills → toWrite has both entries
  it("planSync('codex') memory + skills → writes AGENTS.md and .codex/skills/<id>/SKILL.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'ctx.md'), '---\nname: ctx\ntype: project\n---\n\nContext body.')

    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    const plan = await syncer.planSync('codex')

    const targetPaths = plan.toWrite.map((e) => e.targetPath)
    expect(targetPaths).toContain(join(root, 'AGENTS.md'))
    expect(targetPaths).toContain(join(root, '.codex', 'skills', 'deploy', 'SKILL.md'))
  })

  // 16d. planSync('codex') executeSync writes .codex/skills/<id>/SKILL.md with correct content
  it("planSync('codex') executeSync writes skill file to correct path", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun the linter')

    const plan = await syncer.planSync('codex')
    await syncer.executeSync(plan)

    const written = await readFile(join(root, '.codex', 'skills', 'lint', 'SKILL.md'), 'utf-8')
    expect(written).toContain('---')
    expect(written).toContain('description: lint')
    expect(written).toContain('Run the linter')
  })

  // 16e. planSync('codex') with no skills and no memory → empty plan (no regression)
  it("planSync('codex') no memory and no skills → empty plan", async () => {
    const plan = await syncer.planSync('codex')

    expect(plan.target).toBe('codex')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
  })

  // 16f. planSync('codex') with memory only → only instructions entry (no skills regression)
  it("planSync('codex') memory only → only AGENTS.md entry, no .codex/skills/ entries", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'ctx.md'), '---\nname: ctx\ntype: project\n---\n\nContext only.')

    const plan = await syncer.planSync('codex')

    expect(plan.toWrite).toHaveLength(1)
    expect(plan.toWrite[0]!.targetPath).toBe(join(root, 'AGENTS.md'))
    expect(plan.toWrite.some((e) => e.targetPath.includes('.codex/skills'))).toBe(false)
  })

  // 16g. planSync('codex') divergence detection for .codex/skills/<id>/SKILL.md
  it("planSync('codex') detects divergence after user edits .codex/skills/<id>/SKILL.md", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'review.md'), '---\nname: review\n---\n\n## Task\nReview the PR')

    // First sync
    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    // User edits the native file
    const nativePath = join(root, '.codex', 'skills', 'review', 'SKILL.md')
    await writeFile(nativePath, 'User edited this Codex skill manually.')

    // Fresh syncer to avoid loader cache
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('codex')

    const divergedEntry = plan2.diverged.find((d) => d.targetPath === nativePath)
    expect(divergedEntry).toBeDefined()
    expect(plan2.toWrite.some((e) => e.targetPath === nativePath)).toBe(false)
  })

  // 17. planSync('gemini') no memory → empty plan
  it("planSync('gemini') no memory files → empty plan", async () => {
    const plan = await syncer.planSync('gemini')

    expect(plan.target).toBe('gemini')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
  })

  // 18. planSync('gemini') with memory → toWrite has GEMINI.md entry
  it("planSync('gemini') memory files → writes GEMINI.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'guide.md'), '---\nname: guide\ntype: project\n---\n\nGemini project guide.')

    const plan = await syncer.planSync('gemini')
    expect(plan.target).toBe('gemini')
    expect(plan.toWrite).toHaveLength(1)
    expect(plan.toWrite[0]!.targetPath).toBe(join(root, 'GEMINI.md'))
    expect(plan.toWrite[0]!.content).toContain('Gemini project guide.')
  })

  // 19. planSync('gemini') divergence after user edits GEMINI.md
  it("planSync('gemini') detects divergence after user edits GEMINI.md", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'guide.md'), '---\nname: guide\ntype: project\n---\n\nGemini guide.')

    const plan1 = await syncer.planSync('gemini')
    await syncer.executeSync(plan1)

    await writeFile(join(root, 'GEMINI.md'), 'User manually edited GEMINI.md.')

    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('gemini')
    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(join(root, 'GEMINI.md'))
    expect(plan2.toWrite).toHaveLength(0)
  })

  // 20. planSync('goose') no memory → empty plan
  it("planSync('goose') no memory files → empty plan", async () => {
    const plan = await syncer.planSync('goose')

    expect(plan.target).toBe('goose')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
  })

  // 21. planSync('goose') with memory → toWrite has .goosehints entry
  it("planSync('goose') memory files → writes .goosehints", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'hints.md'), '---\nname: hints\ntype: project\n---\n\nGoose hints content.')

    const plan = await syncer.planSync('goose')
    expect(plan.target).toBe('goose')
    expect(plan.toWrite).toHaveLength(1)
    expect(plan.toWrite[0]!.targetPath).toBe(join(root, '.goosehints'))
    expect(plan.toWrite[0]!.content).toContain('Goose hints content.')
  })

  // 22. planSync('goose') divergence after user edits .goosehints
  it("planSync('goose') detects divergence after user edits .goosehints", async () => {
    const memoryDir = join(paths.projectDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'hints.md'), '---\nname: hints\ntype: project\n---\n\nGoose hints.')

    const plan1 = await syncer.planSync('goose')
    await syncer.executeSync(plan1)

    await writeFile(join(root, '.goosehints'), 'User manually edited .goosehints.')

    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('goose')
    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(join(root, '.goosehints'))
    expect(plan2.toWrite).toHaveLength(0)
  })

  // 23. planSync('crush') no skills → empty plan
  it("planSync('crush') no skills → empty plan", async () => {
    const plan = await syncer.planSync('crush')

    expect(plan.target).toBe('crush')
    expect(plan.toWrite).toHaveLength(0)
    expect(plan.diverged).toHaveLength(0)
  })

  // 24. planSync('crush') with skills → toWrite has .crush/skills/<name>.md
  it("planSync('crush') skills → writes .crush/skills/ files", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'search.md'), '---\nname: search\n---\n\n## Task\nSearch the codebase')

    const plan = await syncer.planSync('crush')
    expect(plan.target).toBe('crush')
    expect(plan.toWrite).toHaveLength(1)
    expect(plan.toWrite[0]!.targetPath).toBe(join(root, '.crush', 'skills', 'search.md'))
  })

  // 25. planSync('crush') executeSync writes .crush/skills/<name>.md with correct content
  it("planSync('crush') executeSync writes skill file with correct content", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'review.md'), '---\nname: review\n---\n\n## Task\nReview the PR')

    const plan = await syncer.planSync('crush')
    await syncer.executeSync(plan)

    const written = await readFile(join(root, '.crush', 'skills', 'review.md'), 'utf-8')
    expect(written).toContain('description: review')
    expect(written).toContain('Review the PR')
  })

  // 26. planSync('crush') divergence after user edits skill file
  it("planSync('crush') detects divergence after user edits native file", async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun linter')

    const plan1 = await syncer.planSync('crush')
    await syncer.executeSync(plan1)

    const nativePath = join(root, '.crush', 'skills', 'lint.md')
    await writeFile(nativePath, 'User edited this Crush skill.')

    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('crush')
    expect(plan2.diverged).toHaveLength(1)
    expect(plan2.diverged[0]!.targetPath).toBe(nativePath)
    expect(plan2.toWrite).toHaveLength(0)
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

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  describe('error paths', () => {
    // -------------------------------------------------------------------------
    // Helpers shared across all error-path adapters
    // -------------------------------------------------------------------------

    /**
     * Returns true when the current process is running as root.
     * chmod 444 has no effect for root, so these tests are skipped as root.
     */
    function isRoot(): boolean {
      return process.getuid !== undefined && process.getuid() === 0
    }

    // -------------------------------------------------------------------------
    // Codex
    // -------------------------------------------------------------------------

    describe('codex', () => {
      // Error 1 — executeSync throws when the target directory is read-only
      it('executeSync throws when target directory is read-only', async () => {
        if (isRoot()) return // chmod is ineffective for root

        // Write a memory file so the plan produces one toWrite entry (AGENTS.md at project root).
        // Make the project root read-only so writeFile(AGENTS.md) fails.
        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'ctx.md'), '---\nname: ctx\ntype: project\n---\n\nCodex context.')

        const plan = await syncer.planSync('codex')
        expect(plan.toWrite).toHaveLength(1)

        // Make the project root read-only
        await chmod(root, 0o444)
        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()
        } finally {
          // Restore permissions so afterEach rm() can clean up
          await chmod(root, 0o755)
        }
      })

      // Error 2 — planSync with corrupted state.json does NOT crash with a raw JSON parse error
      it('planSync handles corrupted state.json gracefully without throwing', async () => {
        // Set up a skill so we get a non-trivial plan
        const skillsDir = join(paths.projectDir, 'skills')
        await mkdir(skillsDir, { recursive: true })
        await writeFile(join(skillsDir, 'search.md'), '---\nname: search\n---\n\n## Task\nSearch codebase')

        // First sync to populate state.json
        const plan1 = await syncer.planSync('codex')
        await syncer.executeSync(plan1)

        // Corrupt state.json with malformed JSON
        await mkdir(paths.projectDir, { recursive: true })
        await writeFile(paths.stateFile, '{corrupted-not-json: true,,}', 'utf-8')

        // planSync must NOT throw a raw JSON parse error
        const freshSyncer = await setupSyncer(root, paths)
        const plan2 = await expect(freshSyncer.planSync('codex')).resolves.toBeDefined()

        // Because state was unreadable, the syncer treats the state as empty (no stored hash).
        // The existing synced file therefore appears as a first-sync candidate (toWrite),
        // not a divergence — since there is no stored hash to compare against.
        // This is the defined graceful-fallback behaviour of readStateJson.
        void plan2
      })

      // Error 3 — partial write: first skill file written, second blocked by mode-000 target
      it('executeSync propagates error and leaves first file written, second file unmodified', async () => {
        if (isRoot()) return // chmod is ineffective for root

        // Skills are sorted alphabetically by filename: alpha < beta.
        // Plan order is therefore: alpha → beta.
        const skillsDir = join(paths.projectDir, 'skills')
        await mkdir(skillsDir, { recursive: true })
        await writeFile(join(skillsDir, 'alpha.md'), '---\nname: alpha\n---\n\n## Task\nAlpha task')
        await writeFile(join(skillsDir, 'beta.md'), '---\nname: beta\n---\n\n## Task\nBeta task')

        const plan = await syncer.planSync('codex')
        // Skills go to .codex/skills/<id>/SKILL.md; with 2 skills there are 2 entries
        const skillEntries = plan.toWrite.filter((e) => e.targetPath.includes('.codex'))
        expect(skillEntries.length).toBeGreaterThanOrEqual(2)

        const firstTargetPath = skillEntries[0]!.targetPath  // .codex/skills/alpha/SKILL.md
        const secondTargetPath = skillEntries[1]!.targetPath // .codex/skills/beta/SKILL.md

        // Pre-create the beta target dir + a mode-000 placeholder so writeFile(beta) fails
        await mkdir(join(root, '.codex', 'skills', 'beta'), { recursive: true })
        await writeFile(secondTargetPath, '')
        await chmod(secondTargetPath, 0o000)

        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()

          // First file (alpha) was written successfully
          const firstExists = await access(firstTargetPath).then(() => true, () => false)
          expect(firstExists).toBe(true)

          // Restore permissions so we can inspect the second file
          await chmod(secondTargetPath, 0o644)

          // Second file (beta) still exists — the write was blocked so the file retains
          // its pre-test placeholder content (empty string).
          const secondContent = await readFile(secondTargetPath, 'utf-8')
          expect(secondContent).toBe('')
        } finally {
          // Best-effort restore — may already be 0o644 from the try block above
          await chmod(secondTargetPath, 0o644).catch(() => {/* already restored */})
        }
      })
    })

    // -------------------------------------------------------------------------
    // Gemini
    // -------------------------------------------------------------------------

    describe('gemini', () => {
      // Error 1 — executeSync throws when the target directory is read-only
      it('executeSync throws when target directory is read-only', async () => {
        if (isRoot()) return

        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'guide.md'), '---\nname: guide\ntype: project\n---\n\nGemini guide.')

        const plan = await syncer.planSync('gemini')
        expect(plan.toWrite).toHaveLength(1)
        // GEMINI.md is written at projectRoot — make it read-only
        await chmod(root, 0o444)
        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()
        } finally {
          await chmod(root, 0o755)
        }
      })

      // Error 2 — planSync with corrupted state.json does NOT crash
      it('planSync handles corrupted state.json gracefully without throwing', async () => {
        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'guide.md'), '---\nname: guide\ntype: project\n---\n\nGemini guide.')

        // First sync to establish state
        const plan1 = await syncer.planSync('gemini')
        await syncer.executeSync(plan1)

        // Corrupt state.json
        await writeFile(paths.stateFile, '<<<not json at all>>>', 'utf-8')

        const freshSyncer = await setupSyncer(root, paths)
        // Must not throw; graceful fallback returns a valid plan object
        await expect(freshSyncer.planSync('gemini')).resolves.toBeDefined()
      })

      // Error 3 — executeSync fails when GEMINI.md target is not writable
      it('executeSync propagates error when GEMINI.md is not writable', async () => {
        if (isRoot()) return // chmod is ineffective for root

        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'guide.md'), '---\nname: guide\ntype: project\n---\n\nGemini guide.')

        const plan = await syncer.planSync('gemini')
        expect(plan.toWrite).toHaveLength(1)

        const targetPath = plan.toWrite[0]!.targetPath // GEMINI.md at project root

        // Pre-create a mode-000 placeholder at the target path so writeFile fails
        await writeFile(targetPath, 'original content')
        await chmod(targetPath, 0o000)

        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()

          // The file still contains original content — the write was blocked
          await chmod(targetPath, 0o644)
          const content = await readFile(targetPath, 'utf-8')
          expect(content).toBe('original content')
        } finally {
          await chmod(targetPath, 0o644).catch(() => {/* already restored above */})
        }
      })
    })

    // -------------------------------------------------------------------------
    // Goose
    // -------------------------------------------------------------------------

    describe('goose', () => {
      // Error 1 — executeSync throws when target directory is read-only
      it('executeSync throws when target directory is read-only', async () => {
        if (isRoot()) return

        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'hints.md'), '---\nname: hints\ntype: project\n---\n\nGoose hints.')

        const plan = await syncer.planSync('goose')
        expect(plan.toWrite).toHaveLength(1)
        // .goosehints is at projectRoot — make root read-only
        await chmod(root, 0o444)
        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()
        } finally {
          await chmod(root, 0o755)
        }
      })

      // Error 2 — planSync with corrupted state.json does NOT crash
      it('planSync handles corrupted state.json gracefully without throwing', async () => {
        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'hints.md'), '---\nname: hints\ntype: project\n---\n\nGoose hints.')

        // First sync to establish state
        const plan1 = await syncer.planSync('goose')
        await syncer.executeSync(plan1)

        // Corrupt state.json
        await writeFile(paths.stateFile, 'not-json-at-all', 'utf-8')

        const freshSyncer = await setupSyncer(root, paths)
        // Must not throw; state falls back to empty default
        const plan2 = await freshSyncer.planSync('goose')
        expect(plan2).toBeDefined()
        expect(plan2.target).toBe('goose')

        // With an unreadable state, the existing .goosehints file looks like a
        // first-sync candidate (no stored hash) so it lands in toWrite, not diverged.
        expect(plan2.diverged).toHaveLength(0)
        expect(plan2.toWrite).toHaveLength(1)
      })

      // Error 3 — executeSync fails when .goosehints target is not writable
      it('executeSync propagates error when .goosehints is not writable', async () => {
        if (isRoot()) return // chmod is ineffective for root

        const memoryDir = join(paths.projectDir, 'memory')
        await mkdir(memoryDir, { recursive: true })
        await writeFile(join(memoryDir, 'hints.md'), '---\nname: hints\ntype: project\n---\n\nGoose hints.')

        const plan = await syncer.planSync('goose')
        expect(plan.toWrite).toHaveLength(1)

        const targetPath = plan.toWrite[0]!.targetPath // .goosehints at project root

        // Pre-create a mode-000 placeholder so the write is blocked by EACCES
        await writeFile(targetPath, 'original goosehints')
        await chmod(targetPath, 0o000)

        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()

          // Restore and verify file was not overwritten
          await chmod(targetPath, 0o644)
          const content = await readFile(targetPath, 'utf-8')
          expect(content).toBe('original goosehints')
        } finally {
          await chmod(targetPath, 0o644).catch(() => {/* already restored above */})
        }
      })
    })

    // -------------------------------------------------------------------------
    // Crush
    // -------------------------------------------------------------------------

    describe('crush', () => {
      // Error 1 — executeSync throws when target directory is read-only
      it('executeSync throws when target directory is read-only', async () => {
        if (isRoot()) return

        const skillsDir = join(paths.projectDir, 'skills')
        await mkdir(skillsDir, { recursive: true })
        await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun linter')

        const plan = await syncer.planSync('crush')
        expect(plan.toWrite).toHaveLength(1)

        // .crush/skills/ does not yet exist — mkdir is called inside executeSync before writeFile.
        // Making the root read-only prevents mkdir from creating .crush/skills/.
        await chmod(root, 0o444)
        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()
        } finally {
          await chmod(root, 0o755)
        }
      })

      // Error 2 — planSync with corrupted state.json does NOT crash
      it('planSync handles corrupted state.json gracefully without throwing', async () => {
        const skillsDir = join(paths.projectDir, 'skills')
        await mkdir(skillsDir, { recursive: true })
        await writeFile(join(skillsDir, 'lint.md'), '---\nname: lint\n---\n\n## Task\nRun linter')

        // First sync to establish state
        const plan1 = await syncer.planSync('crush')
        await syncer.executeSync(plan1)

        // Corrupt state.json
        await writeFile(paths.stateFile, '{{invalid}}', 'utf-8')

        const freshSyncer = await setupSyncer(root, paths)
        // Must not throw
        const plan2 = await freshSyncer.planSync('crush')
        expect(plan2).toBeDefined()
        expect(plan2.target).toBe('crush')

        // With corrupted state, the syncer has no stored hash.  The existing
        // .crush/skills/lint.md looks like a first-sync candidate and lands in toWrite.
        expect(plan2.diverged).toHaveLength(0)
        expect(plan2.toWrite).toHaveLength(1)
      })

      // Error 3 — partial write: first skill written, second blocked by mode-000 target
      it('executeSync propagates error and leaves first file written, second file unmodified', async () => {
        if (isRoot()) return // chmod is ineffective for root

        // Skills sorted alphabetically: alpha.md < beta.md
        // Plan order: alpha (.crush/skills/alpha.md) → beta (.crush/skills/beta.md)
        const skillsDir = join(paths.projectDir, 'skills')
        await mkdir(skillsDir, { recursive: true })
        await writeFile(join(skillsDir, 'alpha.md'), '---\nname: alpha\n---\n\n## Task\nAlpha task')
        await writeFile(join(skillsDir, 'beta.md'), '---\nname: beta\n---\n\n## Task\nBeta task')

        const plan = await syncer.planSync('crush')
        expect(plan.toWrite.length).toBeGreaterThanOrEqual(2)

        const firstTargetPath = plan.toWrite[0]!.targetPath  // .crush/skills/alpha.md
        const secondTargetPath = plan.toWrite[1]!.targetPath // .crush/skills/beta.md

        // Pre-create the skills directory and a mode-000 placeholder for the second file
        // so the first write (alpha.md) succeeds but the second (beta.md) is blocked.
        await mkdir(join(root, '.crush', 'skills'), { recursive: true })
        await writeFile(secondTargetPath, 'original beta content')
        await chmod(secondTargetPath, 0o000)

        try {
          await expect(syncer.executeSync(plan)).rejects.toThrow()

          // First file was written successfully
          const firstExists = await access(firstTargetPath).then(() => true, () => false)
          expect(firstExists).toBe(true)

          // Second file exists but was not overwritten (still has placeholder content)
          await chmod(secondTargetPath, 0o644)
          const secondContent = await readFile(secondTargetPath, 'utf-8')
          expect(secondContent).toBe('original beta content')
        } finally {
          await chmod(secondTargetPath, 0o644).catch(() => {/* already restored above */})
        }
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Codex agents write-back (.codex/agents/<name>.md)
// ---------------------------------------------------------------------------

describe('Codex agents write-back', () => {
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

  it('writes agent file on first sync', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Persona\nYou review code carefully.',
    )

    const plan = await syncer.planSync('codex')
    const result = await syncer.executeSync(plan)

    const targetPath = join(root, '.codex', 'agents', 'reviewer.md')
    expect(result.written.some((w) => w.targetPath === targetPath)).toBe(true)

    const written = await readFile(targetPath, 'utf-8')
    expect(written).toContain('---')
    expect(written).toContain('description: Code reviewer')
    expect(written).toContain('You review code carefully.')

    // state.json hash recorded
    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { sync: Record<string, { lastSyncHash: string }> }
    expect(state.sync[targetPath]).toBeDefined()
    expect(state.sync[targetPath]!.lastSyncHash).toBe(sha256(written))
  })

  it('skips agent when content unchanged', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Persona\nReview code.',
    )

    // First sync
    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    // Second sync — native file untouched, hash still matches
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('codex')

    const targetPath = join(root, '.codex', 'agents', 'reviewer.md')
    // No divergence
    expect(plan2.diverged.find((d) => d.targetPath === targetPath)).toBeUndefined()

    // Content on disk is unchanged after a second executeSync
    const before = await readFile(targetPath, 'utf-8')
    await syncer.executeSync(plan2)
    const after = await readFile(targetPath, 'utf-8')
    expect(after).toBe(before)
  })

  it('deletes agent file when removed', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    const sourcePath = join(agentsDir, 'temp-agent.md')
    await writeFile(
      sourcePath,
      '---\nname: temp-agent\ndescription: Temporary agent\n---\n\n## Persona\nShort-lived.',
    )

    // First sync writes the native file
    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    const targetPath = join(root, '.codex', 'agents', 'temp-agent.md')
    // File exists
    await expect(readFile(targetPath, 'utf-8')).resolves.toBeTruthy()

    // Remove the source definition
    await rm(sourcePath)

    // Second sync detects the removal and deletes the native file
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('codex')
    expect(plan2.toDelete).toContain(targetPath)

    const result = await syncer.executeSync(plan2)
    expect(result.deleted).toContain(targetPath)

    // File is gone from disk
    await expect(readFile(targetPath, 'utf-8')).rejects.toThrow()

    // state.json no longer tracks the deleted path
    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as { sync: Record<string, unknown> }
    expect(state.sync[targetPath]).toBeUndefined()
  })

  it('does not write agents for gemini target', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Persona\nReview code.',
    )

    const plan = await syncer.planSync('gemini')

    // Gemini does not support agents write-back
    const agentEntries = plan.toWrite.filter((e) => e.targetPath.includes(`${'/'}.gemini${'/'}agents${'/'}`))
    expect(agentEntries).toHaveLength(0)

    // And no .gemini/agents/ entries of any shape
    expect(plan.toWrite.some((e) => e.targetPath.includes('.gemini/agents/'))).toBe(false)

    // Execute — confirm no .gemini/agents/ or .codex/agents/ files written by gemini target
    await syncer.executeSync(plan)
    await expect(readFile(join(root, '.gemini', 'agents', 'reviewer.md'), 'utf-8')).rejects.toThrow()
    await expect(readFile(join(root, '.codex', 'agents', 'reviewer.md'), 'utf-8')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AGENTS.md codex round-trip
// ---------------------------------------------------------------------------

const REALISTIC_AGENTS_MD = `# Project Overview

This project is a modular AI agent framework built with TypeScript and ESM.
All packages live under \`packages/\` in a Yarn workspace monorepo.

## Style Guide

- Use TypeScript strict mode; avoid \`any\`.
- File names: \`kebab-case\`. Variables/functions: \`camelCase\`. Types/classes: \`PascalCase\`.
- Keep modules focused; enforce package boundaries explicitly.
- Prefer \`async/await\` over raw Promise chains.

## Tool Instructions

Run quality checks before every PR:
\`\`\`
yarn build && yarn typecheck && yarn lint && yarn test
\`\`\`

For focused package checks use Turbo filters, e.g.:
\`\`\`
yarn test --filter=@dzupagent/agent-adapters
\`\`\`

## Commit Guidelines

Follow Conventional Commits: \`feat:\`, \`fix:\`, \`chore:\`, optionally scoped.
Keep messages imperative and specific (e.g., \`feat(core): add memory consolidation\`).
`

describe('AGENTS.md codex roundtrip', () => {
  let root: string
  let paths: DzupAgentPaths

  beforeEach(async () => {
    root = await makeTestDir()
    paths = makePaths(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('imports AGENTS.md → codex sync → re-import produces stable result', async () => {
    // -----------------------------------------------------------------------
    // Step 1: Write a realistic AGENTS.md in the project root
    // -----------------------------------------------------------------------
    await writeFile(join(root, 'AGENTS.md'), REALISTIC_AGENTS_MD, 'utf-8')

    // -----------------------------------------------------------------------
    // Step 2: First import — AGENTS.md → .dzupagent/memory/codex-project-context.md
    // -----------------------------------------------------------------------
    const importer1 = new DzupAgentImporter({ paths, projectRoot: root })
    const importPlan1 = await importer1.planImport()

    const codexEntry = importPlan1.toImport.find((e) => e.source.type === 'codex-agents-md')
    expect(codexEntry).toBeDefined()
    expect(codexEntry!.targetPath).toContain('codex-project-context.md')

    await importer1.executeImport(importPlan1)

    const memoryFile1 = await readFile(codexEntry!.targetPath, 'utf-8')
    // The memory file should contain the original AGENTS.md body
    expect(memoryFile1).toContain('Project Overview')
    expect(memoryFile1).toContain('Style Guide')
    expect(memoryFile1).toContain('Tool Instructions')
    expect(memoryFile1).toContain('Commit Guidelines')

    // -----------------------------------------------------------------------
    // Step 3: First codex planSync — memory → AGENTS.md toWrite entry
    // -----------------------------------------------------------------------
    const syncer1 = await setupSyncer(root, paths)
    const plan1 = await syncer1.planSync('codex')

    expect(plan1.target).toBe('codex')
    expect(plan1.toWrite).toHaveLength(1)
    expect(plan1.toWrite[0]!.targetPath).toBe(join(root, 'AGENTS.md'))

    const firstSyncContent = plan1.toWrite[0]!.content
    // The synced output must contain all key section headings from the original
    expect(firstSyncContent).toContain('Project Overview')
    expect(firstSyncContent).toContain('Style Guide')
    expect(firstSyncContent).toContain('Tool Instructions')
    expect(firstSyncContent).toContain('Commit Guidelines')

    // -----------------------------------------------------------------------
    // Step 4: executeSync — writes AGENTS.md (overwrites the original)
    // -----------------------------------------------------------------------
    await syncer1.executeSync(plan1)

    const writtenAgentsMd = await readFile(join(root, 'AGENTS.md'), 'utf-8')
    expect(writtenAgentsMd).toContain('Project Overview')

    // -----------------------------------------------------------------------
    // Step 5: Re-import — use a fresh .dzupagent dir so the importer doesn't
    // skip the already-existing codex-project-context.md from step 2.
    // Point root2 at a sibling dir to get a clean slate.
    // -----------------------------------------------------------------------
    const root2 = join(root, 'round2')
    await mkdir(root2, { recursive: true })
    // Copy the synced AGENTS.md into root2 so the importer can discover it
    await writeFile(join(root2, 'AGENTS.md'), writtenAgentsMd, 'utf-8')

    const paths2 = makePaths(root2)
    const importer2 = new DzupAgentImporter({ paths: paths2, projectRoot: root2 })
    const importPlan2 = await importer2.planImport()

    const codexEntry2 = importPlan2.toImport.find((e) => e.source.type === 'codex-agents-md')
    expect(codexEntry2).toBeDefined()
    await importer2.executeImport(importPlan2)

    // -----------------------------------------------------------------------
    // Step 6: Second codex planSync on the re-imported state
    // -----------------------------------------------------------------------
    const syncer2 = await setupSyncer(root2, paths2)
    const plan2 = await syncer2.planSync('codex')

    expect(plan2.target).toBe('codex')
    expect(plan2.toWrite).toHaveLength(1)

    const secondSyncContent = plan2.toWrite[0]!.content

    // Stability assertion: all key section content from the original AGENTS.md
    // survives the full import → sync → re-import → sync round-trip.
    expect(secondSyncContent).toContain('Project Overview')
    expect(secondSyncContent).toContain('Style Guide')
    expect(secondSyncContent).toContain('Tool Instructions')
    expect(secondSyncContent).toContain('Commit Guidelines')

    // The first sync content is entirely embedded within the second sync output
    // because the header gets prepended again, but all original content is preserved.
    expect(secondSyncContent).toContain(firstSyncContent.trim())
  })
})

// ---------------------------------------------------------------------------
// --dry-run behavior
// ---------------------------------------------------------------------------

describe('DzupAgentSyncer dry-run', () => {
  let root: string
  let paths: DzupAgentPaths
  let syncer: DzupAgentSyncer
  let logSpy: ReturnType<typeof vi.spyOn> | undefined
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(async () => {
    root = await makeTestDir()
    paths = makePaths(root)
    syncer = await setupSyncer(root, paths)
  })

  afterEach(async () => {
    logSpy?.mockRestore()
    warnSpy?.mockRestore()
    logSpy = undefined
    warnSpy = undefined
    await rm(root, { recursive: true, force: true })
  })

  // 1. dry-run does NOT write any files to disk (no state.json, no target files)
  it('dry-run does not write any files to disk', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // Silence logs
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const plan = await syncer.planSync('claude')
    const result = await syncer.executeSync(plan, { dryRun: true })

    // Result still reports what *would* be written
    expect(result.written.length).toBeGreaterThanOrEqual(1)

    // But no actual file exists on disk
    const targetPath = join(root, '.claude', 'commands', 'deploy.md')
    await expect(readFile(targetPath, 'utf-8')).rejects.toThrow()

    // And state.json was NOT created
    await expect(readFile(paths.stateFile, 'utf-8')).rejects.toThrow()
  })

  // 2. dry-run prints plan + diff output to stdout
  it('dry-run prints planned writes and diffs to stdout', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nOriginal deploy task')

    // First: real sync so target file + state.json exist
    const firstPlan = await syncer.planSync('claude')
    await syncer.executeSync(firstPlan)

    // Change source so the next sync has a real diff
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nUpdated deploy task')

    // Capture stdout
    const logged: string[] = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '))
    })

    syncer = await setupSyncer(root, paths)
    const plan = await syncer.planSync('claude')
    await syncer.executeSync(plan, { dryRun: true })

    const output = logged.join('\n')
    expect(output).toContain('[dry-run]')
    expect(output).toContain('Would write')
    // Unified diff must be emitted somewhere in the output
    expect(output).toMatch(/Diff for .+deploy\.md/)
    // The diff should contain the removed original line and added updated line
    expect(output).toContain('-Original deploy task')
    expect(output).toContain('+Updated deploy task')
  })

  // 3. force + dry-run: diverged file is shown but NOT overwritten
  it('force + dry-run shows diverged overwrite plan without writing', async () => {
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'deploy.md'), '---\nname: deploy\n---\n\n## Task\nRun deploy')

    // First real sync establishes state.json and the native file.
    const plan1 = await syncer.planSync('claude')
    await syncer.executeSync(plan1)

    // User edits native file (creates divergence)
    const nativePath = join(root, '.claude', 'commands', 'deploy.md')
    const userEdit = 'User edited this file manually — DO NOT OVERWRITE'
    await writeFile(nativePath, userEdit)

    // Capture both log and warn streams
    const logged: string[] = []
    const warned: string[] = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '))
    })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map((a) => String(a)).join(' '))
    })

    // force + dry-run: would overwrite the diverged file, but must not write
    syncer = await setupSyncer(root, paths)
    const plan2 = await syncer.planSync('claude')
    const result = await syncer.executeSync(plan2, { force: true, dryRun: true })

    // Plan reports the diverged entry as "written" (would-be)
    expect(result.written.length).toBeGreaterThanOrEqual(1)
    expect(result.written.some((w) => w.targetPath === nativePath)).toBe(true)

    // Output mentions dry-run overwrite + includes a diff
    const output = logged.join('\n')
    expect(output).toContain('[dry-run] Would overwrite diverged file')
    expect(output).toContain(nativePath)
    expect(output).toMatch(/Diff for .+deploy\.md/)

    // Critically: the user's edit is still on disk, untouched
    const afterSync = await readFile(nativePath, 'utf-8')
    expect(afterSync).toBe(userEdit)

    // And the loud "WARNING: Overwriting" message must NOT appear (that's non-dry-run)
    expect(warned.join('\n')).not.toContain('WARNING: Overwriting diverged file')
  })
})
