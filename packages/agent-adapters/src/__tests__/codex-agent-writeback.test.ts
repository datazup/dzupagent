/**
 * Task C — Codex agents write-back (.codex/agents/).
 *
 * 1. PROVIDER_SYNC_CAPABILITIES.codex.agents is true.
 * 2. planSync('codex') includes agent entries in .codex/agents/<name>.md.
 * 3. executeSync writes .codex/agents/<name>.md with Claude-format Markdown.
 * 4. Divergence detection works for codex agent files.
 */
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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

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
  const dir = join(tmpdir(), `dzup-codex-agents-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function setupSyncer(root: string, paths: DzupAgentPaths): Promise<DzupAgentSyncer> {
  const fileLoader = new DzupAgentFileLoader({ paths })
  const registry: AdapterSkillRegistry = createDefaultSkillRegistry()
  const agentLoader = new DzupAgentAgentLoader({
    paths,
    skillLoader: fileLoader,
    skillRegistry: registry,
  })
  return new DzupAgentSyncer({ paths, projectRoot: root, fileLoader, agentLoader })
}

describe('Codex agents write-back', () => {
  let root: string
  let paths: DzupAgentPaths
  let syncer: DzupAgentSyncer

  beforeEach(async () => {
    root = await makeTestDir()
    paths = makePaths(root)
    syncer = await setupSyncer(root, paths)

    // Seed an agent definition in .dzupagent/agents/
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Code reviewer\n---\n\nYou review code carefully.',
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('planSync("codex") includes agent entries targeting .codex/agents/<name>.md', async () => {
    const plan = await syncer.planSync('codex')
    expect(plan.target).toBe('codex')
    const targetPaths = plan.toWrite.map((e) => e.targetPath)
    expect(targetPaths).toContain(join(root, '.codex', 'agents', 'reviewer.md'))
  })

  it('executeSync writes .codex/agents/<name>.md with Claude-compatible Markdown frontmatter', async () => {
    const plan = await syncer.planSync('codex')
    await syncer.executeSync(plan)
    const written = await readFile(join(root, '.codex', 'agents', 'reviewer.md'), 'utf-8')
    expect(written).toContain('---')
    expect(written).toContain('description:')
    expect(written).toContain('reviewer')
  })

  it('second executeSync for unchanged agent does not diverge', async () => {
    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    const plan2 = await syncer.planSync('codex')
    const agentEntry = plan2.toWrite.find((e) => e.targetPath.includes('.codex/agents'))
    expect(agentEntry).toBeDefined()
    expect(plan2.diverged.find((e) => e.targetPath.includes('.codex/agents'))).toBeUndefined()
  })

  it('detects divergence when the agent file was edited by the user', async () => {
    // First sync
    const plan1 = await syncer.planSync('codex')
    await syncer.executeSync(plan1)

    // User edits the native file
    const agentPath = join(root, '.codex', 'agents', 'reviewer.md')
    await writeFile(agentPath, '# Custom reviewer\nUser edited this.')

    // Second plan should detect divergence
    const plan2 = await syncer.planSync('codex')
    const diverged = plan2.diverged.find((e) => e.targetPath.includes('.codex/agents'))
    expect(diverged).toBeDefined()
  })
})
