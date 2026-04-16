/**
 * End-to-end integration test for the Unified Capability Layer.
 *
 * Covers the full load-compile-inject pipeline and import/sync round-trip
 * using real file I/O against a temp directory.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { WorkspaceResolver } from '../dzupagent/workspace-resolver.js'
import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import { DzupAgentMemoryLoader } from '../dzupagent/memory-loader.js'
import { DzupAgentAgentLoader } from '../dzupagent/agent-loader.js'
import { DzupAgentImporter } from '../dzupagent/importer.js'
import { DzupAgentSyncer } from '../dzupagent/syncer.js'
import { SkillCapabilityMatrixBuilder } from '../skills/skill-capability-matrix.js'
import { createDefaultSkillRegistry } from '../skills/adapter-skill-registry.js'
import type { DzupAgentPaths } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTestDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `dzup-integ-${prefix}-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
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

// ---------------------------------------------------------------------------
// Scenario 1: Full loading pipeline
// ---------------------------------------------------------------------------

describe('UCL Integration: Full loading pipeline', () => {
  let root: string

  beforeEach(async () => {
    root = await makeTestDir('pipeline')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads skills, memory, agents, builds capability matrix, and compiles for provider', async () => {
    // --- Setup: create git root marker ---
    await mkdir(join(root, '.git'), { recursive: true })

    // --- Setup: .dzupagent/skills/test-skill.md ---
    const skillsDir = join(root, '.dzupagent', 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(
      join(skillsDir, 'test-skill.md'),
      `---
name: test-skill
description: A test skill for integration testing
version: 1
owner: integration-tests
constraints:
  maxBudgetUsd: 0.5
  approvalMode: auto
tools:
  required: [read_file]
---

## Persona
You are a meticulous test engineer.

## Task
Review code changes and verify correctness.
`,
    )

    // --- Setup: .dzupagent/agents/test-agent.md ---
    const agentsDir = join(root, '.dzupagent', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'test-agent.md'),
      `---
name: test-agent
description: Integration test agent
version: 1
preferredProvider: claude
skills: [test-skill]
memoryScope: project
---

## Persona
You are an integration test agent that delegates to test-skill.
`,
    )

    // --- Setup: .dzupagent/memory/context.md ---
    const memoryDir = join(root, '.dzupagent', 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, 'context.md'),
      `---
name: project-context
description: Project context for integration testing
type: project
tags: [testing, integration]
---

This is the project context used in integration tests.
It contains information about the test setup.
`,
    )

    // --- Assertion 1: WorkspaceResolver ---
    const resolver = new WorkspaceResolver()
    const resolvedPaths = await resolver.resolve(root)

    expect(resolvedPaths.projectDir).toBe(join(root, '.dzupagent'))
    expect(resolvedPaths.stateFile).toBe(join(root, '.dzupagent', 'state.json'))
    // git root === project root, so workspaceDir should be undefined
    expect(resolvedPaths.workspaceDir).toBeUndefined()

    // --- Assertion 2: DzupAgentFileLoader loads the skill bundle ---
    const fileLoader = new DzupAgentFileLoader({ paths: resolvedPaths })
    const bundles = await fileLoader.loadSkills()

    expect(bundles).toHaveLength(1)
    expect(bundles[0]!.bundleId).toBe('test-skill')
    expect(bundles[0]!.skillSetId).toBe('test-skill')
    expect(bundles[0]!.constraints.maxBudgetUsd).toBe(0.5)
    expect(bundles[0]!.toolBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'read_file', mode: 'required' }),
      ]),
    )
    expect(bundles[0]!.promptSections.length).toBeGreaterThanOrEqual(2)

    // --- Assertion 3: DzupAgentMemoryLoader loads the memory entry ---
    const memoryLoader = new DzupAgentMemoryLoader({
      paths: resolvedPaths,
      providerId: 'claude',
    })
    const memoryEntries = await memoryLoader.loadEntries()

    expect(memoryEntries.length).toBeGreaterThanOrEqual(1)
    const contextEntry = memoryEntries.find((e) => e.name === 'project-context')
    expect(contextEntry).toBeDefined()
    expect(contextEntry!.type).toBe('project')
    expect(contextEntry!.tags).toEqual(['testing', 'integration'])
    expect(contextEntry!.content).toContain('integration tests')

    // --- Assertion 4: DzupAgentAgentLoader loads the agent definition ---
    const registry = createDefaultSkillRegistry()
    const agentLoader = new DzupAgentAgentLoader({
      paths: resolvedPaths,
      skillLoader: fileLoader,
      skillRegistry: registry,
    })
    const agents = await agentLoader.loadAgents()

    expect(agents).toHaveLength(1)
    expect(agents[0]!.name).toBe('test-agent')
    expect(agents[0]!.preferredProvider).toBe('claude')
    expect(agents[0]!.skillNames).toEqual(['test-skill'])
    expect(agents[0]!.memoryScope).toBe('project')
    expect(agents[0]!.personaPrompt).toContain('integration test agent')

    // --- Assertion 5: SkillCapabilityMatrixBuilder produces matrix ---
    const matrixBuilder = new SkillCapabilityMatrixBuilder(registry)
    const matrices = matrixBuilder.buildForAll(bundles)

    expect(matrices).toHaveLength(1)
    const matrix = matrices[0]!
    expect(matrix.skillId).toBe('test-skill')

    // claude should have full support
    const claudeRow = matrix.providers['claude']
    expect(claudeRow).toBeDefined()
    expect(claudeRow!.systemPrompt).toBe('active')
    expect(claudeRow!.toolBindings).toBe('active')
    expect(claudeRow!.budgetLimit).toBe('active')

    // codex should exist (from default registry) with dropped budgetLimit
    const codexRow = matrix.providers['codex']
    expect(codexRow).toBeDefined()
    expect(codexRow!.systemPrompt).toBe('active')
    expect(codexRow!.budgetLimit).toBe('dropped')

    // --- Assertion 6: Agent compiled for 'claude' contains skill content ---
    const compiledPrompt = await agentLoader.compileForProvider(agents[0]!, 'claude')

    expect(compiledPrompt).toContain('integration test agent')
    expect(compiledPrompt).toContain('meticulous test engineer')
    expect(compiledPrompt).toContain('Review code changes')
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: Import/sync round-trip
// ---------------------------------------------------------------------------

describe('UCL Integration: Import/sync round-trip', () => {
  let root: string
  let paths: DzupAgentPaths

  beforeEach(async () => {
    root = await makeTestDir('roundtrip')
    paths = makePaths(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('imports native files and syncs them back to provider format', async () => {
    // --- Setup: CLAUDE.md ---
    await writeFile(join(root, 'CLAUDE.md'), '# My Project\n\nSome context.')

    // --- Setup: .claude/commands/my-skill.md ---
    const commandsDir = join(root, '.claude', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(
      join(commandsDir, 'my-skill.md'),
      `---
description: My custom skill
---

## Persona
You are a helpful assistant.

## Task
Do the thing the user asks for.
`,
    )

    const importer = new DzupAgentImporter({ paths, projectRoot: root })

    // --- Assertion 7: planImport() detects both files ---
    const importPlan = await importer.planImport()

    expect(importPlan.toImport.length).toBeGreaterThanOrEqual(2)
    const sourceTypes = importPlan.toImport.map((e) => e.source.type)
    expect(sourceTypes).toContain('claude-md')
    expect(sourceTypes).toContain('claude-commands')

    // --- Assertion 8: executeImport() writes memory file with correct frontmatter ---
    const importResults = await importer.executeImport(importPlan)
    const writtenResults = importResults.filter((r) => r.written)
    expect(writtenResults.length).toBeGreaterThanOrEqual(2)

    const memoryTarget = join(paths.projectDir, 'memory', 'claude-project-context.md')
    const memoryContent = await readFile(memoryTarget, 'utf-8')
    expect(memoryContent).toContain('name: claude-project-context')
    expect(memoryContent).toContain('type: project')
    expect(memoryContent).toContain('importedFrom: CLAUDE.md')
    expect(memoryContent).toContain('Some context.')

    // --- Assertion 9: executeImport() writes skill file with importedFrom ---
    const skillTarget = join(paths.projectDir, 'skills', 'my-skill.md')
    const skillContent = await readFile(skillTarget, 'utf-8')
    expect(skillContent).toContain('importedFrom: .claude/commands/my-skill.md')
    expect(skillContent).toContain('Do the thing')

    // --- Assertion 10: DzupAgentFileLoader after import can load the imported skill ---
    const fileLoader = new DzupAgentFileLoader({ paths })
    const bundles = await fileLoader.loadSkills()

    expect(bundles.length).toBeGreaterThanOrEqual(1)
    const mySkill = bundles.find((b) => b.bundleId === 'my-skill')
    expect(mySkill).toBeDefined()
    expect(mySkill!.promptSections.length).toBeGreaterThanOrEqual(1)

    // --- Setup syncer ---
    const registry = createDefaultSkillRegistry()
    const agentLoader = new DzupAgentAgentLoader({
      paths,
      skillLoader: fileLoader,
      skillRegistry: registry,
    })
    const syncer = new DzupAgentSyncer({
      paths,
      projectRoot: root,
      fileLoader,
      agentLoader,
    })

    // --- Assertion 11: planSync('claude') produces toWrite entry ---
    const syncPlan = await syncer.planSync('claude')

    expect(syncPlan.toWrite.length).toBeGreaterThanOrEqual(1)
    const skillSyncEntry = syncPlan.toWrite.find((e) =>
      e.targetPath.includes('my-skill.md'),
    )
    expect(skillSyncEntry).toBeDefined()
    expect(skillSyncEntry!.targetPath).toContain(join('.claude', 'commands', 'my-skill.md'))

    // --- Assertion 12: executeSync() writes .claude/commands/my-skill.md ---
    const syncResult = await syncer.executeSync(syncPlan)

    expect(syncResult.written.length).toBeGreaterThanOrEqual(1)
    const syncedSkillPath = join(root, '.claude', 'commands', 'my-skill.md')
    const syncedContent = await readFile(syncedSkillPath, 'utf-8')
    expect(syncedContent).toContain('description:')

    // --- Assertion 13: state.json contains both 'files' and 'sync' keys ---
    const stateRaw = await readFile(paths.stateFile, 'utf-8')
    const state = JSON.parse(stateRaw) as Record<string, unknown>

    expect(state).toHaveProperty('files')
    expect(state).toHaveProperty('sync')
    expect(typeof state['files']).toBe('object')
    expect(typeof state['sync']).toBe('object')

    // files should contain import hashes
    const files = state['files'] as Record<string, unknown>
    const fileKeys = Object.keys(files)
    expect(fileKeys.length).toBeGreaterThanOrEqual(1)

    // sync should contain sync hashes
    const sync = state['sync'] as Record<string, unknown>
    const syncKeys = Object.keys(sync)
    expect(syncKeys.length).toBeGreaterThanOrEqual(1)
  })
})
