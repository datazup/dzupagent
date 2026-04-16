import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DzupAgentAgentLoader, agentDefinitionsToSupervisorConfig } from '../dzupagent/agent-loader.js'
import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import { AdapterSkillRegistry } from '../skills/adapter-skill-registry.js'
import { ClaudeSkillCompiler } from '../skills/compilers/claude-skill-compiler.js'
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
  const dir = join(tmpdir(), `dzup-agent-test-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const AGENT_CONTENT = `---
name: code-reviewer-agent
description: An agent that reviews code
version: 2
preferredProvider: claude
skills: [code-reviewer, security-checker]
memoryScope: workspace
constraints:
  maxBudgetUsd: 1.0
  approvalMode: required
importedFrom: shared-agents
---

## Persona
You are a meticulous code reviewer who focuses on correctness, security, and maintainability.

## Notes
Some additional notes here.
`

const AGENT_MINIMAL = `---
name: simple-agent
description: A simple agent
---

## Persona
You are a helpful assistant.
`

const SKILL_CONTENT = `---
name: code-reviewer
description: Review code for quality
version: 1
owner: test-team
---

## Task
Review the diff for correctness and style.
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

describe('DzupAgentAgentLoader', () => {
  let testDir: string
  let paths: DzupAgentPaths
  let skillLoader: DzupAgentFileLoader
  let skillRegistry: AdapterSkillRegistry
  let loader: DzupAgentAgentLoader

  beforeEach(async () => {
    testDir = await makeTestDir()
    paths = makePaths(testDir)
    skillLoader = new DzupAgentFileLoader({ paths })
    skillRegistry = new AdapterSkillRegistry()
    skillRegistry.register(new ClaudeSkillCompiler())
    loader = new DzupAgentAgentLoader({ paths, skillLoader, skillRegistry })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('parses frontmatter into AgentDefinition fields', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'code-reviewer-agent.md'), AGENT_CONTENT)

    const agents = await loader.loadAgents()
    expect(agents).toHaveLength(1)

    const agent = agents[0]!
    expect(agent.name).toBe('code-reviewer-agent')
    expect(agent.description).toBe('An agent that reviews code')
    expect(agent.version).toBe(2)
    expect(agent.preferredProvider).toBe('claude')
    expect(agent.skillNames).toEqual(['code-reviewer', 'security-checker'])
    expect(agent.memoryScope).toBe('workspace')
    expect(agent.constraints.maxBudgetUsd).toBe(1.0)
    expect(agent.constraints.approvalMode).toBe('required')
    expect(agent.importedFrom).toBe('shared-agents')
  })

  it('extracts ## Persona section into personaPrompt', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'code-reviewer-agent.md'), AGENT_CONTENT)

    const agents = await loader.loadAgents()
    const agent = agents[0]!
    expect(agent.personaPrompt).toContain('meticulous code reviewer')
    expect(agent.personaPrompt).not.toContain('## Persona')
    // Should not include content from other sections
    expect(agent.personaPrompt).not.toContain('additional notes')
  })

  it('compileForProvider() resolves skills and includes skill content', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    const skillsDir = join(paths.projectDir, 'skills')
    await mkdir(agentsDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(agentsDir, 'code-reviewer-agent.md'), AGENT_CONTENT)
    await writeFile(join(skillsDir, 'code-reviewer.md'), SKILL_CONTENT)
    await writeFile(join(skillsDir, 'security-checker.md'), SKILL_CONTENT_2)

    const agents = await loader.loadAgents()
    const agent = agents[0]!
    const compiled = await loader.compileForProvider(agent, 'claude')

    // Should contain persona prompt
    expect(compiled).toContain('meticulous code reviewer')
    // Should contain compiled skill content
    expect(compiled).toContain('Review the diff for correctness')
    expect(compiled).toContain('OWASP top 10')
  })

  it('project agent overrides global agent with same name', async () => {
    const globalAgentsDir = join(paths.globalDir, 'agents')
    const projectAgentsDir = join(paths.projectDir, 'agents')
    await mkdir(globalAgentsDir, { recursive: true })
    await mkdir(projectAgentsDir, { recursive: true })

    const globalAgent = AGENT_MINIMAL.replace('description: A simple agent', 'description: Global agent')
    const projectAgent = AGENT_MINIMAL.replace('description: A simple agent', 'description: Project agent')

    await writeFile(join(globalAgentsDir, 'simple-agent.md'), globalAgent)
    await writeFile(join(projectAgentsDir, 'simple-agent.md'), projectAgent)

    const agents = await loader.loadAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0]!.description).toBe('Project agent')
  })

  it('loadAgent() returns undefined for nonexistent name', async () => {
    const result = await loader.loadAgent('nonexistent')
    expect(result).toBeUndefined()
  })

  it('compileForProvider() skips missing skills without throwing', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'code-reviewer-agent.md'), AGENT_CONTENT)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const agents = await loader.loadAgents()
    const agent = agents[0]!
    // No skills directory at all -- both skills will be missing
    const compiled = await loader.compileForProvider(agent, 'claude')

    // Should still contain the persona prompt
    expect(compiled).toContain('meticulous code reviewer')
    // Should have warned about missing skills
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skill not found: code-reviewer'),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skill not found: security-checker'),
    )

    warnSpy.mockRestore()
  })

  it('agentDefinitionsToSupervisorConfig() produces valid routing config', () => {
    const agents = [
      {
        name: 'agent-a',
        description: 'Agent A',
        version: 1,
        preferredProvider: 'claude' as const,
        skillNames: ['skill-1'],
        memoryScope: 'project' as const,
        constraints: {},
        personaPrompt: 'You are A.',
        filePath: '/tmp/agent-a.md',
      },
      {
        name: 'agent-b',
        description: 'Agent B',
        version: 1,
        preferredProvider: undefined,
        skillNames: ['skill-2'],
        memoryScope: 'global' as const,
        constraints: {},
        personaPrompt: 'You are B.',
        filePath: '/tmp/agent-b.md',
      },
    ]

    const config = agentDefinitionsToSupervisorConfig(agents, { 'agent-b': 'codex' })

    // agent-a has preferredProvider from definition, agent-b gets it from override
    const prefs = config['routingPreferences'] as Array<{ agentName: string; preferredProvider: string }>
    expect(prefs).toHaveLength(2)
    expect(prefs.find((p) => p.agentName === 'agent-a')?.preferredProvider).toBe('claude')
    expect(prefs.find((p) => p.agentName === 'agent-b')?.preferredProvider).toBe('codex')
    expect(config['agentCount']).toBe(2)

    const providers = config['providersUsed'] as string[]
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
  })

  it('loadAgents() returns empty array when agents directory does not exist', async () => {
    const agents = await loader.loadAgents()
    expect(agents).toHaveLength(0)
  })

  it('uses default values for optional frontmatter fields', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'simple-agent.md'), AGENT_MINIMAL)

    const agents = await loader.loadAgents()
    const agent = agents[0]!

    expect(agent.version).toBe(1)
    expect(agent.preferredProvider).toBeUndefined()
    expect(agent.skillNames).toEqual([])
    expect(agent.memoryScope).toBe('project')
    expect(agent.constraints).toEqual({})
    expect(agent.importedFrom).toBeUndefined()
  })

  it('caches results by mtime -- no re-parse on second call', async () => {
    const agentsDir = join(paths.projectDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'simple-agent.md'), AGENT_MINIMAL)

    const first = await loader.loadAgents()
    const second = await loader.loadAgents()

    // Same object identity proves cache hit
    expect(first[0]).toBe(second[0])
  })

  it('workspace agent overrides global agent with same name', async () => {
    const workspaceDir = join(testDir, 'workspace')
    paths = { ...paths, workspaceDir }
    skillLoader = new DzupAgentFileLoader({ paths })
    loader = new DzupAgentAgentLoader({ paths, skillLoader, skillRegistry })

    const globalAgentsDir = join(paths.globalDir, 'agents')
    const wsAgentsDir = join(workspaceDir, 'agents')
    await mkdir(globalAgentsDir, { recursive: true })
    await mkdir(wsAgentsDir, { recursive: true })

    const globalAgent = AGENT_MINIMAL.replace('description: A simple agent', 'description: Global agent')
    const wsAgent = AGENT_MINIMAL.replace('description: A simple agent', 'description: Workspace agent')

    await writeFile(join(globalAgentsDir, 'simple-agent.md'), globalAgent)
    await writeFile(join(wsAgentsDir, 'simple-agent.md'), wsAgent)

    const agents = await loader.loadAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0]!.description).toBe('Workspace agent')
  })
})
